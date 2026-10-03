import { basename } from './pathname';

/**
 * 拖拽路径识别与名称定位（规格 §3.4）。
 *
 * **浏览器给不了绝对路径。** `File.path` 是 Electron 才有的东西；
 * `webkitRelativePath` 只给到「相对于被拖入的那个文件夹」的路径；
 * `FileSystemDirectoryEntry.fullPath` 是一个虚拟路径（`/foldername`）。
 * 这是「浏览器 + 本机服务」这个架构的天花板，不是写法问题。
 *
 * 名称定位只比对已有数据，候选必须由用户确认。少数系统提供真实 file URI 时，
 * absoluteFolderFromDrop 可识别完整路径，由开库接口继续校验路径边界。
 */

export type DropHit =
  | { kind: 'recent'; path: string }
  | { kind: 'listed'; path: string }
  | { kind: 'none' };

/**
 * 拖进来的名字落在哪。
 *
 * 最近打开优先于当前目录：那是一条用户上次真的从那儿开过的完整路径，
 * 而当前目录里的同名子目录只是碰巧叫这个名字。
 */
export function locate(
  name: string,
  recent: string[],
  listed: { name: string; path: string }[],
): DropHit {
  const hitRecent = recent.find((p) => basename(p) === name);
  if (hitRecent !== undefined) return { kind: 'recent', path: hitRecent };

  const hitListed = listed.find((d) => d.name === name);
  if (hitListed !== undefined) return { kind: 'listed', path: hitListed.path };

  return { kind: 'none' };
}

export type DropRead =
  | { name: string; notice?: string }
  | { error: string };

/** 有些系统会给出真实 file:// URI；仅这条通道可直接打开，虚拟 entry.fullPath 不可用。 */
export function absoluteFolderFromDrop(dt: DataTransfer): string | null {
  const dirs = Array.from(dt.items ?? []).map((item) => item.webkitGetAsEntry?.()).filter((entry) => entry?.isDirectory);
  if (dirs.length !== 1) return null;
  const values = (dt.getData?.('text/uri-list') ?? '').split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
  if (values.length !== 1) return null;
  try {
    const url = new URL(values[0]);
    if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return null;
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes('\0')) return null;
    return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1).replaceAll('/', '\\') : pathname;
  } catch { return null; }
}

const UNRECOGNIZED = '没能识别拖入的内容，请改用下面的目录浏览器';

/**
 * 从一次 drop 里读出文件夹名。
 *
 * `webkitGetAsEntry()` 只用来问两件事：这是不是目录、它叫什么。
 * **不读任何文件内容**——一个三千张 RAW 的文件夹，遍历它的 entries
 * 要花的时间和它能换来的信息完全不成比例（换来的仍然不是绝对路径）。
 */
export function folderNameFromDrop(dt: DataTransfer): DropRead {
  const items = Array.from(dt.items ?? []);
  const entries = items
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((e): e is FileSystemEntry => e !== null);

  if (entries.length === 0) return { error: UNRECOGNIZED };

  const dirs = entries.filter((e) => e.isDirectory);
  if (dirs.length === 0) return { error: '请拖入文件夹，不是文件' };

  if (dirs.length > 1) {
    return { name: dirs[0].name, notice: `一次只能打开一个文件夹，已按「${dirs[0].name}」定位` };
  }
  return { name: dirs[0].name };
}
