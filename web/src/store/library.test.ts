import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useLibrary } from './library';
import { useView } from './view';
import { useMarks } from './marks';
import { showToast, useNotice } from './notice';
import { markTargets } from '../lib/useKeyboard';
import { clearThumbCache } from '../lib/thumbSource';
import { resetRealtime } from '../lib/realtime';
import { setSession, useSession } from './session';
import type { Mark, Settings } from '../types';

// library.ts 只用到 clearThumbCache；缓存本身是模块私有的，只能从这里观察调用时机。
vi.mock('../lib/thumbSource', () => ({ clearThumbCache: vi.fn() }));

const SETTINGS: Settings = { burstThresholdMs: 1000, cellWidth: 210, sort: 'time' };

interface Reply { status: number; body: unknown }
type Handler = (init?: RequestInit) => Reply | Promise<Reply>;

let handlers: Record<string, Handler>;
let calls: { path: string; init?: RequestInit }[];
let streams: FakeEventSource[];

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  // 真的 EventSource 在首次连上和每一次自动重连成功时都会触发 onopen；
  // Task 17 的「重连后全量补拉」就挂在这上面。
  onopen: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { streams.push(this); }
  close() { this.closed = true; }
}

/** 给一个文件夹准备好 open/assets/marks/close 四个路由。 */
function folder(sessionId: string, root: string, opts: {
  assets?: string[];
  marks?: Record<string, Mark>;
  marksMeta?: Record<string, { by: string; at: number }>;
  marksRecovered?: boolean;
  skippedFiles?: number;
  warnings?: string[];
  /**
   * 开库响应里的 phase（Task 12）。真实服务端在扫描还没跑完时给 'scanning'，
   * 同一个文件夹已经开着（第二个标签页）才给 'ready'。
   */
  phase?: 'scanning' | 'ready';
  marksDelay?: Promise<void>;
} = {}) {
  const ids = opts.assets ?? ['IMG_0002'];
  handlers['/api/library/open'] = () => ({
    status: 200,
    body: {
      sessionId, root,
      phase: opts.phase ?? 'ready',
      // 开库响应发出的那一刻扫描还没跑完，这三个字段在真实服务端上**必然**是空的
      // （server/routes/library.js：「客户端应当按 phase 判断，而不是按这几个值判断」）。
      // 替身照着服务端的真实形状给：任何从开库响应读跳过数的实现都会显示成 0。
      assetCount: 0, warnings: [], skippedFiles: 0,
      settings: SETTINGS,
      marksRecovered: opts.marksRecovered ?? false,
    },
  });
  handlers['/api/library/assets'] = () => ({
    status: 200,
    body: {
      assets: ids.map((id) => ({
        id, dir: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '',
        stem: id, raws: [`${id}.CR3`], jpg: `${id}.JPG`, jpgSize: 1, jpgMtimeMs: 1,
      })),
      warnings: opts.warnings ?? [],
      skippedFiles: opts.skippedFiles ?? 0,
    },
  });
  handlers['/api/library/marks'] = async (init) => {
    if (init?.method === 'PUT') return { status: 200, body: { ok: true } };
    if (opts.marksDelay) await opts.marksDelay;
    return {
      status: 200,
      body: { marks: opts.marks ?? {}, marksMeta: opts.marksMeta, settings: SETTINGS },
    };
  };
  handlers['/api/library/close'] = () => ({ status: 200, body: { ok: true } });
}

beforeEach(() => {
  handlers = {};
  calls = [];
  streams = [];
  vi.mocked(clearThumbCache).mockClear();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    const handler = handlers[path.split('?')[0]];
    if (!handler) throw new Error(`测试未预期的请求：${path}`);
    const { status, body } = await handler(init);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `HTTP ${status}`,
      json: async () => body,
    };
  }));
  useView.getState().reset();
  useMarks.getState().load({});
});

afterEach(() => { vi.unstubAllGlobals(); });

const lib = () => useLibrary.getState();
const headerOf = (path: string) =>
  (calls.find((c) => c.path.split('?')[0] === path)?.init?.headers as Record<string, string> | undefined)
    ?.['X-PhotoCull-Session'];

