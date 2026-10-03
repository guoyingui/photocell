import { useEffect, useMemo, useState } from 'react';
import { getJSON, openStream } from '../lib/api';
import type { ApiError } from '../lib/api';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { useSession } from '../store/session';
import { useView } from '../store/view';
import { assetsInDir, countByTab, filterGroups, toBurstItems } from '../lib/derive';
import { groupBursts } from '../lib/bursts';
import { flatOrder } from '../lib/order';
import { useKeyboard } from '../lib/useKeyboard';
import { useVisiblePhotos } from '../lib/useVisiblePhotos';
import { usePhotoFilterGroups, usePhotoFilterAssets } from '../lib/usePhotoFilters';
import { useReviewProgress } from '../lib/useReviewProgress';
import { PhotoTools } from '../components/PhotoTools';
import { AnnotationTools } from '../components/AnnotationTools';
import { usePhotoAnnotations } from '../lib/useAnnotations';
import { PhotoInfo } from '../components/PhotoInfo';
import { SelectionBar } from '../components/SelectionBar';
import {
  blockerPropsFor, createReconnectRefetch, handleRealtimeEvent, resetRealtime, useRealtime,
} from '../lib/realtime';
import { Blocker } from '../components/Blocker';
import { Grid } from '../components/Grid';
import { MarkBar } from '../components/MarkBar';
import { CompareButton } from '../components/CompareButton';
import { CompareView } from '../components/CompareView';
import { HistoryButtons } from '../components/HistoryButtons';
import { ThemeToggle } from '../components/ThemeToggle';
import { Lightbox } from '../components/Lightbox';
import { Notice } from '../components/Notice';
import { PresenceBar } from '../components/PresenceBar';
import { Sidebar } from '../components/Sidebar';
import { Toast } from '../components/Toast';
import type { Asset, AssetMeta, FilterTab, Mark, Settings } from '../types';

const TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pick', label: '收藏' },
  { key: 'reject', label: '排除' },
  { key: 'none', label: '未标记' },
];

/** `GET /api/library/assets`。warnings / skippedFiles 只含相对路径，给访客是安全的。 */
interface AssetsResult {
  assets: Asset[];
  warnings: string[];
  skippedFiles: number;
}

/**
 * `GET /api/library/marks`。marksMeta 是平行的归属表（Task 20 的角标数据源）——
 * "这张是谁选的"在多人一起看的时候恰恰是访客最需要的一条信息，所以这一侧
 * 也必须取。hidden 同样必须取：隐藏对所有人生效（Task 16），不是只有摄影师
 * 看不见——访客这一侧漏了它，就是客户还在看着一张摄影师以为已经藏起来的照片。
 * 旧文件夹没有这两个字段，marks store 按空表/空集处理。
 */
interface MarksResult {
  marks: Record<string, Mark>;
  settings: Settings;
  marksMeta?: unknown;
  hidden?: unknown;
  finalMarks?: unknown;
  finalRevision?: number;
  ownContrib?: unknown;
}

type Phase = { kind: 'loading' } | { kind: 'ready' } | { kind: 'failed'; message: string };

function messageOf(err: unknown): string {
  const m = (err as ApiError | undefined)?.message;
  return typeof m === 'string' && m.length > 0 ? m : '出错了，请稍后再试';
}

/**
 * 访客选片界面 = 本地界面**减去三块**（规格 §7.2）：
 *
 *   - 文件夹选择器：访客不选文件夹，`/api/fs/*` 和 `/api/library/open` 都只对
 *     本机开放；连摄影师磁盘上的绝对路径都不该让他知道（join 响应刻意不返回 root）。
 *   - 导出面板：`/api/export*` 硬编码仅管理员，不是可配置开关。
 *   - 库级设置（连拍阈值滑杆）：它改变的是**所有人**看到的分组，
 *     `PUT /api/library/settings` 因此定为仅管理员。
 *
 * `Grid` / `StackCell` / `Thumb` / `Lightbox` / `Sidebar` 原封不动复用——
 * 它们只读 store，不认识身份，也不该认识。
 *
 * 只读（viewer）的写入门禁由标记入口和快捷键共同检查，操作按钮按权限显示。
 * 这里同时提示「你现在是只读」，免得按了 P 没反应的人以为界面卡了。
 */
