import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getJSON } from '../lib/api';
import { atRootBoundary, fetchRoots, type FsRoot } from '../lib/fsRoots';

interface Listing { path: string; parent: string; dirs: { name: string; path: string }[] }

interface Props {
  /** 每次导航后回报当前所在目录。父组件决定「当前目录」意味着什么。 */
  onLocationChange: (path: string) => void;
  maxHeight?: number;
  /** 每行右侧的额外操作，比如 FolderPicker 的「直接打开」。 */
  rowAction?: (dir: { name: string; path: string }) => ReactNode;
  /** 拖进来的文件夹名。同名的子目录会被高亮，每导航一层都重新判一次。 */
  highlightName?: string;
  /** 外部要求跳转到的路径。变一次跳一次；不变时不重复导航。 */
  gotoPath?: string;
  /** 当前列出的子目录，供父组件做拖拽定位的比对。 */
  onListingChange?: (dirs: { name: string; path: string }[]) => void;
}

export function DirBrowser({
  onLocationChange, maxHeight = 260, rowAction, highlightName, gotoPath, onListingChange,
}: Props) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 给每次导航发一个递增的请求号。只有仍是"最新一次"发出的请求，
  // 其响应才允许写 state——避免慢响应的旧请求在快响应的新请求之后到达时覆盖它。
  const requestSeq = useRef(0);

  const browse = async (path?: string) => {
    const myRequest = ++requestSeq.current;
    setError(null);
    try {
      const next = await getJSON<Listing>(
        `/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`);
      if (myRequest !== requestSeq.current) return; // 已经被更新的一次导航取代
      setListing(next);
      onLocationChange(next.path);
      onListingChange?.(next.dirs);
    } catch (e) {
      if (myRequest !== requestSeq.current) return;
      setError((e as Error).message);
    }
  };

  useEffect(() => { void browse(); }, []);

  // gotoPath 变化时跳一次。用 ref 记住上一次的值而不是把 gotoPath 直接放进
  // 依赖数组——父组件重渲染时传下来的可能是同一个字符串，但用户可能已经
  // 手动导航去了别处，那时再跳一次就是把他拽回来。
  const lastGoto = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!gotoPath || gotoPath === lastGoto.current) return;
    lastGoto.current = gotoPath;
    void browse(gotoPath);
  }, [gotoPath]);

  // 主用例就是"照片在读卡器 / 移动硬盘上"。没有这排快捷入口，用户只能从 $HOME
  // 一级一级往上点，而"上级"一旦离开 $HOME 就 403——等于走不到 /Volumes。
  // 拿不到根列表不算错误：手动输入路径和逐级浏览都还能用，安静降级即可。
  useEffect(() => {
    let alive = true;
    void fetchRoots()
      .then((r) => { if (alive) setRoots(r.roots); })
      .catch(() => { /* 快捷入口是锦上添花，失败不打断浏览 */ });
    return () => { alive = false; };
  }, []);

  // 到达当前所在根的边界时禁用"上级"，而不是让用户点出一个看起来像 bug 的 403。
  // 根列表还没到（或拿不到）时保持原来的行为，不凭空多禁用一个按钮。
  const atBoundary = listing === null ? true
    : roots.length === 0 ? false
      : atRootBoundary(listing.path, roots);

  return (
    <div className="dirbrowser">
      {roots.length > 0 && (
        <div className="dirbrowser-roots">
          {roots.map((r) => (
            <button key={r.path} className="ghost dirbrowser-root"
                    onClick={() => void browse(r.path)} title={r.path}>
              {r.label}
            </button>
          ))}
        </div>
      )}

      <div className="dirbrowser-path">
        <button onClick={() => listing && void browse(listing.parent)}
                disabled={!listing || atBoundary}
                title={atBoundary ? '已经是可访问范围的最上层' : '上一级目录'}>上级</button>
        <code>{listing?.path ?? '…'}</code>
      </div>
      <ul className="dirbrowser-list" style={{ maxHeight }}>
        {listing?.dirs.map((d) => (
          <li key={d.path} className={highlightName && d.name === highlightName ? 'dirbrowser-hit' : undefined}>
            <button className="dirbrowser-name" onClick={() => void browse(d.path)}>{d.name}</button>
            {rowAction?.(d)}
          </li>
        ))}
        {listing?.dirs.length === 0 && <li className="muted">（没有子文件夹）</li>}
      </ul>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
