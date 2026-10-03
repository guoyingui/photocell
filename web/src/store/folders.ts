import { create } from 'zustand';
import { readRecent } from '../lib/recent';

const KEY = 'photocull.folders.v1';
const LIMIT = 100;
interface SavedFolders { roots: string[]; lastRoot: string | null }

function paths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((path): path is string => typeof path === 'string'
    && path.length > 0 && path.length <= 4096 && !path.includes('\0')
    && (/^\//.test(path) || /^[A-Za-z]:[/\\]/.test(path) || /^\\\\[^\\]+\\/.test(path))))];
}

export function readFolders(): SavedFolders {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw !== null) {
      const saved = JSON.parse(raw);
      const roots = paths(saved?.roots);
      return { roots, lastRoot: roots.includes(saved?.lastRoot) ? saved.lastRoot : null };
    }
  } catch { /* 损坏的新记录降级为旧版最近打开列表。 */ }
  const roots = paths(readRecent());
  return { roots, lastRoot: roots[0] ?? null };
}

interface FoldersState extends SavedFolders {
  storageError: string;
  reload: () => SavedFolders;
  add: (roots: string[]) => void;
  remove: (root: string) => void;
  opened: (root: string, requested?: string) => void;
}

export const useFolders = create<FoldersState>((set, get) => {
  const save = (next: SavedFolders) => {
    let storageError = '';
    try { localStorage.setItem(KEY, JSON.stringify(next)); }
    catch { storageError = '浏览器未能保存目录列表，本次仍可使用；请检查浏览器存储设置。'; }
    set({ ...next, storageError });
  };
  return {
    ...readFolders(), storageError: '',
    reload() { const saved = readFolders(); set({ ...saved, storageError: '' }); return saved; },
    add(roots) {
      const next = paths([...get().roots, ...roots]);
      if (next.length > LIMIT) throw new Error('最多保存 100 个目录，请先移除不用的目录。');
      save({ roots: next, lastRoot: get().lastRoot });
    },
    remove(root) {
      save({ roots: get().roots.filter((path) => path !== root), lastRoot: get().lastRoot === root ? null : get().lastRoot });
    },
    opened(root, requested) {
      // 服务端返回真实路径后合并旧路径别名，保留列表顺序。
      const roots = paths([...get().roots.map((path) => path === requested ? root : path), root]);
      save({ roots, lastRoot: root });
    },
  };
});
