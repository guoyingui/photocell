import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  openSession, beginSession, closeSession, closeAllSessions, getSession, getSessionByRoot, browseRoots,
  rescanSession,
} from './session.js';
import { marksDir, readMarksFile } from './store.js';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/**
 * 可控的 scanFolder 桩（I7）。
 *
 * `impl` 为 null 时**完全透传**给真实实现，对这个文件里其它每一条用例都没有影响；
 * 只有扫描那一组用例会临时装一个自己的实现，用完在 afterEach 里卸掉。
 * `calls` 是"扫描到底有没有开始过"的唯一可靠证据——"不可写时不产生任何 scan 事件"
 * 这条要求，光看事件是看不出来的（那时候还没有会话，也就没有订阅者），
 * 只有"scanFolder 一次都没被调用"才真正钉住了写探测排在扫描之前。
 *
 * 用 vi.hoisted 声明是因为 vi.mock 的工厂会被提升到所有 import 之前，
 * 只有这样声明的变量才能在工厂里安全引用。
 */
const scanFake = vi.hoisted(() => ({ impl: null, calls: 0 }));

vi.mock('./scan.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    scanFolder: async (root, opts = {}) => {
      scanFake.calls++;
      if (!scanFake.impl) return actual.scanFolder(root, opts);
      return scanFake.impl(root, opts, actual);
    },
  };
});

/** 一个可以被测试按在半路的扫描：返回放行钩子和"已经跑起来了"的信号。 */
function pausedScan({ batches = [], fail = null, afterPause = [] } = {}) {
  let release;
  const gate = new Promise((r) => { release = r; });
  let reached;
  const paused = new Promise((r) => { reached = r; });
  scanFake.calls = 0;
  scanFake.impl = async (root, opts, actual) => {
    for (const found of batches) opts.onBatch?.(found);
    reached();
    await gate;
    for (const found of afterPause) opts.onBatch?.(found);
    if (fail) throw fail;
    // 真实结果，但不再带 onBatch：进度回调完全由上面那几行脚本决定。
    return actual.scanFolder(root);
  };
  return { release, paused };
}

let dirs = [];

/** 建一个只有 RAW 的小库：不生成缩略图，测试跑得快，也顺便是孤儿 RAW 的形状。 */
async function mkLib(prefix, stems = ['A', 'B']) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  for (const stem of stems) await fs.writeFile(path.join(dir, `${stem}.CR3`), `raw-${stem}`);
  dirs.push(dir);
  return dir;
}

beforeEach(() => { dirs = []; });

