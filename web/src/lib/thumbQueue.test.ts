import { describe, it, expect } from 'vitest';
import { createThumbQueue } from './thumbQueue';

/** 可控的假 fetch：记录调用顺序，手动 resolve。 */
function makeFetch() {
  const calls: string[] = [];
  const pending = new Map<string, (blob: Blob) => void>();
  const rejects = new Map<string, (err: Error) => void>();

  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push(url);
    return new Promise((resolve, reject) => {
      pending.set(url, (blob) => resolve({ ok: true, blob: async () => blob } as Response));
      rejects.set(url, reject);
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  }) as unknown as typeof fetch;

  return {
    fetchImpl, calls,
    finish: (url: string) => pending.get(url)?.(new Blob(['x'])),
    fail: (url: string) => rejects.get(url)?.(new Error('boom')),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createThumbQueue', () => {
  it('并发数达到上限后其余请求排队', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 2, fetchImpl: f.fetchImpl });
    for (let i = 0; i < 5; i++) void q.request(`k${i}`, `/u${i}`, i);
    await tick();
    expect(f.calls).toHaveLength(2);
    expect(q.active).toBe(2);
    expect(q.pending).toBe(3);
  });

  it('一个完成后自动放行下一个', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 1, fetchImpl: f.fetchImpl });
    void q.request('a', '/a', 0);
    void q.request('b', '/b', 0);
    await tick();
    expect(f.calls).toEqual(['/a']);
    f.finish('/a');
    await tick();
    expect(f.calls).toEqual(['/a', '/b']);
  });

  it('优先级数值小的先出队', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 1, fetchImpl: f.fetchImpl });
    void q.request('block', '/block', 0);
    await tick();
    void q.request('far', '/far', 900);
    void q.request('near', '/near', 5);
    f.finish('/block');
    await tick();
    expect(f.calls[1]).toBe('/near');
  });

  it('reprioritize 会重排还在排队的项', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 1, fetchImpl: f.fetchImpl });
    void q.request('block', '/block', 0);
    await tick();
    void q.request('a', '/a', 10);
    void q.request('b', '/b', 20);
    q.reprioritize((key) => (key === 'b' ? 1 : 999));   // 滚动后 b 进了视口中心
    f.finish('/block');
    await tick();
    expect(f.calls[1]).toBe('/b');
  });

  it('cancel 排队中的项使其出队且 promise 以 AbortError 拒绝', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 1, fetchImpl: f.fetchImpl });
    void q.request('block', '/block', 0);
    await tick();
    const p = q.request('gone', '/gone', 1);
    expect(q.pending).toBe(1);
    q.cancel('gone');
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(q.pending).toBe(0);
    f.finish('/block');
    await tick();
    expect(f.calls).toEqual(['/block']);   // 被取消的那个从未发出请求
  });

  it('cancel 进行中的项会 abort 网络请求', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 2, fetchImpl: f.fetchImpl });
    const p = q.request('a', '/a', 0);
    await tick();
    expect(q.active).toBe(1);
    q.cancel('a');
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(q.active).toBe(0);
  });

  it('取消进行中的项后队列继续放行下一个', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 1, fetchImpl: f.fetchImpl });
    void q.request('a', '/a', 0).catch(() => {});
    void q.request('b', '/b', 1);
    await tick();
    q.cancel('a');
    await tick();
    expect(f.calls).toEqual(['/a', '/b']);
  });

  it('cancel 进行中的项后同一 tick 内立刻用同一 key 重新 request 会发起新请求，而不是复用那个注定失败的 promise', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 2, fetchImpl: f.fetchImpl });
    const p1 = q.request('a', '/a', 0);
    await tick();
    expect(q.active).toBe(1);

    q.cancel('a');
    // 紧跟 cancel 之后同步挂上处理器（而不是等到后面再 await），
    // 避免 p1 在没有处理器的情况下先 reject，触发 unhandled rejection。
    const p1Rejection = expect(p1).rejects.toMatchObject({ name: 'AbortError' });
    const p2 = q.request('a', '/a', 0);   // 同一 tick 内立刻重新请求同一个 key

    expect(p2).not.toBe(p1);              // 拿到的是一个全新的 promise
    await tick();
    expect(f.calls).toEqual(['/a', '/a']); // 真的发出了第二次网络请求

    await p1Rejection;                     // 旧请求仍以取消收场
    f.finish('/a');                        // 让新请求成功
    expect(await p2).toBeInstanceOf(Blob); // 新请求能正常 resolve，缩略图不会永远空白
  });

  it('同一 key 重复请求复用同一个 promise，只发一次网络请求', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 4, fetchImpl: f.fetchImpl });
    const p1 = q.request('a', '/a', 0);
    const p2 = q.request('a', '/a', 0);
    await tick();
    expect(f.calls).toHaveLength(1);
    f.finish('/a');
    expect(await p1).toBe(await p2);
  });

  it('请求成功时 resolve 出 Blob', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 1, fetchImpl: f.fetchImpl });
    const p = q.request('a', '/a', 0);
    await tick();
    f.finish('/a');
    expect(await p).toBeInstanceOf(Blob);
  });

  it('请求失败时 reject 且不卡死队列', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 1, fetchImpl: f.fetchImpl });
    const p = q.request('a', '/a', 0).catch((e) => e);
    void q.request('b', '/b', 1);
    await tick();
    f.fail('/a');
    await p;
    await tick();
    expect(f.calls).toEqual(['/a', '/b']);
    expect(q.active).toBe(1);
  });

  it('cancel 不存在的 key 不报错', () => {
    const q = createThumbQueue({ concurrency: 1, fetchImpl: makeFetch().fetchImpl });
    expect(() => q.cancel('ghost')).not.toThrow();
  });

  it('大量入队后并发始终不超过上限', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 6, fetchImpl: f.fetchImpl });
    for (let i = 0; i < 500; i++) void q.request(`k${i}`, `/u${i}`, i).catch(() => {});
    await tick();
    expect(q.active).toBe(6);
    expect(f.calls).toHaveLength(6);
  });

  describe('非法 concurrency 在构造时就拒绝', () => {
    // 负数 / 0：pump() 的放行条件 `running.size < concurrency` 永远为 false，
    // 排队的条目永远不会被挑出来运行，promise 永远不 resolve/reject —— 是一个
    // 没有任何报错信号的静默永久挂起。这里只断言 createThumbQueue(...) 本身
    // 同步抛出——如果守卫写错了，这条断言不会失败，而是让整个测试进程挂起，
    // 看不到失败输出（比 blobCache 的死循环更隐蔽：那边至少会占满一个线程转起来）。
    it('负数抛出', () => {
      expect(() => createThumbQueue({ concurrency: -1 })).toThrow(RangeError);
    });

    it('零抛出', () => {
      expect(() => createThumbQueue({ concurrency: 0 })).toThrow(RangeError);
    });

    // NaN 与任何数比较都是 false，同样会让 pump() 的放行条件永不成立。
    it('NaN 抛出', () => {
      expect(() => createThumbQueue({ concurrency: NaN })).toThrow(RangeError);
    });

    it('非整数抛出', () => {
      expect(() => createThumbQueue({ concurrency: 1.5 })).toThrow(RangeError);
    });

    it('非 number 类型抛出', () => {
      expect(() => createThumbQueue({ concurrency: '6' as unknown as number })).toThrow(RangeError);
    });

    it('合法并发数（正整数）不抛出', () => {
      expect(() => createThumbQueue({ concurrency: 6 })).not.toThrow();
    });
  });
});
