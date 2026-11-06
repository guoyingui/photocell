import { useEffect, useMemo, useRef, useState } from 'react';
import { getJSON, getSessionId } from '../lib/api';
import { thumbUrl } from '../lib/thumbSource';
import { useDialogFocus } from '../lib/useDialogFocus';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { useReview } from '../store/review';
import { useSession } from '../store/session';
import { useSimilar } from '../store/similar';
import { useView } from '../store/view';
import type { Mark } from '../types';
import { MarkIcon } from './MarkIcon';

interface SimilarGroup {
  key: string;
  assetIds: string[];
  /** 每张照片与组内锚点（第一张）的汉明距离，0–64。 */
  distances: Record<string, number>;
  maxDistance: number;
}

interface SimilarResult {
  threshold: number;
  dir: string | null;
  total: number;
  analyzed: number;
  skipped: number;
  noPreview: number;
  flat: number;
  capped: boolean;
  durationMs: number;
  groups: SimilarGroup[];
}

const THRESHOLDS = [
  { value: 4, label: '很相似（差异 ≤ 4）' },
  { value: 8, label: '相似（差异 ≤ 8）' },
  { value: 12, label: '略有差异（差异 ≤ 12）' },
];

const scanId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function markLabel(mark: Mark | undefined) {
  return mark === 'pick' ? '已收藏' : mark === 'reject' ? '已排除' : '未标记';
}

/**
 * 相似照片面板。
 *
 * 服务端按缩略图的 dHash 分组，这里只负责让摄影师在组内挑一张保留、把其余
 * 标为排除。默认保留图不是凭空选的第一张：组里已经有人收藏过就保留那张，
 * 否则用锚点（组内最早拍的）——这既符合「先按时间看」的直觉，也让同一个
 * 分组在重复打开时给出同一个默认值。
 *
 * 批量标记走 setMarkMany，整组算**一步**撤销、一次 PUT。分成「收藏保留图」
 * 和「排除其余」两次请求，会在只有一个成功时留下半组结果，⌘Z 也要按两下。
 */
