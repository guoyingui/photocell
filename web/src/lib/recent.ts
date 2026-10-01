/**
 * 「最近打开」的 MRU 列表。存在 localStorage 里，只对这一台机器的这一个浏览器
 * 有意义——它不是选片数据，不跟着照片文件夹走。
 *
 * 从 FolderPicker 里搬出来的。搬的理由是那个组件一渲染就会拉起 DirBrowser，
 * 而 DirBrowser 挂载即发两个请求；把这段纯逻辑留在组件里，就只能靠渲染整棵树、
 * 连带替身掉整个 api 模块才测得到。
 *
 * 三个函数都返回**写入后的新列表**，让调用方直接 setState，
 * 不必再读一次 localStorage（也就不会读到一次失败的写留下的旧值）。
 */
const KEY = 'photocull.recent';
const LIMIT = 8;

function write(list: string[]): string[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // 配额超限、隐私模式，以及 localStorage 整个不存在的环境。一律吞掉：
    // 记住"最近打开"是锦上添花，不能因此挡住打开文件夹这条主流程。
  }
  return list;
}

/**
 * 读出来的东西**必须当成不可信输入**：localStorage 里的内容任何人用开发者工具
 * 都能改，而这个函数的签名声称返回 `string[]`。所以除了"解析失败 / 不是数组"
 * 之外，还要把数组里的非字符串元素滤掉——否则那句返回类型就是一行谎话。
 */
export function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    return [];
  }
}

/** 置顶 + 去重 + 截断到 8 条。 */
export function rememberRecent(root: string): string[] {
  return write([root, ...readRecent().filter((p) => p !== root)].slice(0, LIMIT));
}

/** 从列表里移除一条。**只动这份记录，不碰磁盘上的文件夹。** */
export function forgetRecent(root: string): string[] {
  return write(readRecent().filter((p) => p !== root));
}
