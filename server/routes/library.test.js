import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.js';
import { closeAllSessions, getSessionByRoot } from '../lib/session.js';
import { createShare } from '../lib/shares.js';
import { createUser } from '../lib/users.js';

/**
 * I7：开库不再阻塞到扫描结束。
 *
 * 这一组全部走**真实的 HTTP + 真实的 SSE**：要证明的是"响应真的先回来了、
 * 进度真的从流上到达了客户端"，中间的每一段都算数。往 session.listeners 里
 * 塞假监听者只能证明 emit() 被调用过，那是 session.test.js 那一层的事。
 *
 * 扫描本身用一个可控的桩按在半路——真实的扫描快到无法观测，
 * "在扫描完成之前返回"这句话在一个 2 个文件的临时目录上是没法验证的。
 */
const scanFake = vi.hoisted(() => ({ impl: null, calls: 0 }));

vi.mock('../lib/scan.js', async (importOriginal) => {
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

let server, base, tmp, home, savedHome;
/** 本条用例挂起的扫描闸门，afterEach 一律放行，免得一条超时的用例拖住整个文件。 */
let gates = [];
/** 本条用例开出去的 SSE 连接。 */
let sinks = [];

/**
 * 一个停在半路的扫描。
 * - `batches` / `afterPause`：喂给 onBatch 的**累计**计数（scan.js 的契约就是累计值）
 * - `state.finished`：扫描是不是已经跑完了——"open 没有等它"靠这个字段作证
 */
function pausedScan({ batches = [], afterPause = [], fail = null } = {}) {
  let release;
  const gate = new Promise((r) => { release = r; });
  let reached;
  const paused = new Promise((r) => { reached = r; });
  const state = { finished: false };
  scanFake.calls = 0;
  scanFake.impl = async (root, opts, actual) => {
    for (const found of batches) opts.onBatch?.(found);
    reached();
    await gate;
    for (const found of afterPause) opts.onBatch?.(found);
    if (fail) { state.finished = true; throw fail; }
    const out = await actual.scanFolder(root);   // 真实资产表，但不再重复触发 onBatch
    state.finished = true;
    return out;
  };
  gates.push(release);
  return { release, paused, state };
}

const post = async (p, body) => {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const get = async (p, sid) => {
  const res = await fetch(base + p, sid ? { headers: { 'X-PhotoCull-Session': sid } } : undefined);
  return { status: res.status, body: await res.json() };
};

/** 建一条真实的 SSE 连接并把收到的事件累积起来。 */
async function openStream(sid) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/library/stream?sid=${encodeURIComponent(sid)}`,
    { signal: ctrl.signal });
  if (res.status !== 200) throw new Error(`stream 建立失败：${res.status}`);
  const reader = res.body.getReader();
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { ended = true; break; }
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try { events.push(JSON.parse(line.slice(6))); } catch { /* 心跳等非 JSON 帧 */ }
          }
        }
      }
    } catch { /* abort */ }
  })();
  const sink = {
    events,
    isEnded: () => ended,
    close: () => { ctrl.abort(); return pump; },
  };
  sinks.push(sink);
  return sink;
}

async function waitFor(sink, pred, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = sink.events.find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(`等待事件超时，收到的是：${JSON.stringify(sink.events)}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

const isScan = (e) => e.type === 'scan';
const openLib = (root = tmp) => post('/api/library/open', { root });

beforeAll(async () => {
  savedHome = process.env.PHOTOCULL_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-lib-home-'));
  process.env.PHOTOCULL_HOME = home;

  // 只放 RAW：不生成缩略图，用例跑得快，SSE 上也少一类干扰帧。
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-lib-scan-')));
  for (const stem of ['A', 'B']) await fs.writeFile(path.join(tmp, `${stem}.CR3`), `raw-${stem}`);

  server = createApp().listen(0, '127.0.0.1');   // 回环 = 管理员
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  for (const release of gates) release();
  gates = [];
  scanFake.impl = null;
  for (const sink of sinks) await sink.close();
  sinks = [];
  await closeAllSessions();
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.PHOTOCULL_HOME;
  else process.env.PHOTOCULL_HOME = savedHome;
});

describe('POST /api/library/open 不等扫描（I7）', () => {
  it('扫描还停在半路的时候，open 就已经带着 sessionId 返回了', async () => {
    const { release, paused, state } = pausedScan();

    const res = await openLib();
    // 阻塞版实现走到这一行时扫描还被闸门按着，这条 await 永远回不来 —— 用例超时判红。
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.root).toBe(tmp);
    expect(res.body.phase).toBe('scanning');

    await paused;
    expect(state.finished).toBe(false);   // 响应确实排在扫描结束之前

    release();
    const sink = await openStream(res.body.sessionId);
    await waitFor(sink, (e) => isScan(e) && e.done === true);
  });

  it('扫描进度经 SSE 推送，累计计数单调不减，完成时 done 变 true', async () => {
    const { release } = pausedScan({ batches: [500], afterPause: [1200, 1500] });
    const { body } = await openLib();
    const sink = await openStream(body.sessionId);

    release();
    await waitFor(sink, (e) => isScan(e) && e.done === true);

    const founds = sink.events.filter(isScan).map((e) => e.found);
    expect(founds.length).toBeGreaterThanOrEqual(3);
    expect(founds).toEqual([...founds].sort((a, b) => a - b));   // 累计计数，单调不减
    expect(founds.at(-1)).toBe(1500);
    expect(sink.events.filter(isScan).slice(0, -1).every((e) => e.done === false)).toBe(true);
  });

  it('扫描中途连上来的客户端立刻拿到一份进度快照，不用干等下一批', async () => {
    // 会话按 root 唯一、可以被多个客户端共享，晚到的人必须补得上当前进度。
    const { release } = pausedScan({ batches: [700] });
    const { body } = await openLib();

    const sink = await openStream(body.sessionId);
    const snapshot = await waitFor(sink, isScan);
    expect(snapshot).toMatchObject({ found: 700, done: false });

    release();
  });

  it('扫描完成之后 /assets 拿得到完整资产表', async () => {
    const { release } = pausedScan();
    const { body } = await openLib();
    const sink = await openStream(body.sessionId);
    release();
    await waitFor(sink, (e) => isScan(e) && e.done === true);

    const assets = await get('/api/library/assets', body.sessionId);
    expect(assets.status).toBe(200);
    expect(assets.body.assets.map((a) => a.id)).toEqual(['A', 'B']);
  });

  it('抢在扫描完成之前拉 /assets 的客户端会等到落定，而不是拿到一份空表', async () => {
    // 空表比等一会危险得多：界面上是一个零解释的空网格，而摄影师会以为卡里没照片。
    const { release, paused } = pausedScan();
    const { body } = await openLib();

    let landed = null;
    const pending = get('/api/library/assets', body.sessionId).then((r) => { landed = r; });
    await paused;
    await new Promise((r) => setTimeout(r, 50));
    expect(landed).toBeNull();

    release();
    await pending;
    expect(landed.status).toBe(200);
    expect(landed.body.assets).toHaveLength(2);
  });

  it('扫描失败时推 scan.error、断开连接、清掉会话，且不泄露绝对路径', async () => {
    const boom = Object.assign(
      new Error(`EIO: i/o error, scandir '${tmp}'`), { code: 'EIO' });
    const { release } = pausedScan({ batches: [4], fail: boom });
    const { body } = await openLib();
    const sink = await openStream(body.sessionId);

    release();
    const failure = await waitFor(sink, (e) => isScan(e) && typeof e.error === 'string');
    expect(failure.error).toBeTruthy();
    expect(failure.done).toBe(false);
    // 这条流对 viewer 也是开放的：绝不能把摄影师磁盘上的路径发上去。
    expect(JSON.stringify(sink.events)).not.toContain(tmp);

    // 只发事件不断开不算数：客户端可以忽略事件继续挂着一条再也不会有消息的流。
    for (let i = 0; i < 100 && !sink.isEnded(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(sink.isEnded()).toBe(true);

    // 会话被清理掉了，之后的请求应该 409，前端据此退回选择器。
    expect(getSessionByRoot(tmp)).toBeNull();
    const assets = await get('/api/library/assets', body.sessionId);
    expect(assets.status).toBe(409);
    expect(assets.body.error).toBe('session-gone');
  });

  it('第二次打开同一个文件夹直接是 ready，不重扫', async () => {
    const { release } = pausedScan();
    const first = await openLib();
    release();
    const sink = await openStream(first.body.sessionId);
    await waitFor(sink, (e) => isScan(e) && e.done === true);

    const again = await openLib();
    expect(again.body.sessionId).toBe(first.body.sessionId);
    expect(again.body.phase).toBe('ready');
    expect(again.body.assetCount).toBe(2);
  });
});

describe('写探测排在扫描之前（顺序本身就是需求）', () => {
  const isRootUser = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(isRootUser)('文件夹不可写时 open 直接 400，一个 scan 事件都不产生', async () => {
    // 顺序反过来的话，用户会先看到进度条跑起来，再被告知这个文件夹根本存不下东西。
    // "一个 scan 事件都没有"在这里只能这样证明：那时候连会话都还没有，也就没有
    // 任何订阅者，唯一可靠的证据是**扫描根本没被调用过**。
    const ro = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-lib-ro-')));
    await fs.writeFile(path.join(ro, 'A.CR3'), 'raw');
    await fs.chmod(ro, 0o555);
    pausedScan();
    try {
      const res = await openLib(ro);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('not-writable');
      expect(scanFake.calls).toBe(0);
      expect(getSessionByRoot(ro)).toBeNull();
    } finally {
      await fs.chmod(ro, 0o755);
      await fs.rm(ro, { recursive: true, force: true });
    }
  });

  it('路径不存在时 open 400 no-such-folder，同样不开扫', async () => {
    pausedScan();
    const res = await openLib(path.join(tmp, 'nope', 'deep'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no-such-folder');
    expect(scanFake.calls).toBe(0);
  });
});

describe('POST /api/library/refresh', () => {
  /**
   * `/refresh` 跟 `/close` 一样是写请求，只认 `X-PhotoCull-Session` 请求头
   * （不认 `?sid=`，见 middleware/auth.js 的 sessionIdOf）——这个文件的 `post()`
   * 助手不支持自定义头，这里单独包一层，其余照抄 post()/get() 的返回形状。
   */
  const refreshRequest = (sid, extraHeaders = {}) => fetch(`${base}/api/library/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-PhotoCull-Session': sid, ...extraHeaders },
    body: '{}',
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  it('管理员能刷新', async () => {
    const { body } = await openLib();
    const sink = await openStream(body.sessionId);
    await waitFor(sink, (e) => isScan(e) && e.done === true);

    const res = await refreshRequest(body.sessionId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(typeof res.body.removed).toBe('number');
    expect(typeof res.body.added).toBe('number');
  });

  it('访客不能刷新', async () => {
    // 刷新会重置所有人的视图，一个客户的手滑不该有这个权力。
    //
    // 一个完全没有身份的请求会在全局的 defaultDeny 那一层就被拦成 401
    // no-actor（跟这条路由自己挂没挂 requireAdmin 无关，见 middleware/auth.js）。
    // 要证明的是"认得出身份、但不是管理员"的访客同样进不来，所以这里造一个
    // 真实分享的编辑者身份：带上有效的 pc_user Cookie 通过 defaultDeny，
    // 再用 X-Forwarded-For 触发 resolveActor 的转发头否决（actor.js 的两条
    // 否决之一，跟 routes/share.test.js 限流那组用例是同一个手法）避免这条
    // 回环连接被判成管理员，最终落在 requireAdmin 自己的 403 上。
    const { body } = await openLib();
    const share = await createShare({ root: tmp, label: '刷新权限测试' });
    const user = await createUser(share.id, '编辑', 'editor');

    const res = await refreshRequest(body.sessionId, {
      'X-Forwarded-For': '203.0.113.5',
      cookie: `pc_user=${user.token}`,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('admin-only');
  });
});
