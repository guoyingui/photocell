import { useEffect, useRef, useState } from 'react';
import { getJSON, getSessionId, postJSON } from '../lib/api';
import { useDialogFocus } from '../lib/useDialogFocus';
import { useMarks } from '../store/marks';

interface BackupInfo { id: string; createdAt: number; reason: string; count: number }
interface Preview { token: string; source: string; target: string; createdAt: number; matched: number; missing: string[]; extra: number; changes: string[] }
const reasons: Record<string, string> = { daily: '开库自动备份', manual: '手动备份', 'before-restore': '恢复前备份' };
function download(bundle: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url;
  anchor.download = `PhotoCull-${new Date().toISOString().replaceAll(':', '-')}.json`;
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BackupPanel({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const ref = useDialogFocus(() => { if (!busy) onClose(); });
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [bundle, setBundle] = useState<unknown>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const pending = useMarks((s) => s.pendingCount);
  const alive = useRef(true);
  const sid = useRef(getSessionId());
  const valid = () => alive.current && sid.current === getSessionId();
  const load = async () => {
    const result = await getJSON<{ backups: BackupInfo[] }>('/api/library/backups');
    if (valid()) setBackups(result.backups);
  };
  useEffect(() => {
    alive.current = true;
    void load().catch((err) => { if (valid()) setError(err.message); });
    return () => { alive.current = false; };
  }, []);
  const run = async (task: () => Promise<void>) => {
    if (busy || !valid()) return;
    setBusy(true); setError(''); setMessage('');
    try { await task(); } catch (err) { if (valid()) setError((err as Error).message); }
    finally { if (valid()) setBusy(false); }
  };
  const inspect = async (value: unknown) => {
    setPreview(null); setConfirmName('');
    const result = await postJSON<Preview>('/api/library/backups/preview', { bundle: value });
    if (valid()) { setBundle(value); setPreview(result); }
  };
  return <div className="modal" ref={ref} tabIndex={-1}><section className="modal-box" role="dialog" aria-modal="true" aria-label="选片备份与恢复">
    <h2>选片备份与恢复</h2>
    <p>备份当前目录的标记、最终名单、连拍代表图、客户备注与版本、后期信息和浏览进度。</p>
    <p className="muted">不包含原片、缩略图、分享凭据、导出任务和浏览器预设。开库每天自动备份一次，保留最近 10 份自动备份；手动及恢复前备份保留。请下载一份到其他磁盘。</p>
    {error && <p className="error" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    <button className="primary" disabled={busy || pending > 0} onClick={() => void run(async () => {
      const result = await postJSON<{ bundle: unknown }>('/api/library/backups');
      if (!valid()) return;
      download(result.bundle); setMessage('备份已保存到当前目录，并已开始下载。'); await load();
    })}>创建并下载备份</button>
    <label className="backup-import">导入备份文件（JSON，最多 24 MB）
      <input type="file" accept=".json,application/json" disabled={busy || pending > 0} onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (!file) return;
        setPreview(null); setBundle(null);
        void run(async () => {
          if (file.size > 24 * 1024 * 1024) throw new Error('备份超过 24 MB，请选择较小的备份');
          const text = await file.text();
          if (valid()) await inspect(JSON.parse(text));
        });
      }} />
    </label>
    <details open><summary>当前目录的备份（{backups.length}）</summary><ul className="backup-list">
      {backups.map((item) => <li key={item.id}>
        <span>{new Date(item.createdAt).toLocaleString('zh-CN')} · {reasons[item.reason] ?? '备份'} · {item.count} 张</span>
        <button disabled={busy || pending > 0} onClick={() => void run(async () => {
          const value = await getJSON(`/api/library/backups/${item.id}`); if (valid()) await inspect(value);
        })}>预览恢复</button>
        <button disabled={busy} onClick={() => void run(async () => {
          const value = await getJSON(`/api/library/backups/${item.id}`); if (valid()) download(value);
        })}>下载</button>
      </li>)}
    </ul></details>
    {preview && <section className="restore-preview">
      <h3>恢复预览</h3>
      <p>备份目录：{preview.source} · {new Date(preview.createdAt).toLocaleString('zh-CN')}</p>
      <p>目标目录：{preview.target} · 匹配 {preview.matched} 张 · 缺失 {preview.missing.length} 张 · 当前额外 {preview.extra} 张</p>
      <p>将覆盖：{preview.changes.join('、') || '没有数据差异'}。</p>
      {!!preview.missing.length && <details><summary>缺失照片清单</summary><ul>{preview.missing.map((id) => <li key={id}>{id}</li>)}</ul></details>}
      <p>按相对目录和文件主名匹配。请确认这是同一批照片；恢复会完整替换上述选片数据，额外照片现有标记也会被移除。缺失照片的历史数据保留，照片文件不会改变。</p>
      <p>执行前自动备份当前数据，完成后所有在线页面重新载入。</p>
      <label>输入当前目录名称「{preview.target}」确认覆盖 <input value={confirmName} disabled={busy}
        onChange={(e) => setConfirmName(e.target.value)} /></label>
      <button className="danger" disabled={busy || pending > 0 || confirmName !== preview.target} onClick={() => void run(async () => {
        await postJSON('/api/library/backups/restore', { bundle, token: preview.token, confirmName });
        if (alive.current) window.location.reload();
      })}>确认恢复选片数据</button>
    </section>}
    <div className="modal-actions"><button disabled={busy} onClick={onClose}>关闭</button></div>
  </section></div>;
}
