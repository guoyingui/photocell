import { useEffect, useState } from 'react';
import { useMarks } from '../store/marks';
import { useNotice } from '../store/notice';
import { useSession } from '../store/session';

/** 标记后给一条可撤销的提示；保存失败也从这里冒出来。 */
export function Toast() {
  const undoStack = useMarks((s) => s.undoStack);
  const undo = useMarks((s) => s.undo);
  const error = useMarks((s) => s.error);
  const clearError = useMarks((s) => s.clearError);
  const notice = useNotice((s) => s.text);
  const canWrite = useSession((s) => s.canWrite());
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (undoStack.length === 0) {
      // 栈被清空的来源不止"计时器到点自然消失"——⌘Z 本身就会同步把栈弹空。
      // 如果这里不把 visible 复位，下一次栈从 0 变回 >0 时 setVisible(true)
      // 仍然会正确触发，但万一渲染在这次 effect 之前就已经用了旧的 true，
      // 下面的 undoStack.length === 0 渲染期兜底会兜住；这里复位是为了不让
      // visible 长期停留在一个和 undoStack 状态不一致的"假真"上。
      setVisible(false);
      return;
    }
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 2600);
    return () => clearTimeout(timer);
  }, [undoStack.length]);

  // 错误提示必须能手动关掉：没有关闭按钮的话，它会一直挂到下一次标记成功为止，
  // 而"下一次标记成功"恰恰是失败之后最不确定会不会发生的事。
  if (error) {
    return (
      <div className="toast toast-error">
        {error}
        <button className="ghost" onClick={clearError} title="关闭">✕</button>
      </div>
    );
  }
  // 优先级：错误 > 一次性提示 > 撤销提示。
  //
  // 错误压过一切（它需要用户去处理，而且只有手动才关得掉）。一次性提示压过
  // 撤销提示，是因为它解释的是**用户刚按下的那一下为什么没有全部生效**——
  // 而撤销提示（"已更新 N 张"）此刻说的是同一次操作里成功的那部分，
  // 两条同时冒出来只会让人不知道该看哪句。
  if (notice) return <div className="toast">{notice}</div>;
  // 渲染顺序先于上面的 effect：按下 ⌘Z 时 undo() 是同步的，会在这次渲染里
  // 把 undoStack 弹空，但 visible 这个本地 state 要等这次渲染提交完、
  // effect 跑过才会被复位。如果只判断 !visible，会出现 visible 仍是
  // true、undoStack 已经是空的这一帧，下面 undoStack[undoStack.length-1]
  // 就会取到 undefined，读它的 .length 直接抛错，把整个 React 树炸掉。
  // 所以这里必须同时兜住"栈已经空了"这个条件，而不是只依赖 effect 迟一步的复位。
  if (!visible || undoStack.length === 0) return null;

  const last = undoStack[undoStack.length - 1];
  return (
    <div className="toast">
      已更新 {last.length} 张
      {canWrite && <button className="ghost" onClick={() => {
        if (useSession.getState().canWrite()) undo();
      }}>撤销（⌘/Ctrl+Z）</button>}
    </div>
  );
}
