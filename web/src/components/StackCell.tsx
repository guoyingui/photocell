import { Thumb } from './Thumb';
import { useMarks } from '../store/marks';
import { useView } from '../store/view';
import { groupMarkSummary } from '../lib/derive';
import type { Asset } from '../types';
import type { Group } from '../lib/bursts';

interface Props {
  group: Group;
  byId: Map<string, Asset>;
  priority: number;
  visible: boolean;
  order?: string[];
}

/** 单张就是普通瓦片；多张渲染成卡牌堆，右上角 ×N，点击就地展开。 */
export function StackCell({ group, byId, priority, visible, order }: Props) {
  const marks = useMarks((s) => s.marks);
  const expanded = useView((s) => s.expanded.has(group.key));
  const toggleExpand = useView((s) => s.toggleExpand);

  const head = byId.get(group.ids[0]);
  if (!head) return null;
  if (group.ids.length === 1) {
    return <Thumb asset={head} priority={priority} visible={visible} order={order} />;
  }

  const summary = groupMarkSummary(group.ids, marks);
  const cls = [
    'stack',
    expanded ? 'stack-open' : '',
    summary.picked === summary.total ? 'stack-all-pick' : '',
    summary.rejected === summary.total ? 'stack-all-reject' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cls}>
      <span className="stack-paper stack-paper-2" aria-hidden />
      <span className="stack-paper stack-paper-1" aria-hidden />
      <Thumb asset={head} priority={priority} visible={visible} order={order} />
      <button className="stack-count" onClick={() => toggleExpand(group.key)}
              title={expanded ? '收起这组连拍' : '展开这组连拍'}>
        ×{group.ids.length}
      </button>
      {summary.picked > 0 && (
        <span className="stack-summary">{summary.picked}/{summary.total} 已收藏</span>
      )}
    </div>
  );
}
