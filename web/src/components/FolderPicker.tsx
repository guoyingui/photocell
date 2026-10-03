import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { getJSON } from '../lib/api';
import { absoluteFolderFromDrop, folderNameFromDrop, locate, type DropHit } from '../lib/dropLocate';
import { useDialogFocus } from '../lib/useDialogFocus';
import { DirBrowser } from './DirBrowser';
import { NativeFolderButton } from './NativeFolderButton';

export function FolderPicker({ existing, onAdd, onClose }: {
  existing: string[];
  onAdd: (roots: string[]) => void;
  onClose: () => void;
}) {
  const [here, setHere] = useState('');
  const [manual, setManual] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dropName, setDropName] = useState<string | null>(null);
  const [dropHit, setDropHit] = useState<DropHit>({ kind: 'none' });
  const [dropNotice, setDropNotice] = useState('');
  const [listed, setListed] = useState<{ name: string; path: string }[]>([]);
  const ref = useDialogFocus(onClose);
  const request = useRef(0);
  const saving = useRef(false);
  useEffect(() => () => { request.current++; }, []);
  const queue = (paths: string[]) => {
    setSelected((old) => [...new Set([...old, ...paths].filter((path) => path && !existing.includes(path)))]);
    setError('');
  };
  const toggle = (path: string) => setSelected((old) => old.includes(path) ? old.filter((item) => item !== path) : [...old, path]);
  const onDrop = (event: ReactDragEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(''); setDropNotice(''); setDropHit({ kind: 'none' }); setDropName(null);
    const absolute = absoluteFolderFromDrop(event.dataTransfer);
    if (absolute) { queue([absolute]); return; }
    const read = folderNameFromDrop(event.dataTransfer);
    if ('error' in read) { setError(read.error); return; }
    setDropName(read.name);
    setDropNotice(read.notice ?? '');
    setDropHit(locate(read.name, existing, listed));
  };
  const submit = async () => {
    if (saving.current || !selected.length) return;
    saving.current = true; setBusy(true); setError('');
    const version = ++request.current;
    try {
      // 复用服务端目录边界校验，并拿真实路径去重；这里不扫描照片，也不开关当前库。
      const canonical: string[] = [];
      for (let offset = 0; offset < selected.length; offset += 4) {
        const batch = await Promise.all(selected.slice(offset, offset + 4).map(async (path) => {
          try {
            const result = await getJSON<{ path: string }>(`/api/fs/list?path=${encodeURIComponent(path)}`);
            return result.path;
          } catch (err) { throw new Error(`${path}：${(err as Error).message}`); }
        }));
        if (version !== request.current) return;
        canonical.push(...batch);
      }
      onAdd([...new Set(canonical)]);
      onClose();
    } catch (err) { if (version === request.current) setError((err as Error).message); }
    finally { if (version === request.current) { saving.current = false; setBusy(false); } }
  };
  return <div className="modal"><div ref={ref} className="modal-box folder-picker" role="dialog" aria-modal="true" aria-label="添加照片目录" tabIndex={-1}
    data-testid="picker-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
    <h2>添加照片目录</h2>
    <p className="muted">可以选择多个目录，也可以跨文件夹逐个加入。添加后在左侧点击目录开始选片。</p>
    {dropNotice && <p className="picker-drop">{dropNotice}</p>}
    {dropName && dropHit.kind !== 'none' && <div className="picker-drop picker-drop-hit">
      找到了「{dropName}」：<code>{dropHit.path}</code>
      <button disabled={busy || existing.includes(dropHit.path) || selected.includes(dropHit.path)} onClick={() => queue([dropHit.path])}>
        {existing.includes(dropHit.path) ? '已添加' : '加入待添加'}
      </button>
    </div>}
    {dropName && dropHit.kind === 'none' && <p className="picker-drop">浏览器只提供了「{dropName}」的名字，请在下面定位目录或粘贴完整路径。</p>}
    <DirBrowser onLocationChange={setHere} onListingChange={setListed} highlightName={dropName ?? undefined}
      gotoPath={dropHit.kind === 'listed' ? dropHit.path : undefined} maxHeight={220}
      rowAction={(dir) => <label className="folder-pick-option"><input type="checkbox" aria-label={`选择目录 ${dir.path}`}
        disabled={busy || existing.includes(dir.path)} checked={existing.includes(dir.path) || selected.includes(dir.path)}
        onChange={() => toggle(dir.path)} />{existing.includes(dir.path) ? '已添加' : '选择'}</label>} />
    <div className="picker-actions">
      <NativeFolderButton disabled={busy} onChoose={(path) => queue([path])} />
      <button disabled={busy || !here || existing.includes(here)} onClick={() => toggle(here)}>
        {existing.includes(here) ? '当前目录已添加' : selected.includes(here) ? '取消选择当前目录' : '选择当前目录'}
      </button>
    </div>
    <form className="picker-manual" onSubmit={(event) => { event.preventDefault(); queue(manual.split(/\r?\n/).map((path) => path.trim())); setManual(''); }}>
      <label>目录完整路径<textarea value={manual} disabled={busy} placeholder="粘贴绝对路径，每行一个目录" onChange={(event) => setManual(event.target.value)} /></label>
      <button disabled={busy || !manual.trim()} type="submit">加入待添加</button>
    </form>
    {selected.length > 0 && <div className="pending-folders" aria-label="待添加目录">
      <strong>待添加 {selected.length} 个目录</strong>
      <ul>{selected.map((path) => <li key={path}><code>{path}</code><button aria-label={`取消添加 ${path}`} disabled={busy}
        onClick={() => toggle(path)}>×</button></li>)}</ul>
    </div>}
    {error && <p className="error folder-add-error" role="alert">{error}</p>}
    <div className="modal-actions"><button onClick={onClose}>取消</button><button className="primary" disabled={busy || !selected.length}
      onClick={() => void submit()}>{busy ? '正在检查目录…' : `添加 ${selected.length} 个目录`}</button></div>
  </div></div>;
}
