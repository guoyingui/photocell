import { useEffect, useMemo, useState } from 'react';
import { useLibrary } from './store/library';
import { useMarks } from './store/marks';
import { useView } from './store/view';
import { assetsInDir, filterGroups, filterGroupsByClient, toBurstItems } from './lib/derive';
import { groupBursts } from './lib/bursts';
import { flatOrder } from './lib/order';
import { useKeyboard } from './lib/useKeyboard';
import { setSession } from './store/session';
import { useFolders } from './store/folders';
import { useFolderActions } from './lib/useFolderActions';
import { FolderPicker } from './components/FolderPicker';
import { Grid } from './components/Grid';
import { PresenceBar } from './components/PresenceBar';
import { TopBar } from './components/TopBar';
import { LibrarySidebar } from './components/LibrarySidebar';
import { ThemeToggle } from './components/ThemeToggle';
import { GuestsOnlineConfirm } from './components/GuestsOnlineConfirm';
import { SharePanel } from './components/SharePanel';
import { Notice } from './components/Notice';
import { Toast } from './components/Toast';
import { Lightbox } from './components/Lightbox';
import { ExportPanel } from './components/ExportPanel';
import { CompareView } from './components/CompareView';
import { useResumePosition } from './lib/useResumePosition';
import { useVisiblePhotos } from './lib/useVisiblePhotos';
import { usePhotoFilterGroups } from './lib/usePhotoFilters';
import { useReviewProgress } from './lib/useReviewProgress';
import { PhotoTools } from './components/PhotoTools';
import { PhotoInfo } from './components/PhotoInfo';
import { OpinionTools } from './components/OpinionTools';
import { AnnotationTools } from './components/AnnotationTools';
import { usePhotoAnnotations } from './lib/useAnnotations';
import { useSortedGroups } from './lib/useSortedGroups';
import { FilterWorkspace } from './components/FilterWorkspace';

