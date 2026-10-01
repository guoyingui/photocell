import { useMarks } from '../store/marks';
import { useSession } from '../store/session';

export function HistoryButtons() {
  const canWrite = useSession((s) => s.canWrite());
  const canUndo = useMarks((s) => s.undoStack.length > 0);
  const canRedo = useMarks((s) => s.redoStack.length > 0);
  if (!canWrite) return null;
  return <div className="history-actions" aria-label="标记历史">
    <button type="button" disabled={!canUndo} title="撤销标记（⌘/Ctrl+Z）"
      onClick={() => useMarks.getState().undo()}>撤销</button>
    <button type="button" disabled={!canRedo} title="重做标记（⌘/Ctrl+Shift+Z 或 Ctrl+Y）"
      onClick={() => useMarks.getState().redo()}>重做</button>
  </div>;
}
