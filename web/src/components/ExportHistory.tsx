import { useEffect, useRef, useState } from 'react';
import { getJSON, postJSON, openStream, withSid } from '../lib/api';

interface FileResult {
  id: string; dir: string; name: string; kind: string; status: string; path?: string; message?: string;
  resolvedBy?: string; retryStatus?: string; retryPath?: string;
}
interface HistoryRecord {
  id: string; parentId: string | null; createdAt: number; mode: 'copy' | 'move'; destRoot: string;
  status: string; retryCount: number; total: number; completed: number; error: string | null;
  files?: FileResult[];
  summary?: { records?: string[]; missingRaw?: string[] };
}
const LABELS: Record<string, string> = {
  running: '执行中', complete: '完成', partial: '部分失败', canceled: '已取消', failed: '失败',
  interrupted: '已中断', pending: '未完成', exported: '已导出', renamed: '已改名导出',
  skipped: '目标已存在', 'delete-failed': '已送达，源文件未删除',
};

export function ExportHistory({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<HistoryRecord | null>(null);
  const [retry, setRetry] = useState<HistoryRecord | null>(null);
  const [dest, setDest] = useState('');
  const [move, setMove] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [sending, setSending] = useState(false);
  const [job, setJob] = useState<{ id: string; mode: string } | null>(null);
  const [progress, setProgress] = useState('');
  const [done, setDone] = useState('');
  const stop = useRef<(() => void) | null>(null);
  const alive = useRef(true);
  const busy = sending || job !== null;
  const load = async (offset = 0) => {
    setLoading(true);
    try {
      const data = await getJSON<{ records: HistoryRecord[]; total: number }>(`/api/export/history?offset=${offset}`);
      if (!alive.current) return;
      setRecords((previous) => offset ? [...previous, ...data.records] : data.records);
      setTotal(data.total); setError('');
    } catch (err) { if (alive.current) setError(`导出历史未能载入：${(err as Error).message}`); }
    finally { if (alive.current) setLoading(false); }
  };
  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; stop.current?.(); };
  }, []);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    if (job?.mode !== 'move') return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [job]);
  const track = (id: string, mode: string) => {
    stop.current?.(); setJob({ id, mode }); setProgress('正在等待任务进度…'); setDone('');
    stop.current = openStream(`/api/export/${id}/stream`, (event) => {
      if (!alive.current) return;
      if (event.type === 'progress') setProgress(`${event.done} / ${event.total} · ${event.currentFile ?? ''}`);
      else if (event.type === 'done' || (event.type === 'error' && event.message)) {
        stop.current?.(); stop.current = null; setJob(null); setProgress(''); setDetail(null);
        setDone(event.type === 'done'
          ? `${event.summary.canceled ? '已取消' : '任务结束'}：成功 ${event.summary.exported} · 跳过 ${event.summary.skipped} · 失败 ${event.summary.errors.length}`
          : event.message);
        void load();
      } else if (event.type === 'error') setProgress('连接不稳定，正在重连；任务仍在服务端执行');
    });
  };
  const startRetry = async () => {
    if (!retry || busy || !dest || (move && Number(confirm) !== retry.retryCount)) return;
    setSending(true); setError('');
    try {
      const result = await postJSON<{ jobId: string }>(`/api/export/history/${retry.id}/retry`, {
        destRoot: dest, mode: move ? 'move' : 'copy', ...(move ? { confirmCount: Number(confirm) } : {}),
      });
      if (!alive.current) return;
      setRetry(null); track(result.jobId, move ? 'move' : 'copy');
    } catch (err) { if (alive.current) setError((err as Error).message); }
    finally { if (alive.current) setSending(false); }
  };
  return <section className="export-history" aria-label="导出历史">
    <p className="muted">当前照片目录的任务记录。清单会保留成功、跳过、失败和未完成的文件，重启后仍可查看。</p>
    <button disabled={loading || busy} onClick={() => void load()}>刷新历史</button>
    {loading && <p role="status">正在载入…</p>}
    {!loading && !records.length && !error && <p>当前目录暂无导出记录</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {done && <p role="status">{done}</p>}
    {job && <div className="progress"><span>{progress}</span><button onClick={() => {
      void postJSON(`/api/export/${job.id}/cancel`).catch((err) => setError(`未能取消：${err.message}`));
    }}>取消任务</button></div>}
    <div className="export-history-list">{records.map((record) => <article className="export-history-entry" key={record.id}>
      <strong>{new Date(record.createdAt).toLocaleString('zh-CN')} · {record.mode === 'move' ? '移动' : '复制'} · {LABELS[record.status] ?? record.status}</strong>
      <p>已完成 {record.completed} / {record.total} 个文件 · 待重试 {record.retryCount} 个</p>
      {record.parentId && <p className="muted">重试任务</p>}
      <p><code>{record.destRoot}</code></p>
      {record.error && <p className="error">{record.error}</p>}
      <div className="export-history-actions">
        <button disabled={busy} onClick={() => {
          if (detail?.id === record.id) { setDetail(null); return; }
          void getJSON<HistoryRecord>(`/api/export/history/${record.id}`).then((value) => {
            if (alive.current) setDetail(value);
          }).catch((err) => setError(err.message));
        }}>{detail?.id === record.id ? '收起清单' : '查看清单'}</button>
        <a href={withSid(`/api/export/history/${record.id}/csv`)} download>下载 CSV 清单</a>
        {record.status === 'running'
          ? <button disabled={busy} onClick={() => track(record.id, record.mode)}>查看进度</button>
          : <button disabled={busy || record.retryCount === 0} onClick={() => {
            setRetry(record); setDest(record.destRoot); setMove(false); setConfirm(''); setError('');
          }}>重试未完成文件</button>}
      </div>
      {detail?.id === record.id && <>
        {!!detail.summary?.missingRaw?.length && <p className="warn">无 RAW：{detail.summary.missingRaw.join('、')}</p>}
        {detail.summary?.records?.map((file) => <p className="muted" key={file}>清单位置：{file}</p>)}
        <div className="export-history-files"><table><thead><tr><th>源文件</th><th>结果</th><th>目标或原因</th></tr></thead>
          <tbody>{detail.files?.map((file, index) => <tr key={index}>
            <td>{[file.dir, file.name].filter(Boolean).join('/')}</td>
            <td>{LABELS[file.status] ?? file.status}{file.resolvedBy && ` → 重试：${LABELS[file.retryStatus ?? ''] ?? file.retryStatus}`}</td>
            <td>{file.resolvedBy ? file.retryPath : file.message ?? file.path ?? '—'}</td>
          </tr>)}</tbody></table></div>
      </>}
    </article>)}</div>
    {records.length < total && <button disabled={loading || busy} onClick={() => void load(records.length)}>加载更早的记录</button>}
    {retry && <div className="modal confirm-modal"><div className="modal-box" role="dialog" aria-modal="true" aria-label="重试未完成文件">
      <h2>重试未完成文件</h2>
      <p>只处理这次记录中失败、取消或未完成的文件。已送达但删源失败的文件需先人工检查。</p>
      <label className="row">重试目标目录 <input value={dest} disabled={sending} onChange={(event) => setDest(event.target.value)} /></label>
      <label><input type="checkbox" checked={move} disabled={sending} onChange={(event) => { setMove(event.target.checked); setConfirm(''); }} />
        移动重试（会删除源文件）</label>
      {move && <label className="row">输入历史记录中“待重试”的文件数
        <input aria-label="重试移动确认数量" value={confirm} disabled={sending} onChange={(event) => setConfirm(event.target.value)} /></label>}
      {error && <p className="error">{error}</p>}
      <div className="modal-actions"><button disabled={sending} onClick={() => setRetry(null)}>取消</button>
        <button className="primary" disabled={busy || !dest || (move && Number(confirm) !== retry.retryCount)}
          onClick={() => void startRetry()}>{sending ? '正在提交…' : '开始重试'}</button></div>
    </div></div>}
  </section>;
}
