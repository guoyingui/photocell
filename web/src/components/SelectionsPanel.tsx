import { useEffect, useRef, useState } from 'react';
import { getJSON, getSessionId, postJSON } from '../lib/api';
import { useLibrary } from '../store/library';
import type { CustomerSelection } from '../types';

export function SelectionsPanel({ onClose }: { onClose: () => void }) {
  const [selections, setSelections] = useState<CustomerSelection[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const assets = useLibrary((state) => state.assets);
  const request = useRef(0);
  const load = async () => {
    const seq = ++request.current, sid = getSessionId();
    try { const result = await getJSON<{ selections: CustomerSelection[] }>('/api/library/selections');
      if (seq !== request.current || sid !== getSessionId()) return;
      setSelections((old) => result.selections.map((item) => { const previous = old.find((entry) => entry.userId === item.userId);
        return previous && previous.revision > item.revision ? previous : item; })); setError(''); }
    catch (err) { if (seq === request.current && sid === getSessionId()) setError((err as Error).message); }
  };
  useEffect(() => {
    void load();
    const changed = () => void load();
    window.addEventListener('photocull-selection-updated', changed);
    return () => { request.current++; window.removeEventListener('photocull-selection-updated', changed); };
  }, []);
  const update = async (userId: string, action: 'confirm' | 'reopen') => {
    const sid = getSessionId();
    setBusy(true);
    try { await postJSON(`/api/library/selections/${encodeURIComponent(userId)}/${action}`); if (sid === getSessionId()) await load(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="modal"><section className="modal-box" role="dialog" aria-modal="true" aria-label="客户提交与确认">
    <h2>客户提交与确认</h2><p className="muted">每位客户提交自己的收藏和备注；提交清单保持锁定，其他成员的意见不会改变它。</p>
    {error && <p className="error">{error}</p>}
    {!selections.length && <p>当前目录还没有客户。可以先创建分享邀请客户选片。</p>}
    {selections.map((selection) => <article className="customer-selection" key={selection.userId}>
      <strong>{selection.nickname} · {selection.status === 'confirmed' ? '已确认' : selection.status === 'submitted' ? '待确认' : '选片中'}</strong>
      <span> · 已选 {selection.selectedCount}{selection.limit !== null ? ` / ${selection.limit}` : ''} 张</span>
      <p className="muted">{selection.shareLabel || '未命名分享'}{selection.submittedAt && ` · 提交于 ${new Date(selection.submittedAt).toLocaleString('zh-CN')}`}</p>
      {selection.note && <p>备注：{selection.note}</p>}
      <details><summary>查看收藏清单与照片备注</summary><ul>{[...new Set([...selection.pickedIds, ...Object.keys(selection.photoNotes)])].map((id) => {
        const asset = assets.find((asset) => asset.id === id);
        return <li key={id}>{!selection.pickedIds.includes(id) && '未收藏 · '}{asset ? [asset.dir, asset.jpg ?? asset.raws[0] ?? asset.stem].filter(Boolean).join('/') : `${id}（照片已不在目录）`}
          {selection.photoNotes[id] && ` · ${selection.photoNotes[id]}`}</li>;
      })}</ul></details>
      {selection.status === 'submitted' && <button className="primary" disabled={busy}
        onClick={() => void update(selection.userId, 'confirm')}>确认这份提交</button>}
      {selection.status !== 'draft' && <button disabled={busy} onClick={() => void update(selection.userId, 'reopen')}>重新开放修改</button>}
    </article>)}
    <div className="modal-actions"><button disabled={busy} onClick={() => void load()}>刷新</button><button disabled={busy} onClick={onClose}>关闭</button></div>
  </section></div>;
}