describe('C3 — 换文件夹时的跨文件夹状态残留', () => {
  it('A 文件夹的 selection 绝不能在 B 文件夹里被当成标记目标', async () => {
    // 同一台相机的两场拍摄天然共享 id，这不是边界情况而是常态。
    folder('sid-a', '/A', { assets: ['IMG_0002', 'IMG_0003'] });
    await lib().open('/A');

    // 在 A 里点一下（或按一次方向键）——setCursor 一定会把 selection 设成非空。
    useView.getState().setCursor('IMG_0002');
    expect(markTargets(useView.getState())).toEqual(['IMG_0002']);

    await lib().close();
    folder('sid-b', '/B', { assets: ['IMG_0002', 'IMG_0003'] });
    await lib().open('/B');

    // 在 B 里一张都还没点过就按 P：不能有任何标记目标。
    expect(markTargets(useView.getState())).toEqual([]);

    // 走完整条链路：按 P 之后 B 的标记必须还是空的。
    useMarks.getState().setMark(markTargets(useView.getState()), 'pick');
    expect(useMarks.getState().marks).toEqual({});
  });

  it('A 文件夹的 dirFilter 不会在 B 文件夹里造成清不掉的空网格', async () => {
    folder('sid-a', '/A', { assets: ['cam-a/IMG_1', 'cam-b/IMG_2'] });
    await lib().open('/A');
    useView.getState().setDirFilter('cam-a');

    await lib().close();
    folder('sid-b', '/B', { assets: ['IMG_9'] });   // 平铺目录，没有 cam-a
    await lib().open('/B');

    expect(useView.getState().dirFilter).toBeNull();
  });

  it('tab / expanded / cursor / anchor / lightbox 一并复位', async () => {
    folder('sid-a', '/A', { assets: ['IMG_0002'] });
    await lib().open('/A');
    useView.setState({
      tab: 'reject', expanded: new Set(['IMG_0002']), lightbox: 'IMG_0002',
    });
    useView.getState().setCursor('IMG_0002');

    await lib().close();
    folder('sid-b', '/B');
    await lib().open('/B');

    const view = useView.getState();
    expect(view.tab).toBe('all');
    expect(view.expanded.size).toBe(0);
    expect(view.cursor).toBeNull();
    expect(view.anchor).toBeNull();
    expect(view.lightbox).toBeNull();
    expect(view.selection.size).toBe(0);
  });

  it('复位与标记加载都发生在 phase 变成 ready 之前，而不是之后', async () => {
    folder('sid-a', '/A', { assets: ['IMG_0002'], marks: { IMG_0002: 'pick' } });
    await lib().open('/A');
    useView.getState().setCursor('IMG_0002');
    expect(useMarks.getState().marks).toEqual({ IMG_0002: 'pick' });

    await lib().close();
    folder('sid-b', '/B', { assets: ['IMG_0002'], marks: { IMG_0002: 'reject' } });

    // 抓住 phase 第一次变成 'ready' 的那一刻：子组件正是在这之后才渲染的，
    // 所以这一刻能看到的就是它们第一帧能看到的。
    let atReady: { selection: number; marks: unknown; cleared: number } | null = null;
    const unsub = useLibrary.subscribe((s) => {
      if (s.phase === 'ready' && atReady === null) {
        atReady = {
          selection: useView.getState().selection.size,
          marks: { ...useMarks.getState().marks },
          cleared: vi.mocked(clearThumbCache).mock.calls.length,
        };
      }
    });
    await lib().open('/B');
    unsub();

    expect(atReady).toEqual({
      selection: 0,
      marks: { IMG_0002: 'reject' },   // 不是 A 的 pick，也不是空的中间态
      cleared: expect.any(Number),
    });
    expect(atReady!.cleared).toBeGreaterThan(0);   // 缩略图缓存也已经清过了
  });

  it('缩略图缓存在 open 和 close 里都被清掉，而不是留给 App 的 effect', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');
    expect(vi.mocked(clearThumbCache).mock.calls.length).toBeGreaterThan(0);

    vi.mocked(clearThumbCache).mockClear();
    await lib().close();
    expect(vi.mocked(clearThumbCache)).toHaveBeenCalled();
  });

  it('上一个文件夹的一次性提示不会挂到下一个文件夹上', async () => {
    // 「3 张因为已有标记被跳过」指的是 A 里那 3 张。它自己 3 秒后会消失，
    // 但换文件夹是瞬间的事，那 3 秒足够让人对着 B 的网格去数哪 3 张。
    folder('sid-a', '/A');
    await lib().open('/A');
    showToast('已隐藏 5 张，3 张因为已有标记被跳过');

    folder('sid-b', '/B');
    await lib().open('/B');

    expect(useNotice.getState().text).toBeNull();
  });
});