export function App() {
  const phase = useLibrary((s) => s.phase);
  const root = useLibrary((s) => s.root);
  const assets = useLibrary((s) => s.assets);
  const metas = useLibrary((s) => s.metas);
  const skippedFiles = useLibrary((s) => s.skippedFiles);
  const scanFound = useLibrary((s) => s.scanFound);
  const marksRecovered = useLibrary((s) => s.marksRecovered);
  const error = useLibrary((s) => s.error);
  const errorDetail = useLibrary((s) => s.errorDetail);
  const closeBlocked = useLibrary((s) => s.closeBlocked);
  const folders = useFolders((s) => s.roots);
  const directory = useFolderActions();
  const [folderDialog, setFolderDialog] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);

  const marks = useMarks((s) => s.marks);
  const hidden = useMarks((s) => s.hidden);
  const { tab, dirFilter, clientFilter, threshold, expanded, setResolveVisible } = useView();
  const contrib = useMarks((s) => s.contrib);
  const [exportOpen, setExportOpen] = useState(false);
  useEffect(() => { setExportOpen(false); }, [root]);
  // 提示条按文件夹记"已读"：换文件夹后新的提示必须重新显示一次。
  const [noticeReadFor, setNoticeReadFor] = useState<string | null>(null);

  // 分组只依赖 (assets, metas, threshold, dirFilter)，刻意不依赖 marks。
  // 以前把 marks 也算进来，每按一次 P/X 就要对整库重跑 filterAssets ×5 +
  // toBurstItems + groupBursts（含一次全量排序）+ flatOrder + Grid 的 rows。
  // assetsInDir 的签名里没有 marks —— 这一段拿不到 marks，不是靠约定，是靠类型。
  const groups = useMemo(
    () => groupBursts(toBurstItems(assetsInDir(assets, dirFilter), metas), threshold),
    [assets, dirFilter, metas, threshold],
  );

  // 标记只影响"这一组里哪几张还看得见"，是分组之后的一层薄过滤。隐藏同理，
  // 且对所有人生效（Task 16）——不是只有摄影师看不见。
  // 筛了人之后判据整个换掉：看的是**那个人自己那一票**，而不是这张照片此刻的
  // 有效标记。两者经常不一样——一张被妈妈改过的照片，有效标记是妈妈的，
  // 但「新娘收藏过的」里它仍然该出现。
  const markedGroups = useMemo(
    () => (clientFilter === null
      ? filterGroups(groups, marks, tab, hidden)
      : filterGroupsByClient(groups, contrib, clientFilter, tab, hidden)),
    [groups, marks, tab, hidden, clientFilter, contrib],
  );

  const visibleGroups = useSortedGroups(usePhotoFilterGroups(markedGroups));
  useReviewProgress(phase === 'ready');
  usePhotoAnnotations(phase === 'ready');
  const order = useMemo(() => flatOrder(visibleGroups, expanded), [visibleGroups, expanded]);
  const photoOrder = useMemo(() => visibleGroups.flatMap((group) => group.ids), [visibleGroups]);
  useVisiblePhotos(photoOrder, phase === 'ready');
  useKeyboard(order, photoOrder);
  useResumePosition(root, phase === 'ready', assets, groups);

  // 这个组件就是 `/` 那条入口的界面，而 `/` 在服务端是 requireAdmin 的：
  // 只有回环请求拿得到它的数据。所以「本地界面被渲染出来」本身就等于
  // 「这个前端是摄影师自己」，在这里把 session 声明成 admin。
  //
  // 必须有人声明：useKeyboard 的写门禁读的是 session.canWrite()，而它是
  // 默认拒绝的（初始 kind 是 'none'，canWrite() 返回 false）。少了这一句，
  // 单机流程连 P/X 都按不动——门禁做成默认拒绝的代价就是每一条合法路径
  // 都得自己报到，这里是本地路径的报到点。
  useEffect(() => { setSession({ kind: 'admin' }); }, []);

  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  // 把"给定 id + expanded 集合，算出应该显示成哪个 id"的判断注入 view store。
  // view.ts 自己不认识 Group，没法在 toggleExpand/collapseAll 内部判断某个
  // 收起的组该把光标挪去哪；只有这里（拥有 groups）才能提供这段逻辑，
  // 注入之后 view.ts 的 toggleExpand/collapseAll 对任何调用方都生效——
  // 不管是这里的键盘 Escape，还是 StackCell 卡牌堆上直接调用 toggleExpand
  // 的收起按钮，光标都不会被晾在一个刚刚被折叠、藏起来的非出头成员上。
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

  const noticeRead = noticeReadFor === root;

  return (
    <div className="app directory-app">
      <LibrarySidebar onAdd={() => setFolderDialog(true)} onOpen={directory.open} onRemove={directory.remove} busyPath={directory.busyPath} />
      <main className="library-main">
        {phase === 'ready' ? <>
          <TopBar onExport={() => setExportOpen(true)} order={photoOrder} />

          {/* 在线成员条（规格 §7.5）。名单来自 SSE 的 presence 事件，一个人都没有
              时它自己渲染成 null——不开分享的单机流程界面因此完全不变。
              分享出去之后，"现在有没有人在看、谁是只读的"是摄影师最想知道的两件事。 */}
          <PresenceBar />
          <FilterWorkspace />
          <PhotoTools groups={visibleGroups} order={photoOrder} />
          <OpinionTools order={photoOrder} />
          <AnnotationTools order={photoOrder} />

          <Notice
            marksRecovered={marksRecovered && !noticeRead}
            skippedFiles={noticeRead ? 0 : skippedFiles}
            onDismiss={() => setNoticeReadFor(root)}
          />

          <div className="body">
            <Grid groups={visibleGroups} order={order} />
            <PhotoInfo id={useView.getState().cursor} />
          </div>
          <Lightbox order={order} byId={byId} />
          <CompareView order={photoOrder} byId={byId} />
          <ExportPanel open={exportOpen} onClose={() => setExportOpen(false)} visibleIds={photoOrder} />
        </> : <>
          <header className="library-empty-header"><span>照片选片工作区</span><ThemeToggle /></header>
          {phase === 'scanning' && <ScanProgress found={scanFound} />}
          <div className="library-empty">
            <h1>选择照片文件夹</h1>
            <p className="muted">在左侧添加多个照片目录，点击目录开始选片。</p>
            {phase === 'scanning' || directory.busyPath ? <p role="status">正在打开目录，请稍候…</p>
              : <button className="primary" onClick={() => setFolderDialog(true)}>添加照片目录…</button>}
          </div>
        </>}
        {error && <div className="library-error picker-error" role="alert"><strong>{error}</strong>
          {errorDetail && <code>{errorDetail}</code>}
          <div className="filter-actions">
            {directory.failedRoot && <button disabled={directory.busyPath !== null} onClick={() => directory.open(directory.failedRoot!)}>重试打开目录</button>}
            <button onClick={() => useLibrary.setState({ error: null, errorDetail: null })}>关闭提示</button>
          </div>
        </div>}
      </main>
      {folderDialog && <FolderPicker existing={folders} onClose={() => setFolderDialog(false)} onAdd={(roots) => {
        useFolders.getState().add(roots);
        if (useLibrary.getState().phase === 'idle' && roots[0]) directory.open(roots[0]);
      }} />}
      {closeBlocked && <GuestsOnlineConfirm message={closeBlocked.message} busy={directory.busyPath !== null}
        onCancel={directory.cancel} onForce={directory.force} onRevoke={() => { directory.cancel(); setRevokeOpen(true); }} />}
      {revokeOpen && <SharePanel open onClose={() => setRevokeOpen(false)} />}
      <Toast />
    </div>
  );
}

/**
 * 扫描进度（规格 §3.2、计划 Task 12/20）。
 *
 * 开库不再等扫描之后，读卡器上那几十秒里必须有东西在动——一句静止的
 * "正在扫描…"跟卡死无法区分，而摄影师这时唯一能做的判断就是"要不要拔卡"。
 *
 * **`found` 是文件数，不是照片张数。** 一对 RAW+JPG 是两个文件、一个资产
 * （server/lib/scan.js 的 onBatch 契约）。写成"已扫描 N 张"的话，一场 3000 张的
 * 婚礼会显示成 6000——一个看着完全正常、却谁也不会去核对的错数字。
 *
 * 没有总数（要走完一遍才知道有多少个文件），所以进度条是不定长的：
 * 它表达的是"还在动"，不是"还剩多少"。假装知道百分比比不显示更糟。
 */
function ScanProgress({ found }: { found: number }) {
  return (
    <div className="scan-progress" role="status" aria-live="polite">
      <span className="scan-progress-track" aria-hidden="true">
        <span className="scan-progress-fill" />
      </span>
      <span className="scan-progress-text">正在扫描文件夹…已扫描 {found} 个文件</span>
    </div>
  );
}
