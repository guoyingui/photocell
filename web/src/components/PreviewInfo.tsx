import { useEffect, useState } from 'react';
import { getJSON } from '../lib/api';
interface Info { kind: 'raw' | 'jpg' | 'unavailable'; width?: number; height?: number; message?: string }
export function PreviewInfo({ id }: { id: string }) {
  const [info, setInfo] = useState<Info | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let alive = true; setInfo(null); setError('');
    void getJSON<Info>(`/api/preview-info?id=${encodeURIComponent(id)}`).then((data) => { if (alive) setInfo(data); })
      .catch((err) => { if (alive) setError((err as Error).message); });
    return () => { alive = false; };
  }, [id]);
  return <p className="muted">{error ? `预览信息未能读取：${error}` : !info ? '正在检查 RAW 预览…'
    : info.kind === 'unavailable' ? info.message : `RAW 内嵌 JPEG：${info.width} × ${info.height}。100% 查看以此预览的像素为准。`}</p>;
}
