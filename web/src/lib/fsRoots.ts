import { getJSON } from './api';
import { within } from './pathname';

export interface FsRoot { path: string; label: string }

/**
 * 可浏览的根：$HOME 加上各外接卷。服务端早就提供了这个端点（并且已经正确剔除了
 * 指向 / 的 Macintosh HD 别名），但前端从来没调用过——照片在读卡器或移动硬盘上时，
 * 目录浏览器的"上级"一离开 $HOME 就 403，只能靠手动粘贴绝对路径。
 */
export const fetchRoots = () => getJSON<{ roots: FsRoot[]; home: string }>('/api/fs/roots');

/**
 * 当前路径属于哪个根；不属于任何一个返回 null。
 * 取最长匹配——外接卷可能挂在 /Volumes 下，而 /Volumes 本身也可能是一个根。
 *
 * 必须比对整个路径段，不能用裸 startsWith：/Users/guoyg2 不在 /Users/guoyg 之内。
 */
export function containingRoot(p: string, roots: FsRoot[]): string | null {
  let best: string | null = null;
  for (const { path } of roots) {
    if (within(p, path) && (best === null || path.length > best.length)) best = path;
  }
  return best;
}

/**
 * 已经站在所在根的边界上——再点"上级"就会被服务端 403。
 * 不属于任何根时也算边界（往上只会更糟），按钮直接禁用，比抛一个看起来像 bug 的
 * 403 要诚实。
 */
export function atRootBoundary(p: string, roots: FsRoot[]): boolean {
  const root = containingRoot(p, roots);
  return root === null || root === p;
}