export function SimilarPanel({ onClose }: { onClose: () => void }) {
  const ref = useDialogFocus(onClose);
  const root = useLibrary((s) => s.root);
  const assets = useLibrary((s) => s.assets);
  const byId = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const marks = useMarks((s) => s.marks);
  const pending = useMarks((s) => s.pendingCount);
  const canWrite = useSession((s) => s.canWrite());
  const dirFilter = useView((s) => s.dirFilter);
  const progress = useSimilar((s) => s.progress);

  const [threshold, setThreshold] = useState(8);
  const [scope, setScope] = useState<'all' | 'dir'>(dirFilter === null ? 'all' : 'dir');
  const [result, setResult] = useState<SimilarResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [keepers, setKeepers] = useState<Record<string, string>>({});
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [onlyUnresolved, setOnlyUnresolved] = useState(false);

  const alive = useRef(true);
  const initialRoot = useRef(root);
  const initialDir = useRef(dirFilter);
  const currentScan = useRef('');
  const sid = useRef(getSessionId());
  const valid = () => alive.current && sid.current === getSessionId();

  const run = async (nextThreshold = threshold, nextScope = scope) => {
    if (!valid() || loading) return;
    const scan = scanId();
    currentScan.current = scan;
    setLoading(true);
    setError('');
    setConfirmKey(null);
    // 旧结果属于旧阈值/旧范围，不能和新一次扫描的加载态一起显示；失败时也一样，
    // 留着它会让摄影师以为「按 12 扫出来的还是刚才 8 的那几组」。
    setResult(null);
    setKeepers({});
    const params = new URLSearchParams({ threshold: String(nextThreshold), scan });
    const dir = nextScope === 'dir' && initialDir.current !== null ? initialDir.current : null;
    if (dir !== null) params.set('dir', dir);
    try {
      const data = await getJSON<SimilarResult>(`/api/library/similar?${params.toString()}`);
      if (!valid() || currentScan.current !== scan) return;
      setResult(data);
      setKeepers({});
    } catch (err) {
      if (valid() && currentScan.current === scan) setError((err as Error).message);
    } finally {
      if (valid() && currentScan.current === scan) setLoading(false);
    }
  };

  useEffect(() => {
    alive.current = true;
    void run();
    return () => { alive.current = false; };
    // 只在面板打开时自动扫描一次；阈值或范围改变后由「重新扫描」显式触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 换库之后这个面板里的 id、目录范围和结果都失效了。与其在后台偷偷换一份
  // 数据，不如直接关掉，让顶栏对应新库的状态重新打开。
  useEffect(() => {
    if (root !== initialRoot.current) onClose();
  }, [root, onClose]);

  const scanProgress = progress && progress.scan === currentScan.current ? progress : null;

  const keeperOf = (group: SimilarGroup) => {
    const explicit = keepers[group.key];
    if (explicit && group.assetIds.includes(explicit)) return explicit;
    return group.assetIds.find((id) => marks[id] === 'pick') ?? group.assetIds[0];
  };

  const isResolved = (group: SimilarGroup) => {
    const keeper = keeperOf(group);
    return marks[keeper] === 'pick'
      && group.assetIds.every((id) => id === keeper || marks[id] === 'reject');
  };

  const groups = (result?.groups ?? []).filter((group) => !onlyUnresolved || !isResolved(group));

  const markGroup = (group: SimilarGroup) => {
    if (!useSession.getState().canWrite() || useMarks.getState().pendingCount > 0) return;
    const keeper = keeperOf(group);
    const changes: Record<string, Mark | null> = {};
    changes[keeper] = 'pick';
    for (const id of group.assetIds) if (id !== keeper) changes[id] = 'reject';
    useMarks.getState().setMarkMany(changes);
    useReview.getState().setSeen(group.assetIds, true);
    setConfirmKey(null);
  };

  const keepOnly = (group: SimilarGroup) => {
    if (!useSession.getState().canWrite() || useMarks.getState().pendingCount > 0) return;
    const keeper = keeperOf(group);
    useMarks.getState().setMark([keeper], 'pick');
    useReview.getState().setSeen([keeper], true);
  };

  const openLarge = (group: SimilarGroup) => {
    const view = useView.getState();
    const keeper = keeperOf(group);
    // 把整组作为大图的翻页序列：相似组可能跨越当前目录/标签页，甚至成员正被
    // 折叠在连拍组里，带着旧筛选打开会让 pruneMissing 把当前这张当成"已消失"，
    // 大图当场关掉。先清筛选，确保整组都在可见集合里，再把序列交给大图。
    view.clearFilters();
    view.openLightbox(keeper, group.assetIds);
    onClose();
  };

  const scopeLabel = initialDir.current === null
    ? '整个照片库'
    : `当前目录（${initialDir.current || '照片库根目录'}）`;

  return <div className="modal" ref={ref} tabIndex={-1}>
    <section className="modal-box similar-panel" role="dialog" aria-modal="true" aria-label="相似照片">
      <h2>相似照片</h2>
      <p className="muted">
        按缩略图的画面结构分组，找出同一场景的近似照片。比较的是构图明暗关系，
        不判断表情、焦点或颜色；阈值需要按拍摄习惯自行调整。打开大图比较时会先清除当前筛选。
      </p>

      <div className="similar-controls">
        <label>相似程度
          <select value={threshold} disabled={loading}
            onChange={(event) => setThreshold(Number(event.target.value))}>
            {THRESHOLDS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        {initialDir.current === null
          ? <span className="muted">范围：整个照片库</span>
          : <label>查找范围
            <select value={scope} disabled={loading}
              onChange={(event) => setScope(event.target.value as 'all' | 'dir')}>
              <option value="dir">{scopeLabel}</option>
              <option value="all">整个照片库</option>
            </select>
          </label>}
        <button disabled={loading} onClick={() => void run()}>
          {loading ? '正在分析…' : result ? '重新扫描' : '开始扫描'}
        </button>
        <label className="similar-toggle">
          <input type="checkbox" checked={onlyUnresolved} onChange={(event) => setOnlyUnresolved(event.target.checked)} />
          只看未处理组
        </label>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {loading && <div className="similar-progress" role="status" aria-live="polite">
        <span>正在分析缩略图{scanProgress && scanProgress.total > 0
          ? ` ${scanProgress.done}/${scanProgress.total}` : '…'}</span>
        {scanProgress && scanProgress.total > 0
          && <progress value={scanProgress.done} max={scanProgress.total} />}
        <span className="muted">首次扫描需要读取每一张缩略图，照片多时会慢一些；结果会缓存到当前目录。</span>
      </div>}

      {!loading && result && <>
        <p className="similar-summary" role="status">
          分析 {result.analyzed} 张，跳过 {result.skipped} 张
          {result.noPreview > 0 && `（其中 ${result.noPreview} 张没有可用预览）`}
          {result.flat > 0 && `（其中 ${result.flat} 张画面过于平坦）`}
          {` · 找到 ${result.groups.length} 组相似照片 · 用时 ${(result.durationMs / 1000).toFixed(1)} 秒`}
        </p>
        {result.capped && <p className="similar-warning" role="alert">
          照片太多，本次只分析前 {result.analyzed} 张。请切换到当前目录或减少范围后再扫描。
        </p>}
        {groups.length === 0
          ? <p>{result.groups.length === 0
            ? '没有找到相似照片。可以换一个相似程度，或确认照片的缩略图是否已经生成。'
            : '所有相似组都已处理。取消「只看未处理组」可以查看它们。'}</p>
          : <div className="similar-groups">
            {groups.map((group, index) => {
              const keeper = keeperOf(group);
              const others = group.assetIds.filter((id) => id !== keeper);
              const picked = group.assetIds.filter((id) => marks[id] === 'pick').length;
              const rejected = group.assetIds.filter((id) => marks[id] === 'reject').length;
              return <section className={`similar-group${isResolved(group) ? ' similar-group-done' : ''}`}
                key={group.key} aria-label={`第 ${index + 1} 组，${group.assetIds.length} 张相似照片`}>
                <header className="similar-group-head">
                  <strong>第 {index + 1} 组 · {group.assetIds.length} 张</strong>
                  <span className="muted">已收藏 {picked} · 已排除 {rejected} · 最大差异 {group.maxDistance}/64</span>
                  {isResolved(group) && <span className="similar-done">已处理</span>}
                </header>
                <div className="similar-thumbs" role="group" aria-label={`第 ${index + 1} 组的保留图`}>
                  {group.assetIds.map((id) => {
                    const asset = byId.get(id);
                    const mark = marks[id];
                    const active = id === keeper;
                    return <button type="button" key={id} aria-pressed={active}
                      aria-label={`选 ${asset?.stem ?? id} 为保留图（${markLabel(mark)}）`}
                      className={`similar-thumb${active ? ' similar-thumb-keeper' : ''}${mark === 'pick' ? ' similar-thumb-pick' : mark === 'reject' ? ' similar-thumb-reject' : ''}`}
                      onClick={() => setKeepers((current) => ({ ...current, [group.key]: id }))}
                      title={`${id} · 与组内锚点的差异 ${group.distances[id] ?? 0}/64 · ${markLabel(mark)}`}>
                      <img src={thumbUrl(id)} alt={asset?.stem ?? id} loading="lazy" draggable={false} />
                      <span className="similar-thumb-caption">
                        <code>{asset?.stem ?? id}</code>
                        <span className="similar-thumb-state" data-mark={active ? 'keep' : mark ?? 'none'}>
                          {!active && mark && <MarkIcon mark={mark} size={11} />}
                          {active ? '保留' : mark === 'pick' ? '已收藏' : mark === 'reject' ? '已排除' : '点击选为保留'}
                        </span>
                      </span>
                    </button>;
                  })}
                </div>
                <div className="similar-actions">
                  {canWrite ? <>
                    <button disabled={pending > 0} onClick={() => keepOnly(group)}>只收藏保留图</button>
                    <button className="primary" disabled={pending > 0 || others.length === 0}
                      onClick={() => setConfirmKey(group.key)}>
                      保留并排除其余 {others.length} 张…
                    </button>
                  </> : <span className="muted">只读模式，只能查看分组</span>}
                  <button className="ghost" onClick={() => openLarge(group)}
                    title="清除当前筛选，全屏打开保留图；可用 ← → 在这组内翻页、空格放大、P / X / U 标记">在大图中比较这组</button>
                </div>
                {confirmKey === group.key && <div className="similar-confirm" role="alert">
                  <p>
                    将「{byId.get(keeper)?.stem ?? keeper}」标为收藏，其余 {others.length} 张标为排除。
                    已有摄影师最终决定仍然优先；整组算一步撤销，不删除文件。
                  </p>
                  <button className="danger" disabled={pending > 0} onClick={() => markGroup(group)}>确认处理这一组</button>
                  <button onClick={() => setConfirmKey(null)}>取消</button>
                </div>}
              </section>;
            })}
          </div>}
      </>}

      <div className="modal-actions"><button onClick={onClose}>关闭</button></div>
    </section>
  </div>;
}
