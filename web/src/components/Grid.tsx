import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useLibrary } from '../store/library';
import { useSession } from '../store/session';
import { useView } from '../store/view';
import type { Group } from '../lib/bursts';
import { buildRows, rowKey } from '../lib/rows';
import { StackCell } from './StackCell';
import { Thumb } from './Thumb';
import { postJSON } from '../lib/api';
import { reprioritizeThumbs } from '../lib/thumbSource';
import { armClickSwallow, collectIdsInRect, farEnough, normRect } from '../lib/marquee';

const ROW_GAP = 12;
const OVERSCAN_ROWS = 2;

export function Grid({ groups, order = [] }: { groups: Group[]; order?: string[] }) {
  const assets = useLibrary((s) => s.assets);
  const cellWidth = useLibrary((s) => s.settings.cellWidth);
  const expanded = useView((s) => s.expanded);
  const cursor = useView((s) => s.cursor);

  const scrollRef = useRef<HTMLDivElement>(null);
  // 容器宽度和列数分开：ResizeObserver 只管宽度，列数由宽度和格子大小算。
  // 合成一个的话这个 effect 就得依赖 cellW，而滚轮缩放会逐帧改 cellW ——
  // 于是每一帧都 disconnect + new ResizeObserver + observe，
  // 而新 observer 在 observe 的那一刻必定补发一次初始回调。
  const [width, setWidth] = useState(0);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; active: boolean } | null>(null);
  const setSelection = useView((s) => s.setSelection);

  const cellW = cellWidth;
  const cellH = Math.round(cellW * 0.75) + 26;   // 4:3 图 + 文件名行

  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  // 列数随容器宽度变化。依赖数组是空的：这个 observer 挂一次用到卸载。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // width === 0 是「ResizeObserver 还没回调过」，不是「容器真的是 0 宽」。
  // 按 0 算会得出 1 列，首帧就是一条竖着的单列，随即再跳成正确的列数。
  // 沿用改造前那个 6 的初值：猜错的代价只是首帧列数不准，而猜 1 必然错。
  const cols = useMemo(
    () => (width === 0 ? 6 : Math.max(1, Math.floor((width - ROW_GAP) / (cellW + ROW_GAP)))),
    [width, cellW],
  );

  // 供键盘上下方向键换算「一行几个」
  useEffect(() => { document.body.dataset.cols = String(cols); }, [cols]);

  const setCellWidth = useLibrary((s) => s.setCellWidth);

  // ⌘/Ctrl + 滚轮缩放网格。
  //
  // 这个组合键**浏览器自己也在用**（页面缩放），所以必须 passive: false +
  // preventDefault()——否则用户想缩网格，缩掉的是整个页面，而网格纹丝不动。
  // React 的 onWheel 挂上去是 passive 的，preventDefault 会被忽略，所以这里
  // 只能用原生 addEventListener。
  //
  // `Grid` 被访客界面原封不动复用（GuestApp.tsx），而 `PUT /api/library/settings`
  // 是 requireAdmin——访客的浏览器上从来不会有 admin 会话。落盘与否因此按
  // 当前是不是管理员决定：管理员滚轮缩放落盘、对所有人生效；访客滚轮只改
  // 自己这一屏的本地状态，不发任何请求，规格反对的是"访客改变所有人看到的
  // 东西"，本地缩放对访客本人是有用且无害的。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      // deltaY 向上为负 = 放大。步长跟着滚动量走，触控板上才不会一格一格地跳。
      setCellWidth(
        useLibrary.getState().settings.cellWidth - e.deltaY * 0.5,
        useSession.getState().kind === 'admin',
      );
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setCellWidth]);

  const rows = useMemo(() => buildRows(groups, cols, expanded), [groups, cols, expanded]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i].kind === 'expanded'
      ? Math.round(cellH * 0.8) + ROW_GAP + 16
      : cellH + ROW_GAP),
    // 行高不等 + measureElement 的实测缓存，键必须跟着内容走而不是行号，
    // 否则展开/筛选让行重排之后，旧行号的缓存高度会被套到新内容上（见 rows.ts）。
    getItemKey: (index) => rowKey(rows[index]),
    overscan: OVERSCAN_ROWS,
  });

  const items = virtualizer.getVirtualItems();

  useEffect(() => {
    if (!cursor) return;
    const index = rows.findIndex((row) => row.kind === 'expanded'
      ? row.group.ids.includes(cursor) : row.groups.some((group) => group.ids.includes(cursor)));
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' });
  }, [cursor, rows, virtualizer]);

  // 把可视区的 id 报给服务端，让烘焙队列先烤这些；同时立刻按距视口中心的
  // 距离重排前端队列里还在排队的请求（不发请求，只调整出队顺序——见
  // thumbSource.ts 的 reprioritizeThumbs）。网络上报仍然防抖 250ms，
  // 前端重排是纯内存操作，不需要等这个防抖。
  useEffect(() => {
    if (items.length === 0) return;
    const rowOf = new Map<string, number>();
    const ids: string[] = [];
    for (const item of items) {
      const row = rows[item.index];
      if (row.kind === 'expanded') {
        for (const id of row.group.ids) { rowOf.set(id, item.index); ids.push(id); }
      } else {
        for (const g of row.groups) { rowOf.set(g.ids[0], item.index); ids.push(g.ids[0]); }
      }
    }

    const center = (items[0].index + items[items.length - 1].index) / 2;
    reprioritizeThumbs((id) => {
      const row = rowOf.get(id);
      return row === undefined ? 9999 : Math.abs(row - center);
    });

    const timer = setTimeout(() => {
      void postJSON('/api/library/prioritize', { ids }).catch(() => {});
    }, 250);   // 滚动停下 250ms 才上报，避免刷屏
    return () => clearTimeout(timer);
    // rows 必须在依赖数组里：阈值编辑 / 展开收起 / 筛选或目录切换都会改变 rows
    // 内容（同一行现在对应不同的组），却可能不改变可见的首尾行号——只看首尾行号
    // 会漏报。rows 是 useMemo 的产物，内容不变时引用也不变，所以加进来不会让
    // 这个 effect 在纯滚动时逐帧触发；两个行号依赖仍然保留，用来在 rows 引用
    // 不变、纯滚动导致首尾行号变化时也能触发上报。下面的 setTimeout/clearTimeout
    // 防抖不受影响：额外触发只是重置计时器，250ms 内没有新触发才会真正发请求。
  }, [rows, items.length && items[0].index, items.length && items[items.length - 1].index]);

  // 优先级 = 距可视区中心的行距。滚动停下时，眼睛看的那行最先出图。
  const centerRow = items.length ? (items[0].index + items[items.length - 1].index) / 2 : 0;

  if (groups.length === 0) {
    return <div className="grid-empty">这个视图下没有照片</div>;
  }

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as Element;
    if (t.closest('button, input, a, textarea, select')) return;
    dragRef.current = { x: e.clientX, y: e.clientY, active: false };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const start = dragRef.current;
    if (!start) return;
    if (!start.active) {
      if (!farEnough(start.x, start.y, e.clientX, e.clientY)) return;
      start.active = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    const rect = normRect(start.x, start.y, e.clientX, e.clientY);
    setMarquee(rect);
    const root = scrollRef.current;
    if (root) setSelection(collectIdsInRect(root, rect));
  };

  const endMarquee = () => {
    const start = dragRef.current;
    dragRef.current = null;
    if (start?.active) {
      armClickSwallow();
      setMarquee(null);
    }
  };

  return (
    <div
      className="grid-scroll"
      ref={scrollRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endMarquee}
      onPointerCancel={endMarquee}
    >
      <div className="grid-inner" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const row = rows[item.index];
          const priority = Math.abs(item.index - centerRow);
          return (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className={row.kind === 'expanded' ? 'grid-row grid-row-expanded' : 'grid-row'}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row.kind === 'grid'
                ? row.groups.map((g) => (
                    <div key={g.key} className="grid-cell" style={{ width: cellW }}>
                      <StackCell group={g} byId={byId} priority={priority} visible order={order} />
                    </div>
                  ))
                : (
                  <>
                    <span className="expanded-label">连拍 {row.group.ids.length} 张</span>
                    <div className="expanded-strip">
                      {row.group.ids.map((id) => {
                        const asset = byId.get(id);
                        return asset
                          ? <Thumb key={id} asset={asset} priority={priority} visible compact order={order} />
                          : null;
                      })}
                    </div>
                  </>
                )}
            </div>
          );
        })}
      </div>
      {marquee && (
        <div
          className="marquee"
          style={{
            left: marquee.x,
            top: marquee.y,
            width: marquee.w,
            height: marquee.h,
          }}
        />
      )}
    </div>
  );
}
