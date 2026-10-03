import { useMemo } from 'react';
import { useLibrary } from '../store/library';
import { useView } from '../store/view';
import { useReview } from '../store/review';
import { useMarks } from '../store/marks';
import { useWorkspace } from '../store/workspace';
import { META_FIELDS, formatMeta } from '../lib/photoFilters';
import type { Group } from '../lib/bursts';
import type { ReviewFilter } from '../types';

export function PhotoTools({ groups, order }: { groups: Group[]; order: string[] }) {
  const collapsed = useWorkspace((state) => state.collapsed.capture);
  const assets = useLibrary((s) => s.assets);
  const metas = useLibrary((s) => s.metas);
  const filters = useView((s) => s.photoFilters);
  const setFilters = useView((s) => s.setPhotoFilters);
  const reviewFilter = useView((s) => s.reviewFilter);
  const selection = useView((s) => s.selection);
  const cursor = useView((s) => s.cursor);
  const reviewed = useReview((s) => s.reviewed);
  const ready = useReview((s) => s.ready);
  const error = useReview((s) => s.error);
  const hidden = useMarks((s) => s.hidden);
  const marks = useMarks((s) => s.marks);
  const progress = useMemo(() => {
    const visible = assets.filter((asset) => !hidden.has(asset.id));
    const seen = visible.filter((asset) => reviewed.has(asset.id));
    return { total: visible.length, seen: seen.length,
      undecided: seen.filter((asset) => marks[asset.id] === undefined).length };
  }, [assets, reviewed, hidden, marks]);
  const options = useMemo(() => Object.fromEntries(META_FIELDS.map(({ key }) => [key,
    [...new Set([...metas.values()].map((meta) => meta[key])
      .filter((value): value is number => value !== null && Number.isFinite(value) && value > 0))].sort((a, b) => a - b),
  ])), [metas]);
  const locate = () => {
    const next = order[(order.indexOf(cursor ?? '') + 1) % order.length];
    if (!next) return;
    const group = groups.find((entry) => entry.ids.includes(next));
    const view = useView.getState();
    if (group && group.ids.length > 1 && !view.expanded.has(group.key)) view.toggleExpand(group.key);
    view.setCursor(next);
  };
  return <section className="photo-tools filter-bar" aria-label="查找、筛选和浏览进度">
    <div className="photo-filters">
      <label className="filter-field photo-search" data-active={Boolean(filters.query.trim())}>
        <span>文件名搜索</span>
        <input type="search" value={filters.query} placeholder="输入文件名、编号或相对路径"
          onChange={(event) => setFilters({ query: event.target.value })}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); locate(); } }} />
      </label>
      <button disabled={!order.length} onClick={locate}>定位下一张</button>
      {!collapsed && META_FIELDS.map(({ key, label }) => <label className="filter-field" data-active={Boolean(filters[key])} key={key}>
        <span>{label}</span>
        <select value={filters[key]} onChange={(event) => setFilters({ [key]: event.target.value })}>
          <option value="">全部</option>
          <option value="missing">未知</option>
          {options[key].map((value: number) => <option key={value} value={value}>{formatMeta(key, value)}</option>)}
        </select>
      </label>)}
      <button className="filter-reset" onClick={() => useView.getState().clearFilters()}>清除筛选</button>
      <span className="filter-result">结果 <b>{order.length}</b> 张</span>
    </div>
    <div className="review-progress">
      <div className="review-summary">
        <span>{ready ? `我的进度：已看 ${progress.seen} / ${progress.total} · 看过待定 ${progress.undecided}` : '正在载入浏览进度…'}</span>
        <progress aria-label="我的浏览进度" max={Math.max(1, progress.total)} value={progress.seen} />
      </div>
      <label className="filter-field" data-active={reviewFilter !== 'all'} data-disabled={!ready}>
        <span>浏览状态</span><select value={reviewFilter} disabled={!ready}
        onChange={(event) => useView.getState().setReviewFilter(event.target.value as ReviewFilter)}>
        <option value="all">全部</option><option value="unseen">还没看</option>
        <option value="seen">已看过</option><option value="undecided">看过但未标记</option>
      </select></label>
      <div className="filter-actions">
        <button disabled={!ready || !selection.size} title="把选区记为已看过（V）"
          onClick={() => useReview.getState().setSeen([...selection], true)}>记为已看</button>
        <button disabled={!ready || !selection.size}
          onClick={() => useReview.getState().setSeen([...selection], false)}>恢复未看</button>
      </div>
      {error && <span className="error">{error} <button onClick={() => void useReview.getState().reload()}>重新载入</button></span>}
    </div>
  </section>;
}
