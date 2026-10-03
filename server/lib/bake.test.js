import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { startBake, stopBake, prioritizeBake, DRAIN_TIMEOUT_MS } from './bake.js';
import { openSession, closeSession, closeAllSessions, rescanSession } from './session.js';
import { marksDir } from './store.js';
import { getThumb } from './thumbs.js';

// 包一层 vi.fn，行为完全转发给真实实现（不影响任何一条断言磁盘缓存内容的用例），
// 只是额外记录调用顺序/参数，用来验证 prioritizeBake 到底有没有真的改变处理顺序，
// 而不是只看 done 的数量（数量涨到 2 不代表提到了队首，队列反正是顺序处理的）。
vi.mock('./thumbs.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getThumb: vi.fn(actual.getThumb) };
});

let tmp;

beforeEach(async () => {
  getThumb.mockClear();
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bake-')));
  for (let i = 0; i < 6; i++) {
    await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: i * 40, g: 60, b: 90 } } })
      .jpeg().toFile(path.join(tmp, `S${i}.JPG`));
  }
  await fs.writeFile(path.join(tmp, 'noJpg.CR3'), 'raw only');
});

afterEach(async () => {
  await closeAllSessions();
  await fs.rm(tmp, { recursive: true, force: true });
});

const waitFor = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