describe('C2 — 会话身份', () => {
  it('open 的响应里的 sessionId 存进 store，并随后带在每个请求上', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');

    expect(lib().sessionId).toBe('sid-a');
    expect(headerOf('/api/library/assets')).toBe('sid-a');
    expect(headerOf('/api/library/marks')).toBe('sid-a');
  });

  it('标记 PUT 也带会话头', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');
    calls.length = 0;

    useMarks.getState().setMark(['IMG_0002'], 'pick');
    await new Promise((r) => setTimeout(r, 5));
    expect(headerOf('/api/library/marks')).toBe('sid-a');
  });

  it('SSE 走查询参数带会话（EventSource 设不了请求头）', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toBe('/api/library/stream?sid=sid-a');
  });

  it('409 session-gone 让整个前端退回选择器，且不再请求 /api/library/close', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');
    useView.getState().setCursor('IMG_0002');
    calls.length = 0;

    handlers['/api/library/marks'] = () => ({
      status: 409,
      body: { error: 'session-gone', message: '会话已失效或已被替换，请重新打开文件夹' },
    });
    useMarks.getState().setMark(['IMG_0002'], 'pick');
    await new Promise((r) => setTimeout(r, 5));

    expect(lib().phase).toBe('idle');
    expect(lib().root).toBeNull();
    expect(lib().sessionId).toBeNull();
    expect(lib().error).toBe('会话已失效，请重新打开文件夹');
    expect(useView.getState().selection.size).toBe(0);
    // 会话在服务端已经没了，再调 close 只会换来又一次 409。
    expect(calls.some((c) => c.path === '/api/library/close')).toBe(false);
    expect(streams[0].closed).toBe(true);
  });

  it('close 之后 sessionId 清空', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');
    await lib().close();
    expect(lib().sessionId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 规格 §5.4：仍有访客在线时「换文件夹」要先问一句
//
// 服务端在这种情况下回 409 `guests-online`（见 server/routes/library.js）。
// 客户端这一侧的要求只有一条，但它是硬的：**被拒绝之后本地状态一个字段都不能动。**
// 库还开着、流还连着、标记还在——否则界面回不去也留不下，摄影师看到的是一个
// "看起来还在、其实什么都不会再更新"的网格，比直接关掉更糟。
// ─────────────────────────────────────────────────────────────────────────────

const GUESTS_ONLINE_BODY = {
  error: 'guests-online',
  message: '还有 2 位访客在线，链接仍然有效。关闭文件夹只是你这一侧脱离，'
    + '他们会当场掉线，但手里的链接不会失效——要真正结束访问，请到分享面板撤销这条链接。',
  online: 2,
};

describe('仍有访客在线时的「换文件夹」（规格 §5.4）', () => {
  const blockClose = () => {
    handlers['/api/library/close'] = () => ({ status: 409, body: GUESTS_ONLINE_BODY });
  };

  it('409 guests-online 时本地状态一动不动，流也不关', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');
    useView.getState().setCursor('IMG_0002');
    blockClose();

    await lib().close();

    expect(lib().phase).toBe('ready');
    expect(lib().root).toBe('/A');
    expect(lib().sessionId).toBe('sid-a');
    // 修复前这条流在发请求之前就被 teardown 掉了：请求被拒绝，界面却已经聋了。
    expect(streams[0].closed).toBe(false);
    expect(useView.getState().selection.size).toBe(1);
  });

  it('人数和文案都留在 store 里，供界面照原样显示', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');
    blockClose();

    await lib().close();

    expect(lib().closeBlocked).toEqual({ online: 2, message: GUESTS_ONLINE_BODY.message });
  });

  it('确认之后 close(true) 带上 force，并且真的复位', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');
    blockClose();
    await lib().close();

    // 确认这一步走的是同一条路由，只多一个显式参数——不是绕过去另开一条接口。
    handlers['/api/library/close'] = () => ({ status: 200, body: { ok: true } });
    await lib().close(true);

    const forced = calls.filter((c) => c.path === '/api/library/close').at(-1);
    expect(JSON.parse(String(forced?.init?.body))).toEqual({ force: true });
    expect(lib().phase).toBe('idle');
    expect(lib().root).toBeNull();
    expect(lib().closeBlocked).toBeNull();
    expect(streams[0].closed).toBe(true);
  });

  it('不带 force 时请求体里没有 force 字段（默认落点是不踢人）', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');
    await lib().close();

    const sent = calls.filter((c) => c.path === '/api/library/close').at(-1);
    expect(JSON.parse(String(sent?.init?.body))).toEqual({});
  });

  it('取消（dismissCloseBlock）只清提示，库照旧开着', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');
    blockClose();
    await lib().close();

    lib().dismissCloseBlock();

    expect(lib().closeBlocked).toBeNull();
    expect(lib().phase).toBe('ready');
    expect(lib().root).toBe('/A');
  });

  it('换文件夹时这条提示归零，不会带到下一个库里', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');
    blockClose();
    await lib().close();
    expect(lib().closeBlocked).not.toBeNull();

    folder('sid-b', '/B');
    await lib().open('/B');

    expect(lib().closeBlocked).toBeNull();
  });

  it('online 字段缺失/不是数字时降级成 null，不显示成 NaN', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');
    handlers['/api/library/close'] = () => ({
      status: 409,
      body: { error: 'guests-online', message: '还有访客在线' },
    });

    await lib().close();

    expect(lib().closeBlocked).toEqual({ online: null, message: '还有访客在线' });
  });

  // ── 反向对照 ──────────────────────────────────────────────────────────
  // 一个访客都没有的单机流程里，「换文件夹」必须还是一按就走，
  // 不能因为多了这条分支就多出一道确认。
  it('反向对照：服务端放行时不留任何提示，照常复位', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');

    await lib().close();

    expect(lib().closeBlocked).toBeNull();
    expect(lib().phase).toBe('idle');
    expect(lib().root).toBeNull();
  });

  it('反向对照：别的错误（500）照旧复位，不会被当成"有访客在线"', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');
    handlers['/api/library/close'] = () => ({
      status: 500, body: { error: '关闭时未能把标记写入磁盘：EACCES', code: 'close-failed' },
    });

    await lib().close();

    expect(lib().closeBlocked).toBeNull();
    expect(lib().phase).toBe('idle');
    expect(lib().error).toContain('EACCES');
  });
});

