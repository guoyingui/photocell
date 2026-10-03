import { useEffect, useState } from 'react';
import { getSessionId } from '../lib/api';
import { useSelection } from '../store/selection';
import { useSession } from '../store/session';
import { useMarks } from '../store/marks';

export function SelectionBar({ ready }: { ready: boolean }) {
  const user = useSession((state) => state.user);
  const sid = getSessionId();
  const { selection, loading, busy, error } = useSelection();
  const pending = useMarks((state) => state.pendingCount);
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!ready || !sid || !user) return;
    void useSelection.getState().activate(sid, user.id);
    return () => useSelection.getState().reset();
  }, [ready, sid, user?.id]);
  useEffect(() => { setNote(selection?.note ?? ''); }, [selection?.note]);
  const locked = selection?.status !== 'draft';
  if (!ready) return null;
  return <section className="selection-bar" aria-label="我的选片提交">
    {!selection ? <span>{loading ? '正在载入我的选片…' : '提交状态暂不可用'}</span> : <>
      <strong>我已选 {selection.selectedCount}{selection.limit !== null ? ` / ${selection.limit}` : ''} 张</strong>
      <span className="muted">{selection.status === 'confirmed' ? '摄影师已确认 · 已锁定'
        : selection.status === 'submitted' ? '已提交，等待摄影师确认 · 已锁定'
          : selection.limit === null ? '选好后提交，提交后锁定' : '数量为上限，可少选后提交'}</span>
      {!!selection.missingIds.length && <span className="warn">提交中有 {selection.missingIds.length} 张照片已不在目录</span>}
      <label>选片备注 <input value={note} maxLength={2000} disabled={locked || busy || user?.role !== 'editor'}
        placeholder="例如：保留两张合影，肤色自然" onChange={(event) => setNote(event.target.value)} /></label>
      {!locked && user?.role === 'editor' && <>
        <button disabled={busy || note === selection.note} onClick={() => void useSelection.getState().save({ note })}>保存备注</button>
        <button className="primary" disabled={busy || pending > 0 || selection.selectedCount === 0 || note !== selection.note}
          onClick={() => setConfirm(true)}>{pending > 0 ? '正在保存标记…' : '提交选片'}</button>
      </>}
    </>}
    {error && <span className="error">{error} <button onClick={() => void useSelection.getState().reload()}>刷新状态</button></span>}
    {confirm && selection && <div className="modal confirm-modal"><div className="modal-box" role="dialog" aria-modal="true" aria-label="确认提交选片">
      <h2>确认提交选片</h2><p>提交自己的 {selection.selectedCount} 张收藏及备注。提交后不能修改，需由摄影师重新开放。</p>
      {!!selection.note && <p>备注：{selection.note}</p>}
      {error && <p className="error">{error}</p>}
      <div className="modal-actions"><button disabled={busy} onClick={() => setConfirm(false)}>继续选片</button>
        <button className="primary" disabled={busy || pending > 0 || locked} onClick={async () => {
          if (await useSelection.getState().submit()) setConfirm(false);
        }}>{busy ? '正在提交…' : '确认提交并锁定'}</button></div>
    </div></div>}
  </section>;
}
