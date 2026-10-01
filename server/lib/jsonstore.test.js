import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJson, withFileLock } from './jsonstore.js';

let dir;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-json-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('writeJson', () => {
  it('写入是原子的：过程中不存在半截的目标文件', async () => {
    const file = path.join(dir, 'x.json');
    await writeJson(file, { a: 1 });
    // 目录里除了目标文件和 .bak，不得残留任何 .tmp
    const left = (await fs.readdir(dir)).filter((n) => n.includes('.tmp'));
    expect(left).toEqual([]);
  });

  it('写入内容可以被原样读回', async () => {
    const file = path.join(dir, 'x.json');
    await writeJson(file, { a: 1, nested: { b: [1, 2, 3] } });
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(raw).toEqual({ a: 1, nested: { b: [1, 2, 3] } });
  });

  it('第二次写入前，把现有文件轮转成 .bak', async () => {
    const file = path.join(dir, 'x.json');
    await writeJson(file, { v: 1 });
    await writeJson(file, { v: 2 });
    const bak = JSON.parse(await fs.readFile(`${file}.bak`, 'utf8'));
    expect(bak).toEqual({ v: 1 });
    const main = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(main).toEqual({ v: 2 });
  });

  it('第一次写入时没有旧文件可轮转，不报错', async () => {
    const file = path.join(dir, 'x.json');
    await expect(writeJson(file, { v: 1 })).resolves.toBeUndefined();
    await expect(fs.access(`${file}.bak`)).rejects.toThrow();
  });

  // rename 之前必须 fsync：否则崩溃后可能得到一个长度正确但内容为零的文件。
  // 用 spy 包一层 handle.sync，断言它确实先于任何 rename 被调用——
  // 这是能让"删掉 handle.sync() 会变红"这句话成立的唯一办法，
  // 因为正常执行路径下少了 fsync 并不会产生任何可观察的功能性差异。
  it('落盘顺序：写入 -> fsync -> rename（用 spy 断言调用顺序）', async () => {
    const file = path.join(dir, 'order.json');
    const calls = [];
    const originalOpen = fs.open.bind(fs);
    const originalRename = fs.rename.bind(fs);

    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const originalSync = handle.sync.bind(handle);
      handle.sync = async (...a) => {
        calls.push('sync');
        return originalSync(...a);
      };
      return handle;
    });
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      calls.push('rename');
      return originalRename(...args);
    });

    try {
      await writeJson(file, { a: 1 });
    } finally {
      openSpy.mockRestore();
      renameSpy.mockRestore();
    }

    expect(calls[0]).toBe('sync');
    expect(calls.slice(1).every((c) => c === 'rename')).toBe(true);
    expect(calls.includes('rename')).toBe(true);
  });
});

describe('readJson', () => {
  it('文件完全不存在时返回 fallback，不抛错', async () => {
    const file = path.join(dir, 'missing.json');
    expect(await readJson(file, { empty: true })).toEqual({ empty: true });
  });

  it('主文件损坏时回退 .bak', async () => {
    const file = path.join(dir, 'x.json');
    await writeJson(file, { v: 1 });
    await writeJson(file, { v: 2 });          // v1 轮转进 .bak
    await fs.writeFile(file, '{ 这不是 JSON', 'utf8');
    expect(await readJson(file, null)).toEqual({ v: 1 });
  });

  it('主文件和 .bak 都坏时返回 fallback，而不是抛错', async () => {
    const file = path.join(dir, 'x.json');
    await fs.writeFile(file, 'x', 'utf8');
    await fs.writeFile(`${file}.bak`, 'y', 'utf8');
    expect(await readJson(file, { empty: true })).toEqual({ empty: true });
  });

  it('主文件存在且正常时不去读 .bak', async () => {
    const file = path.join(dir, 'x.json');
    await writeJson(file, { v: 'main' });
    await fs.writeFile(`${file}.bak`, JSON.stringify({ v: 'bak' }), 'utf8');
    expect(await readJson(file, null)).toEqual({ v: 'main' });
  });
});

// withFileLock 存在的唯一理由：writeJson 本身的原子性只保证单次落盘不会读到
// 半截文件，管不住"读 JSON -> 改内存对象 -> 写回"这类跨多个 await 的复合操作——
// 两个并发调用可能都读到同一份旧数据、都通过各自的校验、后写的整份覆盖先写的。
// shares.js / users.js 的并发用例已经在改锁之前验证过这个覆盖真实发生；
// 这里只测 withFileLock 本身的排队/隔离/容错语义。
describe('withFileLock', () => {
  it('同一 file 的调用严格串行执行，不会交错', async () => {
    const file = path.join(dir, 'lock.json');
    const order = [];
    const slow = async (tag) => {
      order.push(`${tag}-start`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`${tag}-end`);
      return tag;
    };

    const [a, b] = await Promise.all([
      withFileLock(file, () => slow('a')),
      withFileLock(file, () => slow('b')),
    ]);

    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
    expect([a, b]).toEqual(['a', 'b']);
  });

  it('fn 抛错之后锁能正常释放，后续调用不会被永久卡死', async () => {
    const file = path.join(dir, 'lock-err.json');

    await expect(
      withFileLock(file, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // 如果锁没有正确释放，下面这次调用会永远 pending，
    // 用例会被 vitest 的默认超时判失败，而不是这个 expect 本身失败。
    const result = await withFileLock(file, async () => 'ok-after-error');
    expect(result).toBe('ok-after-error');
  });

  it('同一 file 上一次 rejected 调用之后排队的下一个调用依然会执行', async () => {
    const file = path.join(dir, 'lock-err-queue.json');
    const first = withFileLock(file, async () => {
      throw new Error('first fails');
    });
    const second = withFileLock(file, async () => 'second still runs');

    await expect(first).rejects.toThrow('first fails');
    expect(await second).toBe('second still runs');
  });

  it('不同 file 的锁互不阻塞：慢 fn 占住 A 时，B 不会被拖住', async () => {
    const fileA = path.join(dir, 'a.json');
    const fileB = path.join(dir, 'b.json');
    const events = [];

    const slowA = withFileLock(fileA, async () => {
      events.push('a-start');
      await new Promise((r) => setTimeout(r, 50));
      events.push('a-end');
      return 'a';
    });

    // 给 A 一点时间先跑到 'a-start'，再发起 B。
    await new Promise((r) => setTimeout(r, 10));
    const bResult = await withFileLock(fileB, async () => {
      events.push('b-start');
      events.push('b-end');
      return 'b';
    });

    // B 必须在 A 还没结束（'a-end' 还没发生）之前就跑完，
    // 否则说明两个文件的锁互相阻塞了。
    expect(bResult).toBe('b');
    expect(events).toEqual(['a-start', 'b-start', 'b-end']);

    await slowA;
    expect(events).toEqual(['a-start', 'b-start', 'b-end', 'a-end']);
  });
});