describe('C1 — 不可写文件夹 / 关闭失败', () => {
  it('close 的服务端请求失败时本地状态照样复位（换文件夹按钮不能变成死的）', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');
    useView.getState().setCursor('IMG_0002');

    handlers['/api/library/close'] = () => ({
      status: 500,
      body: { error: "关闭时未能把标记写入磁盘：EACCES: permission denied, mkdir '/A/.photocull'" },
    });

    await lib().close();   // 修复前这里会直接 reject，测试红在这一行

    expect(lib().phase).toBe('idle');
    expect(lib().root).toBeNull();
    expect(lib().error).toContain('EACCES');
    expect(useView.getState().selection.size).toBe(0);
    expect(useMarks.getState().marks).toEqual({});
  });

  it('open 收到 400 not-writable 时，人话和原始 errno 都留在选择器上', async () => {
    handlers['/api/library/open'] = () => ({
      status: 400,
      body: {
        error: 'not-writable',
        message: '这个文件夹不可写，选片进度和缩略图缓存都无法保存。请把照片复制到可写位置后再打开。',
        detail: "EACCES: permission denied, mkdir '/card/.photocull'",
      },
    });

    await lib().open('/card');

    expect(lib().phase).toBe('idle');
    // 修复前 api.ts 把 body.error（机器码）当成 message，用户看到的是 "not-writable"。
    expect(lib().error).toBe(
      '这个文件夹不可写，选片进度和缩略图缓存都无法保存。请把照片复制到可写位置后再打开。');
    expect(lib().errorDetail).toContain('EACCES');
  });
});