export function GuestApp({ marksRecovered = false }: { marksRecovered?: boolean }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [noticeRead, setNoticeRead] = useState(false);

  // 逐字段订阅，理由同 TopBar/Sidebar：整体解构会让顶栏跟着光标、选区、
  // 展开收起这些高频字段一起重渲染。
  const assets = useLibrary((s) => s.assets);
  const metas = useLibrary((s) => s.metas);
  const skippedFiles = useLibrary((s) => s.skippedFiles);
  const streamError = useLibrary((s) => s.streamError);

  const marks = useMarks((s) => s.marks);
  // 隐藏对所有人生效（Task 16）：访客这一侧也要把隐藏的照片从分组和计数里剔除，
  // 不能只在本地界面做。
  const hidden = useMarks((s) => s.hidden);

  const tab = useView((s) => s.tab);
  const setTab = useView((s) => s.setTab);
  const dirFilter = useView((s) => s.dirFilter);
  const threshold = useView((s) => s.threshold);
  const expanded = useView((s) => s.expanded);
  const cursor = useView((s) => s.cursor);
  const setResolveVisible = useView((s) => s.setResolveVisible);

  const share = useSession((s) => s.share);
  const user = useSession((s) => s.user);
  // 订阅而不是 getState()：管理员可以在运行期改权限（SSE 的 role 事件），
  // 提示条必须跟着变。
  const canWrite = useSession((s) => s.canWrite());

  // 被踢 / 分享结束。订阅它必须在所有 early return 之前（hook 规则），
  // 渲染它则必须在所有 early return 之中排第一——阻断压过一切别的界面状态。
  const blocked = useRealtime((s) => s.blocked);

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | null = null;
    // 上一次挂载（比如测试里、或者用户在同一个标签页里换了条链接）留下的
    // 阻断状态不该跟着新的这一次进来。
    resetRealtime();
    const onOpen = createReconnectRefetch();

    (async () => {
      try {
        // 访客没有 open()：JoinGate 的 join/resume 已经把会话 id 给了 api.ts，
        // 这里直接按会话拉数据。warnings / skippedFiles 只能从 /assets 拿——
        // 开库不再阻塞扫描之后，开库/join 响应发出的那一刻它们必然还是空的。
        const lib = await getJSON<AssetsResult>('/api/library/assets');
        if (cancelled) return;
        const loaded = await getJSON<MarksResult>('/api/library/marks');
        if (cancelled) return;

        // 顺序照抄 library.open()：标记和阈值必须在网格拿到 assets **之前**
        // 就位，否则整屏会先用「全部未标记」渲染一帧，别人已经选过的片
        // 看起来像是被谁清空了。
        useMarks.getState().load(loaded.marks, loaded.marksMeta, loaded.hidden, undefined, loaded.finalMarks, loaded.finalRevision, loaded.ownContrib);
        useView.getState().setThreshold(loaded.settings.burstThresholdMs);
        useLibrary.setState({
          assets: lib.assets,
          warnings: lib.warnings ?? [],
          skippedFiles: lib.skippedFiles ?? 0,
          settings: loaded.settings,
          metas: new Map(),
          phase: 'ready',
          error: null,
        });
        setPhase({ kind: 'ready' });

        stop = openStream('/api/library/stream', (event) => {
          if (cancelled) return;
          // 协同事件（marks / presence / role / kicked / share-ended）统一交给
          // realtime.ts：合并规则必须和本地界面共用一份实现。
          if (handleRealtimeEvent(event)) {
            // kicked / share-ended 之后服务端会真的断开这条连接，但 EventSource
            // 会锲而不舍地自动重连——每次重连都再撞一次 401，而且每次连上还会
            // 触发一次补拉。要真的做到"阻断之后不再发出任何请求"，只能主动关掉。
            if (useRealtime.getState().blocked) { stop?.(); stop = null; }
            return;
          }
          if (event.type === 'settings') {
            useLibrary.setState({ settings: event.settings });
            if (useView.getState().threshold !== event.settings.burstThresholdMs) {
              useView.getState().setThreshold(event.settings.burstThresholdMs);
            }
          } else if (event.type === 'rescan') {
            // 摄影师原地重扫了这个文件夹。换掉的是**所有人**正在看的那一份，
            // 不重拉的话访客手里一直是刷新前那份列表：点开一张已经从磁盘上
            // 消失的照片只会看到「无法预览」，而他完全不知道为什么。
            //
            // 服务端不通过 SSE 推整份资产表（三千条一帧推出去会把缓冲撑爆），
            // 所以这一帧只是个信号，表本身要自己再拉一次。
            //
            // 扫描失败时不拉：服务端保留了旧的资产表，再拉一次拿到的还是同一份，
            // 白跑一趟往返。这一帧带的 error 是脱敏过的一句话，但访客界面没有
            // 展示位——摄影师那一侧已经看到了，让客户也弹一句他处理不了的错误
            // 只会造成困惑。
            if (typeof event.error !== 'string') {
              void getJSON<AssetsResult>('/api/library/assets').then((lib) => {
                if (cancelled) return;
                // 悬空指针必须和 assets 落进 store 的**同一个同步段**里清掉，
                // 晚一帧子组件就会先用旧 cursor 渲染一次——而那张照片可能已经
                // 不在了。大图正开着的话 pruneMissing 会把它关掉。
                useView.getState().pruneMissing(new Set(lib.assets.map((a) => a.id)));
                useLibrary.setState({
                  assets: lib.assets,
                  warnings: lib.warnings ?? [],
                  skippedFiles: lib.skippedFiles ?? 0,
                  streamError: null,
                });
              }).catch(() => { /* 下一次重连时的全量补拉会兜住 */ });
            }
          } else if (event.type === 'meta') {
            // 复制一份 Map 才能触发 zustand 的订阅者更新
            const next = new Map(useLibrary.getState().metas);
            for (const m of event.metas as AssetMeta[]) next.set(m.id, m);
            useLibrary.setState({ metas: next, streamError: null });
          } else if (event.type === 'metaDone') {
            useLibrary.setState({ metaDone: true, streamError: null });
          } else if (event.type === 'error') {
            useLibrary.setState({ streamError: '与服务器的实时连接中断，可能看不到别人刚做的改动' });
          }
          // 'bake' 和 'scan' 是摄影师那一侧的进度，访客界面没有它们的展示位；
          // 忽略而不是塞进一个看不见的字段。
        }, onOpen);
      } catch (err) {
        // 拉不到照片就整页阻断。给一张空网格是最坏的结果：看起来像「这个
        // 文件夹是空的」，而不是「你没拿到数据」。
        if (!cancelled) setPhase({ kind: 'failed', message: messageOf(err) });
      }
    })();

    return () => { cancelled = true; stop?.(); };
  }, []);

  // 以下四段与 App.tsx 逐字相同，理由也相同：分组只依赖
  // (assets, metas, threshold, dirFilter)，刻意不依赖 marks——assetsInDir 的
  // 签名里没有 marks，这一段拿不到它，不是靠约定，是靠类型。
  const groups = useMemo(
    () => groupBursts(toBurstItems(assetsInDir(assets, dirFilter), metas), threshold),
    [assets, dirFilter, metas, threshold],
  );
  const markedGroups = useMemo(
    () => filterGroups(groups, marks, tab, hidden), [groups, marks, tab, hidden]);
  const visibleGroups = usePhotoFilterGroups(markedGroups);
  useReviewProgress(phase.kind === 'ready' && !blocked);
  usePhotoAnnotations(phase.kind === 'ready' && !blocked);
  const order = useMemo(() => flatOrder(visibleGroups, expanded), [visibleGroups, expanded]);
  const photoOrder = useMemo(() => visibleGroups.flatMap((group) => group.ids), [visibleGroups]);
  useVisiblePhotos(photoOrder, phase.kind === 'ready');
  useKeyboard(order, photoOrder);

  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  const filteredAssets = usePhotoFilterAssets();
  const inDir = useMemo(() => assetsInDir(filteredAssets, dirFilter), [filteredAssets, dirFilter]);
  const counts = useMemo(() => countByTab(inDir, marks, hidden), [inDir, marks, hidden]);

  // 把「给定 id + expanded 集合，算出应该显示成哪个 id」的判断注入 view store，
  // 让折叠连拍组时光标不会被晾在一个已经藏起来的成员上。见 App.tsx 的长注释。
  useEffect(() => {
    setResolveVisible((id, exp) => {
      const group = visibleGroups.find((g) => g.ids.includes(id));
      if (!group || group.ids.length === 1) return id;
      return exp.has(group.key) ? id : group.ids[0];
    });
    const view = useView.getState();
    const focused = visibleGroups.find((group) => group.ids.includes(view.cursor ?? ''));
    if (focused && focused.ids[0] !== view.cursor && !view.expanded.has(focused.key)) view.toggleExpand(focused.key);
  }, [visibleGroups, setResolveVisible]);

  // 阻断排在最前面：被踢 / 分享结束之后，这一屏不该再有任何别的出口，
  // 也不该再挂着一棵能响应键盘、能发请求的选片树。
  if (blocked) return <Blocker {...blockerPropsFor(blocked)} />;

  if (phase.kind === 'failed') {
    return <Blocker title="无法载入照片" message={phase.message}
                    detail="请刷新页面重试，或向摄影师确认这场选片还开着。" />;
  }

  if (phase.kind === 'loading') {
    return <div className="guest-loading">正在载入照片…</div>;
  }

  return (
    <div className="app">
      <header className="topbar">
        <strong className="guest-label">{share?.label ?? '选片'}</strong>

        <nav className="tabs">
          {TABS.map((t, i) => (
            <button key={t.key} className={tab === t.key ? 'tab tab-on' : 'tab'}
                    onClick={() => setTab(t.key)} title={`快捷键 ${i + 1}`}>
              {t.label} <b>{counts[t.key]}</b>
            </button>
          ))}
        </nav>

        <CompareButton order={photoOrder} />
        <HistoryButtons />
        <button onClick={() => useView.getState().toggleInfo()}>照片信息（I）</button>
        <MarkBar />

        <span className="muted">
          {metas.size < assets.length ? `读取元数据 ${metas.size}/${assets.length}` : ''}
        </span>

        {streamError && <span className="error">{streamError}</span>}

        {/* 在线成员条（规格 §7.5）。放在顶栏里而不是单起一行：访客这一屏的
            纵向空间全都该留给照片，而"还有谁在一起看"是一条余光信息。 */}
        <PresenceBar />

        <div className="topbar-actions">
          <ThemeToggle />
          {!canWrite && (
            <span className="guest-readonly" role="status"
                  title="按 P / X / U 不会有反应；需要改权限请找摄影师">
              只读 · 可以浏览，不能修改标记
            </span>
          )}
          <span className="guest-me">{user?.nickname}</span>
        </div>
      </header>
      <PhotoTools groups={visibleGroups} order={photoOrder} />
      <AnnotationTools order={photoOrder} />
      <SelectionBar ready={phase.kind === 'ready' && !blocked} />

      {/* 「从备份恢复」对访客同样重要：他正要照着一份可能过时的标记做选择。
          skippedFiles 来自 /assets，marksRecovered 只有 join 响应里有，
          由 JoinGate 透传下来。 */}
      <Notice
        marksRecovered={marksRecovered && !noticeRead}
        skippedFiles={noticeRead ? 0 : skippedFiles}
        onDismiss={() => setNoticeRead(true)}
      />

      <div className="body">
        <Sidebar />
        <Grid groups={visibleGroups} order={order} />
        <PhotoInfo id={cursor} />
      </div>
      <Lightbox order={order} byId={byId} />
      <CompareView order={photoOrder} byId={byId} />
      <Toast />
    </div>
  );
}
