import { useMemo, useState } from 'react';
import { summarizeOpinions, type OpinionFilter } from '../../../shared/opinions.js';
import { getSessionId, putJSON } from '../lib/api';
import { useLibrary } from '../store/library';
import { useMarks, type FinalMarks } from '../store/marks';
import { useView } from '../store/view';
import type { Mark } from '../types';

const OPTIONS: [OpinionFilter, string][] = [['all', '全部意见'], ['common', '共同收藏'], ['conflict', '收藏与排除有争议'], ['multiPick', '至少两人收藏']];

export function OpinionTools({ order }: { order: string[] }) {
  const assets = useLibrary((state) => state.assets);
  const contrib = useMarks((state) => state.contrib);
  const hidden = useMarks((state) => state.hidden);
  const filter = useView((state) => state.opinionFilter);
  const selection = useView((state) => state.selection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const counts = useMemo(() => {
    const counts = { all: 0, common: 0, conflict: 0, multiPick: 0 };
    for (const asset of assets) {
      if (hidden.has(asset.id)) continue;
      const summary = summarizeOpinions(contrib[asset.id]); counts.all++;
      for (const key of ['common', 'conflict', 'multiPick'] as const) if (summary[key]) counts[key]++;
    }
    return counts;
  }, [assets, contrib, hidden]);
  const ids = [...selection].filter((id) => order.includes(id));
  const finalize = async (mark: Mark | null) => {
    if (!ids.length || busy) return;
    const sid = getSessionId();
    setBusy(true); setError('');
    try {
      const result = await putJSON<{ finalMarks: FinalMarks; finalRevision: number; marks: Record<string, Mark>; marksMeta: unknown; contrib: unknown }>(
        '/api/library/final-marks', { marks: Object.fromEntries(ids.map((id) => [id, mark])) });
      if (getSessionId() !== sid) return;
      useMarks.getState().reconcile(result.marks, result.marksMeta, result.contrib, result.finalMarks, result.finalRevision);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="opinion-tools" aria-label="多人意见汇总">
    <strong>客户意见</strong>{OPTIONS.map(([key, label]) => <button key={key}
      className={filter === key ? 'tab tab-on' : 'tab'} onClick={() => useView.getState().setOpinionFilter(key)}>{label} {counts[key]}</button>)}
    <span className="muted" title="共同收藏指至少两位客户收藏，且没有客户排除；未表态不计为赞同。">未表态不算赞同 · 不计摄影师的一票</span>
    <button disabled={busy || !ids.length} onClick={() => void finalize('pick')}>选区确认为最终收藏</button>
    <button disabled={busy || !ids.length} onClick={() => void finalize('reject')}>选区确认为最终排除</button>
    <button disabled={busy || !ids.length} onClick={() => void finalize(null)}>清除选区最终决定</button>
    {error && <span className="error">{error}</span>}
  </section>;
}