describe('I9 / 标记加载', () => {
  it('marksRecovered 与 skippedFiles 被存进 store（否则界面无从展示）', async () => {
    folder('sid-a', '/A', { marksRecovered: true, skippedFiles: 7 });
    await lib().open('/A');
    expect(lib().marksRecovered).toBe(true);
    expect(lib().skippedFiles).toBe(7);
  });

  // Task 12 把扫描从开库里拆了出去：开库响应发出的那一刻扫描还没跑完，
  // warnings / skippedFiles 必然还是空的。照旧从那里读的话，「已跳过 N 个
  // 非照片文件」会永远显示 0——而且不会报错，只是那条提示再也不出现。
  it('skippedFiles 与 warnings 只能从 /assets 拿，不能从开库响应读', async () => {
    folder('sid-a', '/A', { skippedFiles: 7, warnings: ['无法读取目录 tmp：EACCES'] });
    await lib().open('/A');

    expect(lib().skippedFiles).toBe(7);
    expect(lib().warnings).toEqual(['无法读取目录 tmp：EACCES']);
  });

  it('/marks 里的归属表进 marks store（角标的数据来源）', async () => {
    folder('sid-a', '/A', { marks: { IMG_0002: 'pick' }, marksMeta: { IMG_0002: { by: 'u_1', at: 42 } } });
    await lib().open('/A');
    expect(useMarks.getState().marksMeta).toEqual({ IMG_0002: { by: 'u_1', at: 42 } });
  });

  it('老文件夹没有归属表时按空表处理，开库照常成功', async () => {
    folder('sid-a', '/A', { marks: { IMG_0002: 'pick' } });
    await lib().open('/A');
    expect(lib().phase).toBe('ready');
    expect(useMarks.getState().marksMeta).toEqual({});
  });

  it('marksRecovered 在换到一个正常的文件夹后复位', async () => {
    folder('sid-a', '/A', { marksRecovered: true, skippedFiles: 7 });
    await lib().open('/A');
    await lib().close();
    folder('sid-b', '/B');
    await lib().open('/B');
    expect(lib().marksRecovered).toBe(false);
    expect(lib().skippedFiles).toBe(0);
  });

  it('A→B 快速切换时，A 的标记不会盖到 B 上', async () => {
    let releaseA: () => void;
    const slowA = new Promise<void>((r) => { releaseA = r; });

    folder('sid-a', '/A', { marks: { IMG_0002: 'pick' }, marksDelay: slowA });
    const openA = lib().open('/A');
    // A 的标记请求还挂着的时候就切到 B
    folder('sid-b', '/B', { marks: { IMG_0002: 'reject' } });
    const openB = lib().open('/B');
    releaseA!();
    await Promise.all([openA, openB]);

    expect(lib().root).toBe('/B');
    expect(useMarks.getState().marks).toEqual({ IMG_0002: 'reject' });
  });

  it('标记拉取失败时 open 整体失败，而不是把已选过片的文件夹显示成"全部未标记"', async () => {
    folder('sid-a', '/A');
    handlers['/api/library/marks'] = () => ({ status: 500, body: { error: '读取标记失败' } });

    await lib().open('/A');

    expect(lib().phase).toBe('idle');
    expect(lib().error).toBe('读取标记失败');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 20：扫描进度。
//
// Task 12 之后 `POST /open` 立即返回一个 `phase`，扫描在服务端后台跑，进度只从
// SSE 的 `scan` 事件上来。所以这条路径上有两件事必须成立：
//   - 流要在拉资产**之前**建好（`GET /assets` 在服务端会一直等到扫描结束才回应，
//     那几十秒里界面上一个数字都不会有）；
//   - `scan.found` 是**文件**数，不是资产数——一对 RAW+JPG 是两个文件、一个资产。
// ─────────────────────────────────────────────────────────────────────────────

describe('扫描进度（Task 20）', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  // 往**最新**那条流上推：换文件夹之后 streams[0] 是已经关掉的旧流，
  // 往它身上推的帧会被 open() 里的 epoch 守卫原样丢掉（这是对的）。
  const push = (event: unknown) =>
    streams[streams.length - 1].onmessage?.({ data: JSON.stringify(event) });

  it('phase:scanning 时先建流，等到 scan.done 才去拉资产', async () => {
    folder('sid-a', '/A', { phase: 'scanning' });
    const opening = lib().open('/A');
    await tick();

    expect(streams).toHaveLength(1);
    expect(streams[0].url).toBe('/api/library/stream?sid=sid-a');
    expect(calls.some((c) => c.path.startsWith('/api/library/assets'))).toBe(false);
    expect(lib().phase).toBe('scanning');

    push({ type: 'scan', found: 1200, done: true });
    await opening;

    expect(lib().phase).toBe('ready');
    expect(lib().assets).toHaveLength(1);
  });

  it('scan 事件的累计计数进 store，进度条读的就是它', async () => {
    folder('sid-a', '/A', { phase: 'scanning' });
    const opening = lib().open('/A');
    await tick();

    push({ type: 'scan', found: 500, done: false });
    expect(lib().scanFound).toBe(500);
    push({ type: 'scan', found: 1500, done: false });
    expect(lib().scanFound).toBe(1500);

    push({ type: 'scan', found: 1500, done: true });
    await opening;
    expect(lib().phase).toBe('ready');
  });

  it('已经开着的文件夹（phase:ready）不等扫描，直接拉资产', async () => {
    folder('sid-a', '/A', { phase: 'ready' });
    await lib().open('/A');   // 没有任何 scan 事件也必须完成
    expect(lib().phase).toBe('ready');
  });

  it('扫描失败时退回选择器并显示原因，不再去拉资产', async () => {
    folder('sid-a', '/A', { phase: 'scanning' });
    const opening = lib().open('/A');
    await tick();

    // 服务端脱敏后的那句话（server/lib/session.js 的 scanErrorMessage）。
    push({ type: 'scan', found: 300, done: false, error: '扫描文件夹时出错（ENOSPC），请重试' });
    await opening;

    expect(lib().phase).toBe('idle');
    expect(lib().error).toBe('扫描文件夹时出错（ENOSPC），请重试');
    expect(lib().root).toBeNull();
    // 会话在服务端已经被清理掉了，再去拉资产只会换来一次 409，
    // 而那条 409 的文案会把真正的原因盖掉。
    expect(calls.some((c) => c.path.startsWith('/api/library/assets'))).toBe(false);
    // 流必须真的关掉：服务端那一头已经断开，EventSource 会锲而不舍地重连。
    expect(streams[0].closed).toBe(true);
  });

  it('扫描期间实时连接断掉时退回选择器，而不是停在一个永远不动的进度条上', async () => {
    folder('sid-a', '/A', { phase: 'scanning' });
    const opening = lib().open('/A');
    await tick();

    streams[0].onerror?.();
    await opening;

    expect(lib().phase).toBe('idle');
    expect(lib().error).toBeTruthy();
    expect(streams[0].closed).toBe(true);
  });

  it('扫描到一半换文件夹：第一次 open 不会永远挂着', async () => {
    folder('sid-a', '/A', { phase: 'scanning' });
    const openA = lib().open('/A');
    await tick();
    expect(streams).toHaveLength(1);

    folder('sid-b', '/B', { phase: 'ready', assets: ['IMG_9'] });
    const openB = lib().open('/B');

    // 修复前 A 停在一个再也不会 settle 的 promise 上（它等的那条流已经被关掉了），
    // Promise.all 会在这里超时。
    await Promise.all([openA, openB]);

    expect(streams[0].closed).toBe(true);
    expect(lib().root).toBe('/B');
    expect(lib().phase).toBe('ready');
  });

  it('扫描到一半按「换文件夹」：close 之后 open 不再挂着', async () => {
    folder('sid-a', '/A', { phase: 'scanning' });
    const openA = lib().open('/A');
    await tick();

    await lib().close();
    await openA;

    expect(lib().phase).toBe('idle');
    expect(streams[0].closed).toBe(true);
  });

  it('scanFound 在换文件夹时归零（不能把上一个文件夹的数字带过去）', async () => {
    folder('sid-a', '/A', { phase: 'scanning' });
    const opening = lib().open('/A');
    await tick();
    push({ type: 'scan', found: 900, done: false });
    push({ type: 'scan', found: 900, done: true });
    await opening;

    folder('sid-b', '/B', { phase: 'scanning' });
    const second = lib().open('/B');
    await tick();
    expect(lib().scanFound).toBe(0);
    push({ type: 'scan', found: 5, done: true });
    await second;
  });

  it('拉资产失败时把流一起关掉，不留一条没人管的连接', async () => {
    folder('sid-a', '/A');
    handlers['/api/library/assets'] = () => ({ status: 500, body: { error: '读取资产失败' } });

    await lib().open('/A');

    expect(lib().phase).toBe('idle');
    expect(lib().error).toBe('读取资产失败');
    expect(streams).toHaveLength(1);
    expect(streams[0].closed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 17：本地界面（摄影师这一侧）的实时流也要走同一份协同事件路由。
// 访客那一侧在 GuestApp.test.tsx 上有对应覆盖；两侧共用 lib/realtime.ts，
// 不能只有一侧接线——摄影师看不到客户刚做的标记，正是这套东西要解决的问题。
// ─────────────────────────────────────────────────────────────────────────────

describe('实时协同事件的接线（Task 17）', () => {
  beforeEach(() => {
    resetRealtime();
    setSession({ kind: 'admin', user: null, share: null, online: [] });
  });

  afterEach(() => {
    resetRealtime();
    setSession({ kind: 'none', user: null, share: null, online: [] });
  });

  /** 往当前这条 SSE 上推一帧。 */
  const push = (event: unknown) => streams[0].onmessage?.({ data: JSON.stringify(event) });

  it('访客的标记广播合进本地状态', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');

    push({ type: 'marks', origin: 'u_1', seq: 1,
      changes: { IMG_0002: { mark: 'pick', by: 'u_1', at: 1 } } });

    expect(useMarks.getState().marks).toEqual({ IMG_0002: 'pick' });
  });

  it('自己（admin）发出的广播回声被忽略', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');
    useMarks.getState().load({ IMG_0002: 'pick' });

    push({ type: 'marks', origin: 'admin', seq: 2,
      changes: { IMG_0002: { mark: 'reject', by: 'admin', at: 1 } } });

    expect(useMarks.getState().marks).toEqual({ IMG_0002: 'pick' });
  });

  it('presence 事件填进在线名单', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');

    push({ type: 'presence', users: [{ id: 'u_1', nickname: '新娘小林', role: 'editor' }] });

    expect(useSession.getState().online.map((u) => u.nickname)).toEqual(['新娘小林']);
  });

  it('meta / bake 照旧由 library 自己处理，没有被协同路由截走', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');

    push({ type: 'bake', done: 3, total: 10 });
    push({ type: 'meta', metas: [{ id: 'IMG_0002', time: 1, timeSource: 'exif' }] });

    expect(lib().bake).toEqual({ done: 3, total: 10 });
    expect(lib().metas.get('IMG_0002')?.timeSource).toBe('exif');
  });

  it('重连成功后全量补拉 marks，断开期间访客的改动补齐', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');
    calls.length = 0;

    handlers['/api/library/marks'] = async (init) => {
      if (init?.method === 'PUT') return { status: 200, body: { ok: true } };
      return { status: 200, body: { marks: { IMG_0002: 'reject' }, settings: SETTINGS } };
    };

    streams[0].onopen?.();                 // 首次连上：不补拉
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.filter((c) => c.path.startsWith('/api/library/marks'))).toHaveLength(0);

    streams[0].onopen?.();                 // 重连成功：必须补拉
    await new Promise((r) => setTimeout(r, 5));

    expect(calls.filter((c) => c.path.startsWith('/api/library/marks'))).toHaveLength(1);
    expect(useMarks.getState().marks).toEqual({ IMG_0002: 'reject' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 8（复核修复）：setCellWidth 的落盘防抖要认 openEpoch。
//
// 管理员拖动滑块或滚轮缩放（persist=true）会挂起一个 400ms 的定时器；如果这
// 400ms 里发生了「关库 A、开库 B」，定时器到点时回调闭包捕获的还是 A 的
// cellWidth，但 api.ts 里那个模块级的 sessionId 已经指向 B 了——不设防的话
// 这条 PUT 会带着 A 的值打到 B 头上，还会在 B 当前活跃分享的审计日志里留下
// 一条从没在 B 身上真的发生过的 settings.update（审计日志说谎比不记还糟）。
// open()/close() 对完全同类的问题（旧的挂起异步操作在新操作之后才落地）
// 到处校验 openEpoch，setCellWidth 之前是这个文件里唯一没接进这套机制的
// 挂起异步写。
// ─────────────────────────────────────────────────────────────────────────────

describe('setCellWidth 的落盘防抖认 openEpoch', () => {
  beforeEach(() => {
    handlers['/api/library/settings'] = () => ({ status: 200, body: { ok: true, settings: SETTINGS } });
  });

  it('防抖计时器到点之前换库，不会把旧库的缩放值打进新库的 settings', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');

    vi.useFakeTimers();
    try {
      lib().setCellWidth(300);   // persist 默认 true，在 A 的 epoch 下挂起一个 400ms 定时器

      await lib().close();
      folder('sid-b', '/B');
      await lib().open('/B');    // 400ms 还没到，A 挂起的那个定时器还在

      await vi.advanceTimersByTimeAsync(500);   // 越过防抖
    } finally {
      vi.useRealTimers();
    }

    expect(calls.some((c) => c.path === '/api/library/settings')).toBe(false);
  });

  // 反向对照：不这样没法排除上一条用例其实是「setCellWidth 压根不发请求」
  // 这种恒真的可能——中途没有换库，防抖到点后 PUT 必须照常发出去，
  // 带着钳制后的值和当前会话的头。
  it('反向对照：中途没有换库，防抖到点后 PUT 照常发出去', async () => {
    folder('sid-a', '/A');
    await lib().open('/A');
    calls.length = 0;

    vi.useFakeTimers();
    try {
      lib().setCellWidth(300);
      await vi.advanceTimersByTimeAsync(500);
    } finally {
      vi.useRealTimers();
    }

    const sent = calls.find((c) => c.path === '/api/library/settings');
    expect(sent).toBeTruthy();
    expect(JSON.parse(String(sent?.init?.body))).toEqual({ cellWidth: 300 });
    expect(headerOf('/api/library/settings')).toBe('sid-a');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 12：前端刷新按钮。
//
// POST /api/library/refresh 原地重扫当前文件夹（Task 11 已经做好服务端）。成功后
// 资产表要重新拉一遍——服务端不通过 SSE 推整份表，三千条资产一帧推出去只会把
// SSE 的缓冲撑爆。已经从磁盘上消失的资产不能继续被 cursor / lightbox / selection
// 指着：那是一个悬空指针，键盘导航的 order.indexOf(cursor) 会静默拿到 -1，
// 大图会停在一张打不开的照片上。失败则相反——旧资产表一个字段都不能动，
// 只留一条 error（旧文件夹还能继续选，这和 open() 失败退回选择器不一样）。
// ─────────────────────────────────────────────────────────────────────────────

describe('refresh', () => {
  /** `/api/library/assets` 里单条资产的形状，照抄 folder() 内部用的那份。 */
  const asset = (id: string) => ({
    id, dir: '', stem: id, raws: [`${id}.CR3`], jpg: `${id}.JPG`, jpgSize: 1, jpgMtimeMs: 1,
  });

  it('刷新成功后资产表被替换，refreshResult 记下增减', async () => {
    handlers['/api/library/refresh'] = () => ({ status: 200, body: { ok: true, removed: 2, added: 1 } });
    handlers['/api/library/assets'] = () => ({
      status: 200,
      body: { assets: [asset('IMG_9')], warnings: [], skippedFiles: 0 },
    });

    await lib().refresh();

    expect(lib().assets.map((a) => a.id)).toEqual(['IMG_9']);
    expect(lib().refreshResult).toEqual({ removed: 2, added: 1 });
    expect(lib().refreshing).toBe(false);
  });

  it('刷新失败时资产表原样不动，只留一条错误', async () => {
    useLibrary.setState({ assets: [asset('IMG_1')] });
    handlers['/api/library/refresh'] = () => ({
      status: 503,
      body: { error: 'rescan-failed', message: '扫描文件夹时出错（ENOENT），请重试' },
    });

    await lib().refresh();

    expect(lib().assets.map((a) => a.id)).toEqual(['IMG_1']);
    expect(lib().error).toContain('扫描文件夹时出错');
    expect(lib().refreshing).toBe(false);
  });

  it('刷新掉的资产不再被 cursor / lightbox / selection 指着', async () => {
    // 悬空指针：order.indexOf(cursor) 会静默拿到 -1，键盘导航跳回列表开头，
    // 而大图会停在一张磁盘上已经不存在的照片上。
    useView.setState({
      cursor: 'IMG_1', lightbox: 'IMG_1', selection: new Set(['IMG_1', 'IMG_9']),
    });
    handlers['/api/library/refresh'] = () => ({ status: 200, body: { ok: true, removed: 1, added: 0 } });
    handlers['/api/library/assets'] = () => ({
      status: 200,
      body: { assets: [asset('IMG_9')], warnings: [], skippedFiles: 0 },
    });

    await lib().refresh();

    expect(useView.getState().cursor).toBeNull();
    expect(useView.getState().lightbox).toBeNull();
    expect([...useView.getState().selection]).toEqual(['IMG_9']);
  });
});
