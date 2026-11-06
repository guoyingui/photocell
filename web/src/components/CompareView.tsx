import { useEffect, useRef, useState } from 'react';
import { useView } from '../store/view';
import { useMarks } from '../store/marks';
import { useSession } from '../store/session';
import { applyMark } from '../lib/applyMark';
import { originalUrl, thumbUrl } from '../lib/thumbSource';
import { usePreviewCache } from '../store/previewCache';
import { clampPan, zoomAt, type ZoomState } from '../lib/lightboxZoom';
import type { Group } from '../lib/bursts';
import { useBurstLeaders } from '../store/burstLeaders';
import type { Asset, Mark } from '../types';
import { MarkIcon } from './MarkIcon';

const FIT: ZoomState = { scale: 1, pan: { x: 0, y: 0 } };

/** 两侧共享相对视口的缩放与平移，换候选时保留当前比较位置。 */
export function CompareView({ order, byId, groups = [] }: { order: string[]; byId: Map<string, Asset>; groups?: Group[] }) {
  usePreviewCache((state) => state.version);
  const comparison = useView((s) => s.compare);
  const close = useView((s) => s.closeCompare);
  const open = useView((s) => s.openCompare);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmReject, setConfirmReject] = useState(false);
  const isAdmin = useSession((s) => s.kind === 'admin');
  const pending = useMarks((s) => s.pendingCount);
  const canWrite = useSession((s) => s.canWrite());
  const marks = useMarks((s) => s.marks);
  const [zoom, setZoom] = useState<ZoomState>(FIT);
  const group = comparison?.groupKey ? groups.find((item) => item.key === comparison.groupKey) : undefined;
  const scopedOrder = comparison?.groupKey ? group?.ids ?? [] : order;
  const valid = comparison !== null && [comparison.reference, comparison.candidate]
    .every((id) => byId.has(id) && scopedOrder.includes(id));
  const reference = comparison?.reference;
  const candidate = comparison?.candidate;
  const candidates = scopedOrder.filter((id) => id !== reference);
  const index = candidate ? candidates.indexOf(candidate) : -1;

  useEffect(() => {
    if (comparison && !valid) close();
  }, [comparison, valid, close]);
  useEffect(() => { if (!comparison) { setZoom(FIT); setError(''); } setConfirmReject(false); }, [comparison, group]);
  const navigate = (ref: string, next: string) => { setConfirmReject(false); open(ref, next, comparison?.groupKey); };
  const chooseLeader = async () => {
    if (!group || !reference || busy || !isAdmin) return;
    setBusy(true); setError('');
    try { await useBurstLeaders.getState().save(group.key, reference); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (!valid || !reference || !candidate) return;
    const onKey = (event: KeyboardEvent) => {
      if (confirmReject && event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if ((key === ' ' || key === 'enter') && target?.closest('button')) return;
      if (!['escape', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', ' ', 'p', 'f', 'x', 'u', 'h', 'enter'].includes(key)) return;
      event.preventDefault(); event.stopPropagation();
      if (key === 'escape') close();
      else if (key === 'arrowleft' && candidates[index - 1]) navigate(reference, candidates[index - 1]);
      else if (key === 'arrowright' && candidates[index + 1]) navigate(reference, candidates[index + 1]);
      else if (key === ' ') setZoom((value) => value.scale === 1 ? { scale: 2, pan: { x: 0, y: 0 } } : FIT);
      else if (['p', 'f', 'x', 'u'].includes(key)) {
        applyMark(key === 'x' ? 'reject' : key === 'u' ? null : 'pick', { targets: [candidate] });
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [valid, reference, candidate, scopedOrder, index, open, close, comparison?.groupKey, confirmReject]);

  if (!valid || !comparison) return null;
  return <div className="compare-view" role="dialog" aria-modal="true" aria-label="双图对比">
    <header className="compare-toolbar">
      <strong>{group ? `连拍组择优 · ${scopedOrder.length} 张` : '双图对比'}</strong>
      <span className="muted">左侧固定参考 · 滚轮同步缩放 · 拖拽同步平移</span>
      <button onClick={() => setZoom(FIT)}>恢复贴合</button>
      <button onClick={() => navigate(comparison.candidate, comparison.reference)}>交换位置</button>
      <button onClick={close}>退出对比（Esc）</button>
    </header>
    {group && isAdmin && <div className="burst-actions">
      <button disabled={busy} onClick={() => void chooseLeader()}>将参考图设为代表图</button>
      <button disabled={busy || pending > 0 || !canWrite || candidates.length === 0}
        onClick={() => setConfirmReject(true)}>排除其余 {candidates.length} 张…</button>
      <span className="muted">仅处理本组当前筛选下可见的照片；代表图本身不改变标记。</span>
      {confirmReject && <div role="alert">
        <p>保留参考图 {reference} 的标记，将其余 {candidates.length} 张标为排除。已有摄影师最终决定仍优先。可撤销，不删除文件。</p>
        <button disabled={pending > 0} onClick={() => {
          if (useSession.getState().kind !== 'admin' || !useSession.getState().canWrite()) return;
          applyMark('reject', { targets: candidates }); setConfirmReject(false);
        }}>确认排除其余照片</button>
        <button onClick={() => setConfirmReject(false)}>取消</button>
      </div>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>}
    <div className="compare-panes">
      {(['reference', 'candidate'] as const).map((side) => {
        const asset = byId.get(comparison[side])!;
        const label = side === 'reference' ? '参考图' : '候选图';
        return <section className="compare-pane" key={side} aria-label={label}>
          <div className="compare-caption">
            <strong>{label}</strong><code>{asset.id}</code>
            <CompareMark mark={marks[asset.id]} />
          </div>
          <CompareStage asset={asset} zoom={zoom} setZoom={setZoom} />
          <div className="compare-actions">
            {canWrite && (['pick', 'reject', null] as const).map((mark: Mark | null) => (
              <button key={mark ?? 'none'} type="button"
                className={mark ? `lb-mark lb-mark-${mark}${marks[asset.id] === mark ? ' is-on' : ''}` : undefined}
                aria-label={`${mark === 'pick' ? '收藏' : mark === 'reject' ? '排除' : '取消标记'}${label}`}
                onClick={() => applyMark(mark, { targets: [asset.id] })}>
                {mark && <MarkIcon mark={mark} />}
                {mark === 'pick' ? '收藏' : mark === 'reject' ? '排除' : '取消标记'}
              </button>
            ))}
            {side === 'candidate' && <>
              <button disabled={index <= 0} onClick={() => navigate(comparison.reference, candidates[index - 1])}>上一张</button>
              <span className="muted">{index + 1} / {candidates.length}</span>
              <button disabled={index >= candidates.length - 1}
                onClick={() => navigate(comparison.reference, candidates[index + 1])}>下一张</button>
            </>}
          </div>
        </section>;
      })}
    </div>
    <footer className="compare-footer">同步缩放 {zoom.scale.toFixed(1)}× · ← → 更换候选
      {canWrite && ' · P 收藏候选 · X 排除候选 · U 取消标记'}</footer>
  </div>;
}

function CompareMark({ mark }: { mark: Mark | undefined }) {
  return <span className="compare-mark" data-mark={mark ?? 'none'}>
    {mark && <MarkIcon mark={mark} size={11} />}
    {mark === 'pick' ? '已收藏' : mark === 'reject' ? '已排除' : '未标记'}
  </span>;
}

function CompareStage({ asset, zoom, setZoom }: {
  asset: Asset;
  zoom: ZoomState;
  setZoom: React.Dispatch<React.SetStateAction<ZoomState>>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; pan: ZoomState['pan'] } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [asset.id]);
  useEffect(() => {
    const stage = ref.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      setZoom((current) => {
        const next = zoomAt({ scale: current.scale,
          pan: { x: current.pan.x * rect.width, y: current.pan.y * rect.height } },
        Math.exp(-event.deltaY * 0.002),
        { x: event.clientX - rect.left, y: event.clientY - rect.top }, { w: rect.width, h: rect.height });
        return { scale: next.scale, pan: { x: next.pan.x / rect.width, y: next.pan.y / rect.height } };
      });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [setZoom]);
  return <div ref={ref} className="compare-stage"
    onDoubleClick={() => setZoom((current) => current.scale === 1 ? { scale: 2, pan: { x: 0, y: 0 } } : FIT)}
    onPointerDown={(event) => {
      if (event.button !== 0 || zoom.scale <= 1) return;
      drag.current = { x: event.clientX, y: event.clientY, pan: zoom.pan };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }}
    onPointerMove={(event) => {
      const start = drag.current;
      const rect = ref.current?.getBoundingClientRect();
      if (!start || !rect?.width || !rect.height) return;
      setZoom((current) => ({ scale: current.scale, pan: clampPan({
        x: start.pan.x + (event.clientX - start.x) / rect.width,
        y: start.pan.y + (event.clientY - start.y) / rect.height,
      }, current.scale, { w: 1, h: 1 }) }));
    }}
    onPointerUp={() => { drag.current = null; }}
    onPointerCancel={() => { drag.current = null; }}>
    {failed ? <p className="muted">这张照片没有可用的预览；纯 RAW 需要内嵌 JPEG</p>
      : <div className="compare-image" style={{
        transform: `translate(${zoom.pan.x * 100}%, ${zoom.pan.y * 100}%) scale(${zoom.scale})`,
      }}><img src={zoom.scale > 1 ? originalUrl(asset.id) : thumbUrl(asset.id, 'preview')}
        alt={asset.stem} draggable={false} onError={() => setFailed(true)} /></div>}
  </div>;
}