describe('startBake', () => {
  it('把所有有 JPG 的资产烤进磁盘缓存', async () => {
    const session = await openSession(tmp);
    startBake(session);
    expect(await waitFor(() => session.bake.done === session.bake.total)).toBe(true);
    const files = await fs.readdir(path.join(marksDir(tmp), 'thumbs'));
    expect(files.filter((f) => f.endsWith('.webp'))).toHaveLength(6);
  });

  it('total 包含纯 RAW，无法提取预览也能结束队列', async () => {
    const session = await openSession(tmp);
    expect(session.bake.total).toBe(7);
  });

  it('重复调用不会重复计数', async () => {
    const session = await openSession(tmp);
    startBake(session);
    startBake(session);
    startBake(session);
    expect(await waitFor(() => session.bake.done === session.bake.total)).toBe(true);
    expect(session.bake.done).toBe(7);
  });

  it('通过 SSE 广播进度', async () => {
    const session = await openSession(tmp);
    const seen = [];
    session.listeners.add({ send: (e) => { if (e.type === 'bake') seen.push(e.done); }, end: () => {} });
    startBake(session);
    expect(await waitFor(() => session.bake.done === session.bake.total)).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBe(7);
  });

  it('stopBake 之后不再推进', async () => {
    const session = await openSession(tmp);
    startBake(session);
    stopBake(session);
    const snapshot = session.bake.done;
    await new Promise((r) => setTimeout(r, 200));
    expect(session.bake.done).toBeLessThanOrEqual(snapshot + 1); // 最多完成正在处理的那一张
    expect(session.bake.running).toBe(false);
  });

  it('会话被关闭后烘焙自行终止，除了正在处理的那一张不再推进', async () => {
    const session = await openSession(tmp);
    startBake(session);
    await closeSession(session.id);
    const snapshot = session.bake.done;
    expect(session.aborted).toBe(true);
    // 正常不间断的话，这 6 张全部烤完远用不了 1.5s（见前面几个用例，通常 <1s）。
    // 如果 close 之后没有真的让烘焙停下来，done 会在这个窗口内继续涨到 6，
    // 而不是停在 snapshot（最多再多正在处理的那一张）。
    await new Promise((r) => setTimeout(r, 1500));
    expect(session.bake.done).toBeLessThanOrEqual(snapshot + 1);
  });

  it('closeSession 落地后，正在进行的那一次 getThumb 已经真正完成', async () => {
    const session = await openSession(tmp);
    // 400x300 的测试夹具生成缩略图快到几毫秒级——真实完成得太快，掩盖得住"漏掉
    // await"这种问题（这一点是实测出来的：先前一版没加这个人为延迟，即使把
    // stopBake() 里的 drain 整个删掉，这条用例在本机也稳定通过）。人为拖慢第一次
    // 调用，确保 closeSession() 落地的那一刻，"正在处理的那一张"真的还没完工，
    // 这样漏掉 await 才会可靠地表现成删目录时的竞态。
    const real = getThumb.getMockImplementation();
    getThumb.mockImplementationOnce(async (...args) => {
      await new Promise((r) => setTimeout(r, 200));
      return real(...args);
    });
    startBake(session);
    await closeSession(session.id);
    // 如果这时候还有一次 sharp 读写没落地，紧接着删掉整个目录就会跟它撞车
    // （ENOENT / libvips "unable to open for read"）——用 console.warn 是否被
    // 调用来当探针：thumbs.js 的 getThumb 失败时会且只会走 console.warn，不抛异常。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 500)); // 给任何遗留的后台 I/O 一个暴露的机会
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rescanSession 是第一条会在同一个 session 上第二次调用 startBake 的路径
// （经 startPostScan）。startBake 的幂等守卫是一个以 session 对象为键、从不
// 自己过期的 WeakMap（见上方 state 声明）——不在 stopBake 里删掉这个条目，
// 第二次 startBake 直接 no-op：刷新新增的照片永远进不了烘焙队列，只能等客户端
// 真的请求缩略图时懒生成；session.bake 也会永久停在重扫刚重置出来的
// {done:0, running:false} 上。用真实可解码的 JPEG 是刻意的——这个文件其它地方
// 全是 1 字节假内容，烘焙必然因"不是图片"而失败，区分不出"没排上队"和
// "排了队但生成失败"。
// ─────────────────────────────────────────────────────────────────────────────
describe('rescanSession 与烘焙的交界', () => {
  it('刷新新增的照片真的会被烘焙，不是永远停在懒生成', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rescan-bake-new-')));
    try {
      await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 20, b: 30 } } })
        .jpeg().toFile(path.join(root, 'N0.JPG'));
      const session = await openSession(root);
      expect(await waitFor(() => session.bake.done === session.bake.total)).toBe(true);
      expect(session.bake).toMatchObject({ done: 1, total: 1 });

      await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 90, g: 60, b: 30 } } })
        .jpeg().toFile(path.join(root, 'N1.JPG'));
      const result = await rescanSession(session);
      expect(result).toEqual({ removed: 0, added: 1 });

      // 正面证明落在可观察的产物上——不是只看 running === true 就完事：
      // 新照片的缩略图真的落到了磁盘缓存目录里。
      expect(await waitFor(() => session.bake.done === 2)).toBe(true);
      const files = await fs.readdir(path.join(marksDir(root), 'thumbs'));
      expect(files.filter((f) => f.endsWith('.webp'))).toHaveLength(2);

      await closeSession(session.id);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('扫描失败时旧烘焙状态不受影响：幂等守卫不能被提前清掉', async () => {
    // 这条钉的不是"assertIsExistingDir 抛错"本身（session.test.js 的
    // rescanSession 分组已经测过很多次了），钉的是 rescanSession 里那句
    // "位置是要害"——stopBake 必须放在 scanFolder 成功之后、提交新状态之前，
    // 绝不能放在 try 块开头。
    //
    // 放错位置的后果，在"旧烘焙已经天然跑完"这个最常见的时机下几乎看不出来：
    // running 反正已经是 false，session.bake 表面的字段也不会变。唯一会冒泡
    // 出来的迹象是 bake.js 那个 WeakMap 幂等守卫被提前清掉了——用直接再调一次
    // startBake 揭穿它：守卫还在的话必须仍是 no-op；守卫被提前清掉的话，这次
    // startBake 会照着（未受影响的）session.assets 重新排一遍队列，done 会
    // 涨过 total。
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rescan-bake-guard-')));
    try {
      await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 50, g: 50, b: 50 } } })
        .jpeg().toFile(path.join(root, 'G0.JPG'));
      const session = await openSession(root);
      expect(await waitFor(() => session.bake.done === session.bake.total)).toBe(true);
      const bakeBefore = session.bake;
      expect(bakeBefore).toMatchObject({ done: 1, total: 1, running: false });

      await fs.rm(root, { recursive: true, force: true });   // 根目录没了：重扫必然失败
      await expect(rescanSession(session)).rejects.toThrow();

      // 表面的状态确实没变……
      expect(session.bake).toBe(bakeBefore);   // 引用都没换
      expect(session.bake).toMatchObject({ done: 1, total: 1, running: false });

      // ……但光看这几个字段不足为凭：即使幂等守卫被提前清掉，此刻它们也长这样
      // （见上面的注释）。真正的证据是再调一次 startBake 必须仍然是 no-op。
      const doneBefore = session.bake.done;
      startBake(session);
      await new Promise((r) => setTimeout(r, 300));
      expect(session.bake.done).toBe(doneBefore);
      expect(session.bake.running).toBe(false);

      await closeSession(session.id);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('重扫发生在旧烘焙还在跑的时候，running 不会被旧循环的收尾砸成 false', async () => {
    // 跟上面两条不同的一个 bug：不在 startBake 的幂等守卫，而在它的 IIFE 收尾
    // （bake.js 的 while 循环退出之后那两行）。旧循环卡在 `await delay(0)`
    // （宏任务）让出去的时候，如果 stopBake → rescanSession 换上新
    // session.assets/session.bake → 新一轮 startBake 这一整条链（全在微任务
    // 队列里）抢先跑完，旧循环醒来时 `session.bake` 这个属性访问取到的已经是
    // 新对象——它无条件把新对象的 running 砸成 false，而 running 只在
    // startBake 顶部设一次 true，循环体内不会重置，砸掉就一直错到这一轮自然
    // 结束。
    //
    // 上面两条用例都先 waitFor 旧烘焙 done===total 再触发重扫，恰好把这个
    // 窗口消掉了，结构上不可能命中。这条反过来：故意在 done < total 时就
    // 触发 rescanSession，并且反复采样而不是只看 resolve 那一刻——复审实测
    // 是 resolve 后约 10ms 才掉下去的。人为给 getThumb 加一点延迟，让首轮
    // 烘焙有充分的时间被打断，也让重扫之后的新一轮有充分的时间被采样到。
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rescan-bake-race-')));
    const real = getThumb.getMockImplementation();
    getThumb.mockImplementation(async (...args) => {
      await new Promise((r) => setTimeout(r, 40));
      return real(...args);
    });
    try {
      for (let i = 0; i < 10; i++) {
        await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: i * 20, g: 60, b: 90 } } })
          .jpeg().toFile(path.join(root, `R${i}.JPG`));
      }
      const session = await openSession(root);
      // 精确要求：旧烘焙这时候确实还没烤完——这是这条用例存在的全部意义，
      // 不是可有可无的旁白。
      expect(session.bake.running).toBe(true);
      expect(session.bake.done).toBeLessThan(session.bake.total);

      await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 10, b: 10 } } })
        .jpeg().toFile(path.join(root, 'R_NEW.JPG'));
      await rescanSession(session);

      const violations = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 600 && session.bake.done < session.bake.total) {
        if (session.bake.running !== true) {
          violations.push({ done: session.bake.done, total: session.bake.total, t: Date.now() - t0 });
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(violations).toEqual([]);

      // 这道守卫没有把正常的收尾一起挡掉：新一轮最终仍然能正常烤完
      // （total 是 11：原来的 10 张 + 新加的 1 张）。
      expect(session.bake.total).toBe(11);
      expect(await waitFor(() => session.bake.done === session.bake.total)).toBe(true);

      await closeSession(session.id);
    } finally {
      getThumb.mockImplementation(real);
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('prioritizeBake', () => {
  it('把指定 id 提到队首优先烤——验证的是处理顺序，不是数量', async () => {
    const session = await openSession(tmp);
    startBake(session);
    prioritizeBake(session, ['S5', 'S4']);
    expect(await waitFor(() => session.bake.done === session.bake.total)).toBe(true);
    const order = getThumb.mock.calls.map(([, asset]) => asset.id);
    const idx = (id) => order.indexOf(id);
    // S4 紧跟在 S5 后面被处理，保持了调用 prioritizeBake 时给的相对顺序
    expect(idx('S4')).toBe(idx('S5') + 1);
    // 且两者都明显早于没被提升的 S1/S2/S3——队列本来的顺序是 S0..S5，
    // 如果 prioritizeBake 什么也没做，S5 会排在所有人后面，这几条断言会失败
    expect(idx('S5')).toBeLessThan(idx('S1'));
    expect(idx('S5')).toBeLessThan(idx('S2'));
    expect(idx('S5')).toBeLessThan(idx('S3'));
  });

  it('未知 id 被忽略且不报错', async () => {
    const session = await openSession(tmp);
    startBake(session);
    expect(() => prioritizeBake(session, ['ghost'])).not.toThrow();
  });

  // MINOR：prioritizeBake 把 Array.includes 换成了 Set（它在滚动时每 250ms 就被调
  // 一次，includes 放在 filter 里是 O(n·m)）。换法本身是等价的，所以这条用例钉的是
  // 它必须保持的语义——去重：提升过的 id 不能在队列里留下第二份，否则同一张图会被
  // 重复烤，done 也会涨过 total。
  it('MINOR: 同一个 id 反复提升也不会在队列里留下重复', async () => {
    const session = await openSession(tmp);
    // 人为拖慢每一次生成：这样下面两次 prioritizeBake 调用期间队列几乎不前进，
    // 测的才真的是"提升"这一步的去重，而不是碰运气。
    const real = getThumb.getMockImplementation();
    getThumb.mockImplementation(async (...args) => {
      await new Promise((r) => setTimeout(r, 60));
      return real(...args);
    });

    startBake(session);
    prioritizeBake(session, ['S5', 'S4']);
    prioritizeBake(session, ['S4', 'S3']);   // S4 第二次被提

    expect(await waitFor(() => session.bake.running === false)).toBe(true);
    await new Promise((r) => setTimeout(r, 150));   // 给任何多余的队列项一个暴露的机会

    const order = getThumb.mock.calls.map(([, asset]) => asset.id);
    expect(new Set(order).size).toBe(order.length);   // 一个 id 都不重复
    expect(order).toHaveLength(7);
    expect(session.bake.done).toBe(7);
  });
});

describe('并发/超时安全网', () => {
  // 便宜的回归钉子：不测延迟本身（那需要真实尺寸的图片和并发基准，见
  // task-7-report.md「Fix round 1/2 · F3」），只确认 thumbs.js 加载后，
  // sharp 的内部并发确实被钉死成了 1——防止这一行以后被"顺手删掉"而不被发现。
  it('thumbs.js 加载后把 sharp 的内部并发钉死成 1', () => {
    expect(sharp.concurrency()).toBe(1);
  });

  it('stopBake：正在进行的那一次 getThumb 永远不落地，也不会无限期等下去', async () => {
    const session = await openSession(tmp);
    getThumb.mockImplementationOnce(() => new Promise(() => {})); // 永远不 resolve/reject
    startBake(session);
    const t0 = Date.now();
    await stopBake(session, { drainTimeoutMs: 200 }); // 测试用短超时，不用真的等生产环境的那几秒
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000); // 远小于"永远不落地"，证明真的没被卡住
    expect(session.bake.running).toBe(false);
  });

  it('closeSession：正在进行的那一次 getThumb 永远不落地，closeSession 仍会在超时后返回', async () => {
    const session = await openSession(tmp);
    getThumb.mockImplementationOnce(() => new Promise(() => {})); // 模拟卡死的 sharp 调用
    startBake(session);
    const t0 = Date.now();
    await closeSession(session.id); // 走生产代码路径，用 bake.js 默认的 DRAIN_TIMEOUT_MS，不传自定义超时
    const elapsed = Date.now() - t0;
    // 明显大于 0（真的走了超时分支，不是凑巧没等）也明显小于"无限期"
    expect(elapsed).toBeGreaterThanOrEqual(DRAIN_TIMEOUT_MS - 100);
    expect(elapsed).toBeLessThan(DRAIN_TIMEOUT_MS + 2000);
    expect(session.aborted).toBe(true);
  }, DRAIN_TIMEOUT_MS + 4000);
});
