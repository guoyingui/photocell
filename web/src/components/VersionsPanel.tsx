import { useEffect, useMemo, useState } from 'react';
import { getJSON, getSessionId } from '../lib/api';
import { useDialogFocus } from '../lib/useDialogFocus';
import { selectionDiff, type SelectionVersion } from '../../../shared/selectionVersions.js';

const ACTIONS = { submit: '客户提交', confirm: '摄影师确认', reopen: '重新开放', final: '最终名单修改', export: '导出时名单' };
const label = (v: SelectionVersion) => `${new Date(v.createdAt).toLocaleString('zh-CN')} · ${ACTIONS[v.action]} · ${v.pickedIds.length} 张`;

export function VersionsPanel({ onClose }: { onClose: () => void }) {
  const ref = useDialogFocus(onClose);
  const [versions, setVersions] = useState<SelectionVersion[]>([]);
  const [subject, setSubject] = useState('admin');
  const [beforeId, setBeforeId] = useState('');
  const [afterId, setAfterId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true; const sid = getSessionId();
    getJSON<{ versions: SelectionVersion[] }>('/api/library/versions').then((data) => {
      if (alive && sid === getSessionId()) setVersions(data.versions);
    }).catch((err) => { if (alive) setError(err.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  const subjects = useMemo(() => new Map([['admin', '摄影师最终名单'], ...versions.map((v) => [v.subject, v.name] as [string, string])]), [versions]);
  const list = versions.filter((v) => v.subject === subject);
  const after = list.find((v) => v.id === afterId) ?? list[0];
  const before = beforeId === 'empty' ? null : list.find((v) => v.id === beforeId) ?? list[1] ?? null;
  const diff = after ? selectionDiff(before, after) : null;
  return <div className="modal" ref={ref} tabIndex={-1}>
    <section className="modal-box versions-panel" role="dialog" aria-modal="true" aria-label="选片版本与差异">
      <h2>选片版本与差异</h2>
      <p className="muted">保存提交、确认、重新开放和最终名单的历史快照。旧版本升级前的操作无法补录；只比较同一人的版本。</p>
      {error && <p className="error" role="alert">{error}</p>}
      {loading ? <p>正在载入版本…</p> : <>
        <label>名单 <select value={subject} onChange={(e) => { setSubject(e.target.value); setBeforeId(''); setAfterId(''); }}>
          {[...subjects].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        {!after ? <p>这份名单还没有历史版本。</p> : <>
          <div className="version-selectors">
            <label>之前 <select value={before?.id ?? 'empty'} onChange={(e) => setBeforeId(e.target.value)}>
              <option value="empty">空名单（查看整份版本）</option>
              {list.map((v) => <option key={v.id} value={v.id}>{label(v)}</option>)}
            </select></label>
            <label>之后 <select value={after.id} onChange={(e) => setAfterId(e.target.value)}>
              {list.map((v) => <option key={v.id} value={v.id}>{label(v)}</option>)}
            </select></label>
          </div>
          <p>新增 {diff!.added.length} 张 · 撤回 {diff!.removed.length} 张 · 照片备注变化 {diff!.photoNotes.length} 条</p>
          <div className="version-columns">
            <section><h3>新增收藏</h3>{diff!.added.length ? <ul>{diff!.added.map((id) => <li key={id}>{id}</li>)}</ul> : <p className="muted">无</p>}</section>
            <section><h3>撤回收藏</h3>{diff!.removed.length ? <ul>{diff!.removed.map((id) => <li key={id}>{id}</li>)}</ul> : <p className="muted">无</p>}</section>
          </div>
          {diff!.noteChanged && <section><h3>整体备注变化</h3><p>之前：{before?.note || '无'}</p><p>之后：{after.note || '无'}</p></section>}
          {!!diff!.photoNotes.length && <section><h3>照片备注变化</h3><ul>{diff!.photoNotes.map((note) => <li key={note.id}>
            <strong>{note.id}</strong><p>之前：{note.before || '无'}</p><p>之后：{note.after || '已清除'}</p>
          </li>)}</ul></section>}
          <details><summary>查看此版本完整收藏清单（{after.pickedIds.length} 张）</summary><ul>{after.pickedIds.map((id) => <li key={id}>{id}</li>)}</ul></details>
          <p className="muted">版本编号：{after.id}</p>
        </>}
      </>}
      <div className="modal-actions"><button onClick={onClose}>关闭</button></div>
    </section>
  </div>;
}
