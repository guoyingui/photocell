import { useDialogFocus } from '../lib/useDialogFocus';

export function GuestsOnlineConfirm({ message, onRevoke, onForce, onCancel, busy = false }: {
  message: string;
  onRevoke: () => void;
  onForce: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const ref = useDialogFocus(() => { if (!busy) onCancel(); });
  return <div className="modal">
    <div ref={ref} className="modal-box guests-online" role="alertdialog" aria-modal="true" aria-labelledby="guests-online-title" tabIndex={-1}>
      <h2 id="guests-online-title">这个文件夹还有人在看</h2>
      <p className="guests-online-msg">{message}</p>
      <div className="modal-actions">
        <button className="primary" disabled={busy} onClick={onRevoke}>去撤销链接…</button>
        <button className="danger" disabled={busy} onClick={onForce}>{busy ? '正在关闭…' : '仍然关闭并继续'}</button>
        <button data-autofocus disabled={busy} onClick={onCancel}>取消</button>
      </div>
    </div>
  </div>;
}
