import { useFolders } from '../store/folders';
import { useLibrary } from '../store/library';
import { basename } from '../lib/pathname';
import { Sidebar } from './Sidebar';

export function LibrarySidebar({ onAdd, onOpen, onRemove, busyPath }: {
  onAdd: () => void;
  onOpen: (root: string) => void;
  onRemove: (root: string) => void;
  busyPath: string | null;
}) {
  const roots = useFolders((state) => state.roots);
  const storageError = useFolders((state) => state.storageError);
  const root = useLibrary((state) => state.root);
  const phase = useLibrary((state) => state.phase);
  const refreshing = useLibrary((state) => state.refreshing);
  const count = useLibrary((state) => state.assets.length);
  const disabled = busyPath !== null || phase === 'scanning' || refreshing;
  return <aside className="library-sidebar" aria-label="照片目录">
    <div className="library-brand"><strong>PhotoCull</strong><span>照片工作区</span></div>
    <div className="library-sidebar-heading"><h2>照片目录</h2><span className="folder-count">{roots.length}</span></div>
    <button className="btn-folder add-folder" onClick={onAdd} disabled={disabled}>＋ 添加目录</button>
    <nav className="library-folders" aria-label="已添加目录">
      {!roots.length && <p className="muted folder-empty">还没有照片目录。添加后会一直显示在这里。</p>}
      {roots.map((path) => <div key={path} className={`library-folder${root === path ? ' library-folder-active' : ''}`}>
        <div className="library-folder-row">
          <button className="library-folder-open" aria-label={`打开目录 ${path}`} aria-current={root === path ? 'page' : undefined}
            title={path} disabled={disabled} onClick={() => onOpen(path)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></svg>
            <span className="library-folder-text"><strong>{basename(path) || path}</strong><small>{path}</small>
              {(root === path || busyPath === path) && <span className="library-folder-status">{busyPath === path ? '正在处理…' : `当前目录 · ${count} 张`}</span>}
            </span>
          </button>
          <button className="library-folder-remove" aria-label={`从列表移除 ${path}`} title="从列表移除，不删除磁盘文件"
            disabled={disabled} onClick={() => onRemove(path)}>×</button>
        </div>
        {root === path && phase === 'ready' && <Sidebar embedded />}
      </div>)}
    </nav>
    <div className="library-sidebar-footer">
      {storageError && <p className="error" role="status">{storageError}</p>}
      <p className="muted">点击目录切换选片。目录列表保存在当前浏览器。</p>
    </div>
  </aside>;
}
