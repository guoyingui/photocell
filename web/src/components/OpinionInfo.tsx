import { summarizeOpinions } from '../../../shared/opinions.js';
import { useMarks } from '../store/marks';
import { useSession } from '../store/session';

export function OpinionInfo({ id }: { id: string }) {
  const kind = useSession((state) => state.kind);
  const roster = useSession((state) => state.roster);
  const contrib = useMarks((state) => state.contrib[id]);
  const final = useMarks((state) => state.finalMarks[id]);
  if (kind !== 'admin') return final ? <p>摄影师最终决定：{final.mark === 'pick' ? '收藏' : '排除'}</p> : null;
  const summary = summarizeOpinions(contrib);
  return <div className="opinion-info"><strong>客户意见</strong><p>{summary.picks} 人收藏 · {summary.rejects} 人排除</p>
    {Object.entries(contrib ?? {}).filter(([userId]) => userId !== 'admin').map(([userId, vote]) =>
      <p key={userId}>{roster.find((user) => user.id === userId)?.nickname ?? '已离开的成员'}：{vote.mark === 'pick' ? '收藏' : '排除'}</p>)}
    <p>摄影师最终决定：{final ? final.mark === 'pick' ? '收藏' : '排除' : '尚未确认'}</p>
  </div>;
}
