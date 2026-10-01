import { applyHidden, applyMark } from '../lib/applyMark';
import { showToast } from '../store/notice';
import { useSession } from '../store/session';
import { useView } from '../store/view';
import type { Mark } from '../types';

/**
 * 框选、组合键点选之后的标记操作。单张也能直接用鼠标标记。
 */
export function MarkBar() {
  const selection = useView((s) => s.selection);
  const setCursor = useView((s) => s.setCursor);
  const inHiddenTab = useView((s) => s.tab === 'hidden');
  const canWrite = useSession((s) => s.canWrite());
  const canHide = useSession((s) => s.canHide());

  if (!canWrite || selection.size === 0) return null;

  const finish = () => {
    setCursor(null);
  };

  const run = (mark: Mark | null) => {
    applyMark(mark, { targets: [...selection] });
    finish();
  };

  return (
    <div className="markbar" role="toolbar" aria-label="批量标记">
      <span className="markbar-count">已选 {selection.size}</span>
      <button type="button" className="markbar-pick" onClick={() => run('pick')}>收藏</button>
      <button type="button" className="markbar-reject" onClick={() => run('reject')}>排除</button>
      <button type="button" onClick={() => run(null)}>取消标记</button>
      {canHide && (
        <button type="button" className="markbar-hide" onClick={() => {
          const result = applyHidden(!inHiddenTab, { targets: [...selection] });
          finish();
          if (result && result.skipped > 0) {
            showToast(result.hidden === 0
              ? '已标记的照片不能隐藏，先取消标记'
              : `已隐藏 ${result.hidden} 张，${result.skipped} 张因为已有标记被跳过`);
          }
        }}>{inHiddenTab ? '取消隐藏' : '隐藏'}</button>
      )}
    </div>
  );
}
