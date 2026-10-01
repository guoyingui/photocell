import { describe, it, expect, vi, afterEach } from 'vitest';
import { probeDrive, DRIVE_LETTERS } from './drives.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('DRIVE_LETTERS', () => {
  it('是 A 到 Z 共 26 个', () => {
    expect(DRIVE_LETTERS).toHaveLength(26);
    expect(DRIVE_LETTERS[0]).toBe('A');
    expect(DRIVE_LETTERS[25]).toBe('Z');
  });
});

describe('probeDrive', () => {
  it('能列出内容的盘符返回它的根路径', async () => {
    const readdir = vi.fn().mockResolvedValue(['Users']);
    await expect(probeDrive('C', { readdir, timeoutMs: 50 })).resolves.toBe('C:\\');
    expect(readdir).toHaveBeenCalledWith('C:\\');
  });

  it('列不出来的盘符返回 null', async () => {
    const readdir = vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }));
    await expect(probeDrive('B', { readdir, timeoutMs: 50 })).resolves.toBeNull();
  });

  it('超时的盘符返回 null，不把整趟枚举卡住', async () => {
    // 未插盘的光驱、断开的网络驱动器会让 readdir 挂很久。
    const readdir = vi.fn(() => new Promise(() => {}));   // 永不 settle
    await expect(probeDrive('Z', { readdir, timeoutMs: 20 })).resolves.toBeNull();
  });

  it('超时之后原来那个 promise later reject 不会变成 unhandled rejection', async () => {
    let rejectIt;
    const readdir = vi.fn(() => new Promise((_, rej) => { rejectIt = rej; }));

    // 用来验证没有 unhandled rejection 的 handler
    const unhandledRejectionHandler = vi.fn();
    process.on('unhandledRejection', unhandledRejectionHandler);

    try {
      const result = await probeDrive('Z', { readdir, timeoutMs: 20 });
      expect(result).toBeNull();
      rejectIt(new Error('迟到的失败'));
      // 给微任务队列一个回合；没有 handler 的话 node 会在这里炸
      await new Promise((r) => setTimeout(r, 10));

      // 验证没有 unhandled rejection
      expect(unhandledRejectionHandler).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandledRejectionHandler);
    }
  });
});

describe('默认超时', () => {
  // 这个常量此前没有任何用例守着：上面每一条都注入自己的 timeoutMs，
  // 把默认值改成 1 或者 100000 都不会让任何一条变红。而它决定的是一件
  // 用户看得见的事——一块刚从休眠里唤醒的 USB 盘要不要被判成"不可读"。
  it('等得到一块 1 秒才响应的盘（刚唤醒的 USB 盘很常见）', async () => {
    vi.useFakeTimers();
    try {
      const readdir = () => new Promise((resolve) => setTimeout(() => resolve([]), 1000));
      const probing = probeDrive('D', { readdir });   // 不传 timeoutMs，走默认值
      await vi.advanceTimersByTimeAsync(1000);
      // 默认值要是回到 400，这里拿到的是 null：那块盘会从选择器里整个消失，
      // 而界面不会给用户任何线索说明为什么 D: 不见了。
      await expect(probing).resolves.toBe('D:\\');
    } finally {
      vi.useRealTimers();
    }
  });

  it('但不会无限等下去：挂住不返回的盘仍然被剔除', async () => {
    vi.useFakeTimers();
    try {
      const probing = probeDrive('Z', { readdir: () => new Promise(() => {}) });
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(probing).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
