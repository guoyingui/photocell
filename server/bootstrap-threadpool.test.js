import { describe, it, expect, vi, afterEach } from 'vitest';

// 分诊项 a：这个池子是**全局**的 libuv 线程池，除了 sharp 还服务 walk 的每文件 stat、
// exifr 读取和 export 的 copyFile。以前写的是 max(1, 核数-1)，在核数 ≤ 4 的机器上会把
// 它缩到比 Node 自己的默认值 4 还小——扫描、元数据、导出全都跟着变慢，而这恰恰是最
// 承受不起变慢的那类机器。
//
// 直接断言当前机器上的实际值是抓不住这个 bug 的：开发机是 12 核，max(1,11) 和
// max(4,11) 都等于 11，改坏了也看不出来。所以这里把 os.cpus() 换成假的，
// 把小核数机器真正跑一遍。
const load = async (cpuCount) => {
  vi.resetModules();
  vi.doMock('node:os', () => ({
    default: { cpus: () => new Array(cpuCount).fill({ model: 'fake' }) },
  }));
  await import('./bootstrap-threadpool.js');
  return Number(process.env.UV_THREADPOOL_SIZE);
};

const saved = process.env.UV_THREADPOOL_SIZE;

afterEach(() => {
  vi.doUnmock('node:os');
  vi.resetModules();
  if (saved === undefined) delete process.env.UV_THREADPOOL_SIZE;
  else process.env.UV_THREADPOOL_SIZE = saved;
});

describe('UV_THREADPOOL_SIZE（分诊项 a）', () => {
  it('小核数机器上不会低于 Node 自己的默认值 4', async () => {
    expect(await load(1)).toBe(4);
    expect(await load(2)).toBe(4);
    expect(await load(4)).toBe(4);
  });

  it('核数够多时仍然是"核数 - 1"，给主线程留一个核', async () => {
    expect(await load(8)).toBe(7);
    expect(await load(12)).toBe(11);
  });

  it('五核是分界点：max(4, 核数-1) 从这里开始跟着核数走', async () => {
    expect(await load(5)).toBe(4);
    expect(await load(6)).toBe(5);
  });
});
