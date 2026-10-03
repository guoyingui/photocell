import { useEffect, useState } from 'react';
import { deleteJSON, getJSON, getSessionId } from '../lib/api';
import { invalidateThumbCache } from '../lib/thumbSource';
interface Stats { files: number; bytes: number }
export function CacheSettings() {
  const [stats, setStats] = useState<Stats | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  useEffect(() => {
    let alive = true;
    void getJSON<Stats>('/api/library/cache').then((data) => { if (alive) setStats(data); }).catch((err) => { if (alive) setError((err as Error).message); });
    return () => { alive = false; };
  }, []);
  const clear = async () => {
    const sid = getSessionId(); setBusy(true); setError(''); setMessage('');
    try {
      const result = await deleteJSON<Stats & { removed: Stats }>('/api/library/cache');
      if (getSessionId() !== sid) return;
      setStats(result); invalidateThumbCache(); setMessage(`已清理 ${result.removed.files} 个缓存文件，释放 ${(result.removed.bytes / 1024 / 1024).toFixed(1)} MB`);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="cache-settings"><h3>预览缓存</h3>
    <p>{stats ? `${stats.files} 个文件 · ${(stats.bytes / 1024 / 1024).toFixed(1)} MB` : '正在读取缓存大小…'}</p>
    <p className="muted">清理当前目录的缩略图和 RAW 内嵌预览，下次查看时重新生成。照片、标记、备注、后期信息和导出历史会保留。</p>
    {error && <p className="error">{error}</p>}{message && <p role="status">{message}</p>}
    <button disabled={busy || !stats} onClick={() => void clear()}>{busy ? '正在清理…' : '清理当前目录的预览缓存'}</button>
  </section>;
}
