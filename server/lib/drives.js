import fs from 'node:fs/promises';
import os from 'node:os';

/**
 * Windows 盘符枚举。
 *
 * **不用 `wmic`**（Windows 11 已经移除了它），**不起子进程**——一个纯 `fs`
 * 调用能解决的事不值得引入 `child_process` 的错误处理面。26 次 readdir
 * 并行跑，能列出内容的就算一个可浏览的根。
 */

export const DRIVE_LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

/**
 * 单个盘符的探测超时。未插盘的光驱、断开的网络驱动器会挂很久。
 *
 * 2000 而不是原来的 400：两种失败的代价**极不对称**。超时太短的后果是一块
 * 刚从休眠里唤醒的 USB 盘（首次访问 1-2 秒很常见）被判成"不可读"，从选择器里
 * 整个消失——用户的照片就在那块盘上，而界面不会给他任何线索说明为什么 D: 不见了。
 * 超时太长的后果只是选择器多转几秒。
 *
 * 之所以敢往上调，是因为「不存在的盘符」根本不吃这个超时：`readdir('E:\\')`
 * 在没有 E 盘时立刻 ENOENT 返回。真正会挂满整个超时的只有**已映射但断开的
 * 网络驱动器**，通常 0-2 个。所以典型机器上这个值几乎不影响实际耗时。
 *
 * 仍然不覆盖的情况：冷启动的 NAS 首次响应可能要 5 秒以上。那种盘这里还是会被
 * 漏掉——继续往上调就要拿"每次打开选择器都可能卡 5 秒"去换，不划算。
 */
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * 探测一个盘符。能 readdir 就返回 `'D:\\'`，否则 null。
 *
 * `readdir` 和 `timeoutMs` 可注入，测试才摆得出「永不返回的驱动器」这种情形——
 * 真实的断开网络驱动器没法在 CI 上复现。
 *
 * 超时用 `Promise.race`：`fs.readdir` 没法中止，那个 promise 会继续跑完。
 * race 在建立时就给两边都挂上了 handler，所以它**之后**才 reject 也不会
 * 变成 unhandled rejection —— 那在 Node 里是要让整个进程崩掉的。
 */
export async function probeDrive(letter, { readdir = fs.readdir, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const root = `${letter}:\\`;
  let timer;
  try {
    await Promise.race([
      readdir(root),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('drive-probe-timeout')), timeoutMs);
      }),
    ]);
    return root;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 全部可读盘符。非 win32 平台返回空数组——调用方因此不需要自己判平台。
 *
 * `platform` 可注入，让测试在 macOS 上也验证得了 win32 分支。
 */
export async function listDrives({ platform = os.platform(), ...opts } = {}) {
  if (platform !== 'win32') return [];
  const probed = await Promise.all(DRIVE_LETTERS.map((l) => probeDrive(l, opts)));
  return probed.filter((p) => p !== null);
}
