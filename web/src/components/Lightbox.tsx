import { useEffect, useRef, useState } from 'react';
import { useView } from '../store/view';
import { useMarks } from '../store/marks';
import { originalUrl, thumbUrl } from '../lib/thumbSource';
import { clampPan, zoomAt, FIT, type Pan } from '../lib/lightboxZoom';
import type { Asset } from '../types';

interface Props {
  order: string[];
  byId: Map<string, Asset>;
}

export function Lightbox({ order, byId }: Props) {
  const id = useView((s) => s.lightbox);
  const closeLightbox = useView((s) => s.closeLightbox);
  const openLightbox = useView((s) => s.openLightbox);
  const mark = useMarks((s) => (id ? s.marks[id] : undefined));

  const [zoom, setZoom] = useState<{ scale: number; pan: Pan }>({ scale: FIT, pan: { x: 0, y: 0 } });
  const { scale, pan } = zoom;
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const index = id ? order.indexOf(id) : -1;
  const asset = id ? byId.get(id) : undefined;

  // 换图时归位
  useEffect(() => { setZoom({ scale: FIT, pan: { x: 0, y: 0 } }); }, [id]);

  // 预取前后各 3 张的 preview，翻页不等待
  useEffect(() => {
    if (index < 0) return;
    for (let d = -3; d <= 3; d++) {
      const neighbor = order[index + d];
      if (neighbor && neighbor !== id) new Image().src = thumbUrl(neighbor, 'preview');
    }
  }, [index, id, order]);

  useEffect(() => {
    if (!id) return;
    function onKey(e: KeyboardEvent) {
      // 焦点落在按钮上时让开。空格和回车是**按钮的标准激活方式**，浏览器靠它们
      // 合成 click；在 capture 阶段无条件吞掉，关闭按钮就变成一个只能用鼠标点的
      // 东西——而它有 :focus-visible 样式，本意就是键盘可达的。
      // 只让开这两个键：方向键在按钮上按也应该继续翻页，那是这一屏的主操作。
      const onButton = e.target instanceof Element && e.target.closest('button') !== null;
      if (onButton && (e.key === ' ' || e.key === 'Enter')) return;

      // capture + stopPropagation：这三个键 useKeyboard 的 window 冒泡监听器也在监听
      // （尤其是左右箭头，它们在 useKeyboard 里驱动网格的 move()）。同一个 keydown 事件
      // 会先经过这里（capture 阶段），再冒泡回 useKeyboard 的监听器；仅 preventDefault
      // 不会阻断传播，两边都会跑一遍，导致翻页一次跳两张、且 cursor 跑到 lightbox 显示的
      // 下一张之外。stopPropagation 让事件在这里终止，两边不会重复响应同一次按键。
      if (e.key === ' ') {
        e.preventDefault(); e.stopPropagation();
        setZoom((z) => ({ scale: z.scale === FIT ? 2 : FIT, pan: { x: 0, y: 0 } }));
      } else if (e.key === 'ArrowRight' && order[index + 1]) {
        e.preventDefault(); e.stopPropagation();
        openLightbox(order[index + 1]);
      } else if (e.key === 'ArrowLeft' && order[index - 1]) {
        e.preventDefault(); e.stopPropagation();
        openLightbox(order[index - 1]);
      }
    }
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [id, index, order, openLightbox]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.002);   // 指数：每一格滚动的手感一致
      setZoom((z) => zoomAt(z, factor,
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
        { w: rect.width, h: rect.height }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [id]);

  if (!id || !asset) return null;

  // 放大到 1 以上才换原图。预览图在贴合状态下已经够用，而原图是整张 RAW 的
  // 全尺寸 JPG——每翻一张就拉一次的话，翻页会从"瞬间"变成"等一下"。
  const src = scale > FIT ? originalUrl(id) : thumbUrl(id, 'preview');

  return (
    <div className="lightbox" onClick={(e) => { if (e.target === e.currentTarget) closeLightbox(); }}>
      {/* 右上角关闭。半透明深色圆底 + 白 ✕，默认 opacity .5，hover/focus 才升到 1——
          深色半透明在亮图和暗图上都读得出来，也不会像纯白或纯色块那样在画面上
          砸一个洞。这是需求原话「按钮颜色最好不要影响图片查看」的落点。 */}
      <button type="button" className="lb-close" aria-label="关闭"
              onClick={closeLightbox}>✕</button>
      <div ref={stageRef}
           className={scale > FIT ? 'lb-stage lb-zoom' : 'lb-stage'}
           onPointerDown={(e) => {
             if (scale <= FIT) return;
             dragRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
             (e.target as Element).setPointerCapture?.(e.pointerId);
           }}
           onPointerMove={(e) => {
             const start = dragRef.current;
             if (scale <= FIT || !start) return;
             const rect = stageRef.current?.getBoundingClientRect();
             if (!rect) return;
             setZoom((z) => ({
               scale: z.scale,
               pan: clampPan({ x: e.clientX - start.x, y: e.clientY - start.y },
                 z.scale, { w: rect.width, h: rect.height }),
             }));
           }}
           onPointerUp={() => { dragRef.current = null; }}
           onPointerCancel={() => { dragRef.current = null; }}
           onDoubleClick={() => setZoom((z) => ({
             scale: z.scale === FIT ? 2 : FIT, pan: { x: 0, y: 0 },
           }))}>
        <img src={src} alt={asset.stem} decoding="async" draggable={false}
             style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }} />
      </div>

      <div className="lb-bar">
        <span>{asset.id}</span>
        <span className="muted">{index + 1} / {order.length}</span>
        {mark === 'pick' && <span className="badge badge-pick">收藏</span>}
        {mark === 'reject' && <span className="badge badge-reject">排除</span>}
        {asset.raws.length === 0 && <span className="badge badge-warn">无 RAW</span>}
        <span className="muted">
          {scale > FIT
            ? `${scale.toFixed(1)}× — 拖拽平移，双击回到贴合`
            : '滚轮缩放 · 双击放大 · ←→ 翻页 · P 收藏 · X 排除 · Esc 退出'}
        </span>
      </div>
    </div>
  );
}