afterEach(async () => {
  scanFake.impl = null;   // 卸掉桩，避免漏到下一条用例
  await closeAllSessions();
  for (const dir of dirs) {
    await fs.chmod(dir, 0o755).catch(() => {});
    await fs.chmod(marksDir(dir), 0o755).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('会话身份（C2）', () => {
  it('两个文件夹可以同时各有一个活着的会话，互不顶替', async () => {
    const [rootA, rootB] = [await mkLib('sess-a-'), await mkLib('sess-b-')];
    const a = await openSession(rootA);
    const b = await openSession(rootB);

    // 旧实现是单全局会话：打开 B 会先把 A 关掉（a.aborted 变 true），
    // 之后 A 标签页的每一次标记都会静默落进 B 的 marks.json。
    expect(a.id).not.toBe(b.id);
    expect(a.aborted).toBe(false);
    expect(getSession(a.id)).toBe(a);
    expect(getSession(b.id)).toBe(b);
    expect(getSession(a.id).root).toBe(rootA);
    expect(getSession(b.id).root).toBe(rootB);
  });

  it('两个会话的标记各自落进自己文件夹的 marks.json', async () => {
    // 两台同型号机身拍出来的 IMG_0002 在两个文件夹里就是同一个 id——这是常态，不是边界情况。
    const [rootA, rootB] = [await mkLib('sess-a-', ['IMG_0002']), await mkLib('sess-b-', ['IMG_0002'])];
    const a = await openSession(rootA);
    const b = await openSession(rootB);

    a.markStore.setMark('IMG_0002', 'pick');
    b.markStore.setMark('IMG_0002', 'reject');
    await a.markStore.flush();
    await b.markStore.flush();

    expect((await readMarksFile(rootA)).marks).toEqual({ IMG_0002: 'pick' });
    expect((await readMarksFile(rootB)).marks).toEqual({ IMG_0002: 'reject' });
  });

  it('getSession 查不到就是 null，不会返回"最后那一个"', async () => {
    const root = await mkLib('sess-lookup-');
    const s = await openSession(root);
    expect(getSession('不是这个 id')).toBeNull();
    expect(getSession('')).toBeNull();
    expect(getSession(undefined)).toBeNull();
    expect(getSession(s.id)).toBe(s);
  });

  it('closeSession 只关掉指定的那一个会话', async () => {
    const [rootA, rootB] = [await mkLib('sess-a-'), await mkLib('sess-b-')];
    const a = await openSession(rootA);
    const b = await openSession(rootB);

    expect(await closeSession(a.id)).toBe(true);
    expect(getSession(a.id)).toBeNull();
    expect(getSession(b.id)).toBe(b);
    expect(b.aborted).toBe(false);
  });

  it('关闭一个已经关掉的会话不算错误', async () => {
    const root = await mkLib('sess-idem-');
    const s = await openSession(root);
    expect(await closeSession(s.id)).toBe(true);
    expect(await closeSession(s.id)).toBe(false);
  });
});

describe('同一个文件夹只有一个会话（C2 / I14）', () => {
  it('第二次打开同一个文件夹复用同一个会话，而不是重开一个', async () => {
    const root = await mkLib('sess-reuse-');
    const first = await openSession(root);
    const second = await openSession(root);
    // 复用是刻意的：同一个文件夹被第二个标签页打开时两边共享一个 markStore，
    // 双方的标记都写进同一份文件，不会互相覆盖。
    expect(second).toBe(first);
    expect(first.aborted).toBe(false);
  });

  it('通过软链接打开同一个文件夹也命中同一个会话', async () => {
    const root = await mkLib('sess-link-');
    const linkParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sess-linkp-')));
    dirs.push(linkParent);
    const link = path.join(linkParent, 'alias');
    await fs.symlink(root, link, 'dir');

    const viaReal = await openSession(root);
    const viaLink = await openSession(link);
    expect(viaLink).toBe(viaReal);
  });

  it('两个并发的 open 只建一个会话（I14：输的那个会话的 bake 会永远跑下去）', async () => {
    const root = await mkLib('sess-race-');
    const [a, b] = await Promise.all([openSession(root), openSession(root)]);
    expect(a).toBe(b);
    // 没有在途去重的话，两次调用会各自扫描、各自建会话、各自 startBake；
    // 输的那个会话再也没人持有引用，aborted 永远是 false，它的 bake 会一直烤下去。
    expect(getSession(a.id)).toBe(a);
  });
});

describe('getSessionByRoot：按文件夹查活着的会话', () => {
  it('查得到开着的会话，关掉之后就查不到了', async () => {
    const root = await mkLib('sess-byroot-');
    const s = await openSession(root);
    expect(getSessionByRoot(root)).toBe(s);
    await closeSession(s.id);
    expect(getSessionByRoot(root)).toBeNull();
  });

  it('只查表：没开着的文件夹返回 null，绝不触发扫描', async () => {
    // 调用方是 `GET /api/share/:token/info` —— 一个**无身份**端点。
    // 它为了回答"这个库有多少张照片"去扫一遍文件夹，等于给任何拿到链接的人
    // 一个可以反复按的磁盘压力按钮。所以查不到就是 null，不许自己去开库。
    const root = await mkLib('sess-noscan-', ['X', 'Y', 'Z']);
    expect(getSessionByRoot(root)).toBeNull();
    // 扫描/开库会建出 .photocull（写探测的第一步就是 mkdir），磁盘上多出任何东西
    // 都说明它偷偷扫了。
    await expect(fs.stat(marksDir(root))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(root)).sort()).toEqual(['X.CR3', 'Y.CR3', 'Z.CR3']);
  });

  it('乱七八糟的入参返回 null，不抛错', async () => {
    expect(getSessionByRoot('/nope/nope')).toBeNull();
    expect(getSessionByRoot('')).toBeNull();
    expect(getSessionByRoot(undefined)).toBeNull();
    expect(getSessionByRoot(null)).toBeNull();
  });
});

describe('不可写文件夹（C1）', () => {
  it.skipIf(isRoot)('只读文件夹在扫描之前就被拒绝，不会建立会话', async () => {
    const root = await mkLib('sess-ro-');
    await fs.chmod(root, 0o555);

    const err = await openSession(root).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('not-writable');
    expect(err.message).toContain('不可写');
    expect(err.detail).toBeTruthy();          // 原始 errno 文案要保留下来给排查用
    // 关键：不能建立会话。旧实现一路成功返回 200，摄影师标记三小时之后才在
    // 关闭时撞上一个没法补救的 500，而磁盘上一个字节都没有。
    await fs.chmod(root, 0o755);
    await expect(fs.access(path.join(marksDir(root), 'marks.json'))).rejects.toThrow();
  });

  it.skipIf(isRoot)('探针文件不会留在文件夹里', async () => {
    const root = await mkLib('sess-probe-');
    await openSession(root);
    const left = await fs.readdir(marksDir(root));
    expect(left.filter((f) => f.includes('write-probe'))).toEqual([]);
  });

  it('可写文件夹正常打开', async () => {
    const root = await mkLib('sess-rw-');
    const s = await openSession(root);
    expect(s.assets).toHaveLength(2);
    expect(typeof s.id).toBe('string');
    expect(s.id.length).toBeGreaterThan(0);
  });
});

describe('closeSession 的落盘顺序（C1 的另一半）', () => {
  it.skipIf(isRoot)('落盘失败时把错误抛出去，同时不把会话永远留在表里', async () => {
    const root = await mkLib('sess-closefail-');
    const s = await openSession(root);
    s.markStore.setMark('A', 'pick');
    // 打开之后才变成不可写（拔卡、网络盘掉线、磁盘写满都是这个形状）。
    // 显式 mkdir 是为了让这条用例不依赖"写探测已经把 .photocull 建出来了"，
    // 它测的是关闭路径，不该被打开路径的实现细节牵着走。
    await fs.mkdir(marksDir(root), { recursive: true });
    await fs.chmod(marksDir(root), 0o555);

    // 旧实现先 current = null 再 close()：会话早就没了，错误却只能变成一个
    // 没人能补救的 500。现在要求两件事同时成立——
    await expect(closeSession(s.id)).rejects.toThrow();   // ① 错误如实往上抛
    expect(getSession(s.id)).toBeNull();                  // ② 会话确实被摘掉了，"换文件夹"不会永远卡住

    // 摘掉之后同一个文件夹还能重新打开，不会因为残留表项而被当成"已经开着的会话"。
    await fs.chmod(marksDir(root), 0o755);
    const again = await openSession(root);
    expect(again.id).not.toBe(s.id);
  });

  it('落盘成功时标记确实已经在磁盘上，之后才从表里消失', async () => {
    const root = await mkLib('sess-closeok-');
    const s = await openSession(root);
    s.markStore.setMark('A', 'pick');
    await closeSession(s.id);
    expect(getSession(s.id)).toBeNull();
    expect((await readMarksFile(root)).marks).toEqual({ A: 'pick' });
  });
});

describe('closeAllSessions', () => {
  it('关掉所有会话，单个失败不影响其它会话落盘', async () => {
    const [rootA, rootB] = [await mkLib('sess-all-a-'), await mkLib('sess-all-b-')];
    const a = await openSession(rootA);
    const b = await openSession(rootB);
    a.markStore.setMark('A', 'pick');
    b.markStore.setMark('B', 'reject');

    await closeAllSessions();
    expect(getSession(a.id)).toBeNull();
    expect(getSession(b.id)).toBeNull();
    expect((await readMarksFile(rootA)).marks).toEqual({ A: 'pick' });
    expect((await readMarksFile(rootB)).marks).toEqual({ B: 'reject' });
  });
});

describe('打开不存在的路径（N1）', () => {
  it('拒绝不存在的路径，并且不在磁盘上创建任何东西', async () => {
    const base = await mkLib('pc-n1-');
    const typo = path.join(base, 'this-does-not-exist', 'deep', 'typo');

    await expect(openSession(typo)).rejects.toMatchObject({ code: 'no-such-folder' });

    // 修复前：assertWritable 里的 fs.mkdir(<root>/.photocull, {recursive:true})
    // 会把整条缺失路径一起建出来，然后返回 200 assetCount:0 —— 界面上是一个
    // 零解释的空网格，磁盘上是一棵凭空出现的目录树。可达路径就是选择器里的
    // 「或直接粘贴绝对路径」输入框，一个拼写错误就够了。
    await expect(fs.stat(path.join(base, 'this-does-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('路径存在但是个文件（不是目录）也被拒', async () => {
    const base = await mkLib('pc-n1f-');
    const file = path.join(base, 'A.CR3');
    await expect(openSession(file)).rejects.toMatchObject({ code: 'no-such-folder' });
    // 断言真正关心的性质：磁盘上什么都没多出来。
    // （不要断言具体的 errno —— 文件下面的路径是 ENOTDIR 而不是 ENOENT。）
    expect((await fs.readdir(base)).sort()).toEqual(['A.CR3', 'B.CR3']);
  });

  it('正常的已存在目录照常打开', async () => {
    // 对照组：证明上面两条不是因为 openSession 整个坏掉了
    const dir = await mkLib('pc-n1ok-');
    const s = await openSession(dir);
    expect(s.assets).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// I7：扫描不再阻塞开库。
//
// scan.js 的 onBatch 增量机制早就实现并修过两轮，但生产代码从来没传过 onBatch：
// 开库会一直阻塞到整个递归遍历加每文件一次 stat 结束。读卡器上 3000 对照片要
// 几十秒，界面上只有一个静止的"正在扫描…"，跟卡死无法区分。
// ─────────────────────────────────────────────────────────────────────────────
describe('扫描不阻塞开库（I7）', () => {
  const scanEvents = (session) => {
    const seen = [];
    session.listeners.add({ send: (e) => seen.push(e), end: () => {} });
    return seen;
  };

  it('beginSession 在扫描完成之前就返回，而且会话此刻已经能按 id 查到', async () => {
    const root = await mkLib('sess-scan-async-');
    const { release, paused } = pausedScan();

    const session = await beginSession(root);
    await paused;                       // 扫描确实已经开跑，并且还停在半路

    expect(session.scan.done).toBe(false);
    // 会话必须**现在**就在注册表里：客户端拿到 sessionId 之后立刻就要用它连 SSE，
    // 而进度事件正是从这条流上来的。等扫描结束再注册的话，客户端只能干等。
    expect(getSession(session.id)).toBe(session);
    expect(getSessionByRoot(root)).toBe(session);

    release();
    await session.ready;
    expect(session.scan.done).toBe(true);
    expect(session.assets).toHaveLength(2);
    expect(session.byId.get('A')).toBeTruthy();     // 资产索引也要跟着补上
  });

  it('openSession 仍然等到扫描结束才返回（既有调用方全都靠这条）', async () => {
    // 访客 join 走的是 openSession：它要拿 assetCount，不能拿到一份还没扫完的空表。
    const root = await mkLib('sess-scan-block-');
    const { release, paused } = pausedScan();

    let settled = false;
    const pending = openSession(root).then((s) => { settled = true; return s; });
    await paused;
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    release();
    const session = await pending;
    expect(session.assets).toHaveLength(2);
    expect(session.scan.done).toBe(true);
  });

  it('扫描进度广播成 scan 事件，累计计数单调不减，完成时 done 变 true', async () => {
    const root = await mkLib('sess-scan-progress-');
    // onBatch 的契约是**累计**计数（不是增量），这里逐字照用。
    const { release, paused } = pausedScan({ batches: [500, 1200], afterPause: [1500] });

    const session = await beginSession(root);
    await paused;
    const seen = scanEvents(session);
    release();
    await session.ready;

    const scans = seen.filter((e) => e.type === 'scan');
    // 订阅是在前两批之后才建立的，所以只看得到 1500 那一批和最后的完成事件。
    expect(scans.length).toBeGreaterThanOrEqual(2);
    expect(scans.map((e) => e.found)).toEqual([...scans].map((e) => e.found).sort((a, b) => a - b));
    expect(scans.slice(0, -1).every((e) => e.done === false)).toBe(true);
    expect(scans.at(-1).done).toBe(true);
    expect(session.scan.found).toBe(1500);
  });

  it('扫描中途接上来的订阅者能从会话上读到当前进度，不用干等下一批', async () => {
    // 会话按 root 唯一、可被多个客户端共享，中途连上来的人必须拿得到快照。
    const root = await mkLib('sess-scan-snapshot-');
    const { release, paused } = pausedScan({ batches: [700] });

    const session = await beginSession(root);
    await paused;
    expect(session.scan).toMatchObject({ found: 700, done: false, error: null });

    release();
    await session.ready;
    expect(session.scan).toMatchObject({ done: true, error: null });
  });

  it('扫描失败时推 scan.error，会话被清理掉', async () => {
    const root = await mkLib('sess-scan-fail-');
    const boom = Object.assign(
      // 真实的 fs 错误消息里带着摄影师磁盘上的绝对路径，下面那条断言就是冲它去的。
      new Error(`ENOSPC: no space left on device, scandir '${root}'`), { code: 'ENOSPC' });
    const { release, paused } = pausedScan({ batches: [3], fail: boom });

    const session = await beginSession(root);
    await paused;
    const seen = scanEvents(session);
    release();
    await session.ready;

    const last = seen.filter((e) => e.type === 'scan').at(-1);
    expect(last.error).toBeTruthy();
    expect(last.done).toBe(false);
    // 这条流对 viewer 也是开放的：事件里绝不能出现摄影师磁盘上的绝对路径。
    expect(JSON.stringify(seen)).not.toContain(root);

    expect(getSession(session.id)).toBeNull();
    expect(getSessionByRoot(root)).toBeNull();
  });

  it('扫描失败时 openSession 把错误抛出去，而不是返回一个空库', async () => {
    const root = await mkLib('sess-scan-failopen-');
    const { release } = pausedScan({ fail: Object.assign(new Error('boom'), { code: 'EIO' }) });
    release();

    await expect(openSession(root)).rejects.toThrow();
    expect(getSessionByRoot(root)).toBeNull();

    // 清干净之后同一个文件夹还能重新打开，不会因为残留表项被当成"已经开着"。
    scanFake.impl = null;
    const again = await openSession(root);
    expect(again.assets).toHaveLength(2);
  });

  it.skipIf(isRoot)('文件夹不可写时根本不会开始扫描（写探测排在扫描之前）', async () => {
    // 顺序是这条用例的全部意义：先判可写、再开扫。反过来的话用户会先看到进度条，
    // 再被告知这个文件夹根本不可写。
    const root = await mkLib('sess-scan-ro-');
    await fs.chmod(root, 0o555);
    pausedScan();

    await expect(beginSession(root)).rejects.toMatchObject({ code: 'not-writable' });
    expect(scanFake.calls).toBe(0);
    expect(getSessionByRoot(root)).toBeNull();
    await fs.chmod(root, 0o755);
  });

  it('路径不存在时同样不会开始扫描', async () => {
    const base = await mkLib('sess-scan-typo-');
    pausedScan();

    await expect(beginSession(path.join(base, 'nope', 'deep'))).rejects
      .toMatchObject({ code: 'no-such-folder' });
    expect(scanFake.calls).toBe(0);
  });

  it('扫描进行中把库关掉：扫完之后不会再往一个死会话上写东西', async () => {
    const root = await mkLib('sess-scan-close-');
    const { release, paused } = pausedScan({ afterPause: [2] });

    const session = await beginSession(root);
    await paused;
    expect(await closeSession(session.id)).toBe(true);

    release();
    await session.ready;
    expect(session.assets).toEqual([]);          // 已经作废的会话不再被填资产
    expect(session.bake.total).toBe(0);          // 也不会给它排一队烤箱任务
    expect(getSession(session.id)).toBeNull();
  });
});

describe('browseRoots 在 win32 上', () => {
  it('盘符根包住 homedir 时不再单独把 homedir 列进去', async () => {
    // 这一条不是风格偏好。C:\ 已经是根了，再把 C:\Users\guoyg 也列成根，
    // 前端 containingRoot() 取**最长匹配**会返回后者，于是 atRootBoundary()
    // 判定你站在边界上，目录浏览器的「上级」按钮当场变灰——明明整个 C 盘
    // 都可浏览，你却退不出自己的用户目录。
    const roots = await browseRoots({
      platform: 'win32',
      listDrives: async () => ['C:\\', 'D:\\'],
      homedir: () => 'C:\\Users\\guoyg',
    });
    expect(roots).toEqual(['C:\\', 'D:\\']);
  });

  it('没有任何盘符根包住 homedir 时才补上它', async () => {
    // C 盘枚举失败、权限不足的情况下，至少还进得去自己的主目录。
    const roots = await browseRoots({
      platform: 'win32',
      listDrives: async () => ['D:\\'],
      homedir: () => 'C:\\Users\\guoyg',
    });
    expect(roots).toEqual(['D:\\', 'C:\\Users\\guoyg']);
  });

  it('非 win32 平台行为不变：homedir 照常在列', async () => {
    const roots = await browseRoots({
      platform: 'darwin',
      listDrives: async () => [],
      homedir: () => '/Users/guoyg',
    });
    expect(roots[0]).toBe('/Users/guoyg');
  });
});

describe('rescanSession', () => {
  it('磁盘上多了照片，重扫之后资产表跟着变', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rescan-'));
    await fs.writeFile(path.join(root, 'IMG_1.JPG'), 'x');
    const session = await openSession(root);
    expect(session.assets).toHaveLength(1);

    await fs.writeFile(path.join(root, 'IMG_2.JPG'), 'x');
    const result = await rescanSession(session);

    expect(result).toEqual({ removed: 0, added: 1 });
    expect(session.assets).toHaveLength(2);
    expect(session.byId.size).toBe(2);
    await closeSession(session.id);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('磁盘上少了照片，重扫之后从资产表里去掉', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rescan-'));
    await fs.writeFile(path.join(root, 'IMG_1.JPG'), 'x');
    await fs.writeFile(path.join(root, 'IMG_2.JPG'), 'x');
    const session = await openSession(root);

    await fs.rm(path.join(root, 'IMG_2.JPG'));
    const result = await rescanSession(session);

    expect(result).toEqual({ removed: 1, added: 0 });
    expect(session.assets).toHaveLength(1);
    await closeSession(session.id);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('磁盘上少了照片，重扫之后 scan.found 也跟着变小，不停在旧值上', async () => {
    // routes/library.js 的 GET /stream 每次建立连接都会用 session.scan.found
    // 补发一次快照（首帧）。这个值如果不跟着刷新更新，新连上来的客户端、
    // 或者任何一次断线重连，看到的都会是一个跟资产表对不上的旧数字。
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rescan-'));
    await fs.writeFile(path.join(root, 'IMG_1.JPG'), 'x');
    await fs.writeFile(path.join(root, 'IMG_2.JPG'), 'x');
    const session = await openSession(root);
    expect(session.scan.found).toBe(2);

    await fs.rm(path.join(root, 'IMG_2.JPG'));
    await rescanSession(session);

    expect(session.scan.found).toBe(1);
    await closeSession(session.id);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('消失的照片的标记留在 markStore 里，不被清掉', async () => {
    // 文件可能只是被临时移走。清掉标记的话，它明天回来时选片进度就没了。
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rescan-'));
    await fs.writeFile(path.join(root, 'IMG_1.JPG'), 'x');
    const session = await openSession(root);
    const id = session.assets[0].id;
    session.markStore.setMark(id, 'pick', { by: 'admin', at: 1 });

    await fs.rm(path.join(root, 'IMG_1.JPG'));
    await rescanSession(session);

    expect(session.assets).toHaveLength(0);
    expect(session.markStore.data.marks[id]).toBe('pick');
    await closeSession(session.id);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('扫描失败时保留旧资产表，会话不被销毁', async () => {
    // 这和开库失败退回选择器**不一样**：那时手上没有任何可用数据，
    // 退回去是唯一选择；这里已经有一份能用的，清掉它是纯损失。
    //
    // 根目录整个消失（移动硬盘拔了、网络盘掉了、文件夹被挪走）是刷新最常见
    // 的失败方式：walk() 会把根目录的 readdir 失败吞成一条 warning 正常返回
    // （见 scan.js），不专门拦一道的话，rescanSession 会把这种情况当成
    // "照片全被删了"，资产表整个换成空的，还以成功的姿态返回——跟这条用例
    // 要钉住的"保留旧资产表"直接矛盾。rescanSession 在扫描前用
    // assertIsExistingDir 复查一遍，跟开库路径（createSession）用的是
    // 同一个断言。
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rescan-'));
    await fs.writeFile(path.join(root, 'IMG_1.JPG'), 'x');
    const session = await openSession(root);
    const before = session.assets;

    await fs.rm(root, { recursive: true, force: true });   // 整个文件夹没了
    await expect(rescanSession(session)).rejects.toThrow();

    expect(session.assets).toBe(before);        // 引用都没换
    expect(session.aborted).toBe(false);
    expect(getSession(session.id)).toBe(session);
    await closeSession(session.id);
  });

  it('根目录还在、但扫描过程本身抛错时同样保留旧资产表', async () => {
    // 跟上一条覆盖的是不同的失败模式：上一条是根目录整个不可达，这一条是
    // 根目录还在、但扫描过程本身出了问题（磁盘 IO 错误之类）。真实的
    // scanFolder 对文件系统故障很有韧性、几乎不会自己 reject（见上一条的
    // 注释），这里用桩去装一次真正的 reject，跟本文件顶部"扫描不阻塞开库
    // （I7）"那组测 runScan 失败路径是同一个手法。
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rescan-'));
    await fs.writeFile(path.join(root, 'IMG_1.JPG'), 'x');
    const session = await openSession(root);
    const before = session.assets;

    const boom = Object.assign(new Error('boom'), { code: 'EIO' });
    scanFake.impl = async () => { throw boom; };
    await expect(rescanSession(session)).rejects.toThrow('boom');
    scanFake.impl = null;

    expect(session.assets).toBe(before);        // 引用都没换
    expect(session.aborted).toBe(false);
    expect(getSession(session.id)).toBe(session);
    await closeSession(session.id);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('根目录还在、照片是真的被删光了：正常成功，不会被新加的存在性检查误伤', async () => {
    // 钉住 assertIsExistingDir 那道新检查没有把合法场景一起拦掉：文件夹本身
    // 还在，只是里面的照片被客户真的清空了——这应该是一次成功的刷新
    // （removed 等于原来的张数），不是失败。少了这条，以后有人把断言写得
    // 更严（比如顺手要求 assets 非空）不会有任何东西报红。
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rescan-'));
    await fs.writeFile(path.join(root, 'IMG_1.JPG'), 'x');
    await fs.writeFile(path.join(root, 'IMG_2.JPG'), 'x');
    const session = await openSession(root);
    expect(session.assets).toHaveLength(2);

    await fs.rm(path.join(root, 'IMG_1.JPG'));
    await fs.rm(path.join(root, 'IMG_2.JPG'));
    const result = await rescanSession(session);

    expect(result).toEqual({ removed: 2, added: 0 });
    expect(session.assets).toEqual([]);
    await closeSession(session.id);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('并发两次刷新合并成一趟扫描', async () => {
    // `expect(a).toEqual(b)`（原来这条用例唯一的断言）测不出"没合并"：两次
    // rescanSession 调用之间磁盘没变，即使彻底禁用合并、真的独立扫两趟，算出来
    // 的 {removed, added} 也是完全一样的两份值。必须直接钉住合并本身。
    //
    // 钉法不能是 `expect(rescanSession(session)).toBe(rescanSession(session))`：
    // rescanSession 是 async function，每次调用外层拿到的都是一个全新的 Promise
    // 包装对象（哪怕两次调用内部命中的是同一个 session.rescan，返回给调用方的
    // 包装对象也不相等——这是 ECMAScript 规范里 AsyncFunctionStart 的硬性质，
    // 不是可以被引擎优化掉的实现细节）。真正被合并到同一个对象上的是内部字段
    // session.rescan（session.js 里就是这么注释的："并发调用合并到同一个
    // promise 上"）——两次同步调用之间没有 await，读到的必须是同一个引用；
    // 合并失效的话，第二次调用会把它整个覆盖成一个新 promise。
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rescan-'));
    await fs.writeFile(path.join(root, 'IMG_1.JPG'), 'x');
    const session = await openSession(root);

    const scansBefore = scanFake.calls;
    const p1 = rescanSession(session);
    const inflight1 = session.rescan;
    const p2 = rescanSession(session);
    const inflight2 = session.rescan;
    expect(inflight2).toBe(inflight1);

    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toEqual(b);
    // 最直接的证据：磁盘真的只被扫过一趟，不是凑巧扫了两趟却算出同一个数字。
    expect(scanFake.calls - scansBefore).toBe(1);

    await closeSession(session.id);
    await fs.rm(root, { recursive: true, force: true });
  });
});
