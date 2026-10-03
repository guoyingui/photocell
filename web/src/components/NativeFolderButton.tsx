import { useEffect, useState } from 'react';
import { getJSON, postJSON } from '../lib/api';

export function NativeFolderButton({ onChoose, disabled = false }: { onChoose: (path: string) => void; disabled?: boolean }) {
  const [available, setAvailable] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void getJSON<{ available: boolean }>('/api/fs/native-folder').then((data) => { if (alive) setAvailable(data.available); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!available) return null;
  const choose = async () => {
    setBusy(true); setError('');
    try { const result = await postJSON<{ path: string | null }>('/api/fs/native-folder', { open: true }); if (result.path) onChoose(result.path); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return <><button disabled={disabled || busy} onClick={() => void choose()}>{busy ? '请在系统窗口中选择…' : '系统选择文件夹…'}</button>
    {error && <span className="error">{error}</span>}</>;
}
