import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../index.js';
import { closeAllSessions } from '../lib/session.js';
import { createShare, revokeShare, listShares, updateShare } from '../lib/shares.js';
import { createUser } from '../lib/users.js';
import { readEvents } from '../lib/audit.js';
import { CELL_WIDTH_MAX } from '../lib/store.js';

/**
 * Task 10：标记归属与广播。
 *
 * 三件事必须同时成立，而且必须一起测：
 *   1. 写标记会**广播**给该会话的每一个 SSE 监听者，带 origin / seq / changes；
 *   2. 每一次写都**留痕**（单张 mark.set / 批量 mark.bulk），令牌不落盘；
 *   3. 被 403 拒掉的写**什么都不产生** —— 那次操作没有发生。
 *
 * SSE 现在对 viewer 开放（Task 7），所以广播体直达访客：里面不得出现令牌，
 * 也不得出现摄影师磁盘上的绝对路径。
 */

/**
 * 记下每一次 logEvent 的实参，同时**照常执行真实实现**（下面的 readEvents 断言
 * 全都依赖真实落盘）。
 *
 * 为什么需要它：「令牌不落盘」这条性质，光靠"读 events.jsonl 搜不到令牌"是钉不住的——
 * 这条路径本来就不往事件里放令牌，把脱敏参数整个删掉，那种断言照样全绿。
 * 真正要钉的是**闸门确实接着**：logEvent 的第三个参数拿到了该分享名下的全部令牌。
 * 明天有人往事件里加一个字段时，接着的闸门会兜住，没接的不会。
 */
const auditSpy = vi.hoisted(() => ({ calls: [] }));

vi.mock('../lib/audit.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    logEvent: (...args) => { auditSpy.calls.push(args); return actual.logEvent(...args); },
  };
});

/** 访客请求的伪造源地址。必须不是回环，否则 resolveActor 直接判成管理员。 */
const GUEST_IP = '192.168.1.50';

let server;
let base;
let home;        // PHOTOCULL_HOME
let tmp;         // 被分享的照片文件夹
let bare;        // 没有任何分享指向它的文件夹（本机单机使用）
let savedHome;
let shareId;
let shareToken;
let editorToken;
let viewerToken;
let sid = '';    // tmp 那个会话的 id
let remoteOverride = null;
/** 用例里建过的 SSE 连接，afterAll 统一断掉。 */
const streams = [];

/** 第 201 张开始是为了测「assetIds 上限 200」造的，id 形如 bulk/B000。 */
const BULK_COUNT = 201;
const bulkIds = Array.from({ length: BULK_COUNT }, (_, i) => `bulk/B${String(i).padStart(3, '0')}`);

beforeAll(async () => {
  savedHome = process.env.PHOTOCULL_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-marks-home-'));
  process.env.PHOTOCULL_HOME = home;

  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'marks-src-')));
  bare = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'marks-bare-')));
  await fs.mkdir(path.join(tmp, 'cam-a'), { recursive: true });
  await fs.mkdir(path.join(tmp, 'bulk'), { recursive: true });
  await sharp({ create: { width: 160, height: 120, channels: 3, background: { r: 8, g: 60, b: 120 } } })
    .jpeg().toFile(path.join(tmp, 'A.JPG'));
  await fs.writeFile(path.join(tmp, 'A.CR3'), 'fake raw');
  await fs.writeFile(path.join(tmp, 'cam-a', 'IMG_0421.CR3'), 'fake raw');
  // Task 15：隐藏接口的专用夹具。同样是孤儿 RAW，理由同上一行。
  // IMG_3 专供审计留痕那组用例：需要一个跟被测那次调用无关、但已经处于隐藏
  // 状态的 id，用来把"记实际生效的 id"和"记 setHidden 返回的整份 hidden 集合"
  // 这两种实现分开——两者在只有 IMG_1/IMG_2 的夹具里可能给出巧合相同的答案。
  await fs.writeFile(path.join(tmp, 'cam-a', 'IMG_1.CR3'), 'fake raw');
  await fs.writeFile(path.join(tmp, 'cam-a', 'IMG_2.CR3'), 'fake raw');
  await fs.writeFile(path.join(tmp, 'cam-a', 'IMG_3.CR3'), 'fake raw');
  // 孤儿 RAW 也是资产（见 scan.js 的 pairEntries），造起来比 JPG 便宜得多。
  for (const id of bulkIds) {
    await fs.writeFile(path.join(tmp, `${id}.CR3`), 'fake raw');
  }
  await fs.writeFile(path.join(bare, 'Z.CR3'), 'fake raw');

  const share = await createShare({ root: tmp, label: '协同选片', defaultRole: 'editor' });
  shareId = share.id;
  shareToken = share.token;
  editorToken = (await createUser(share.id, '新娘小林', 'editor')).token;
  viewerToken = (await createUser(share.id, '只读伴娘', 'viewer')).token;

  const app = createApp();
  server = http.createServer((req, res) => {
    delete req.socket.remoteAddress;
    if (remoteOverride !== null) {
      Object.defineProperty(req.socket, 'remoteAddress', { value: remoteOverride, configurable: true });
    }
    app(req, res);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  sid = (await openLibrary(tmp)).sessionId;
});

afterAll(async () => {
  // SSE 连接必须先断：还挂着连接时 server.close() 会一直等下去。
  for (const sink of streams) await sink.close();
  await closeAllSessions();
  await new Promise((r) => server.close(r));
  if (savedHome === undefined) delete process.env.PHOTOCULL_HOME;
  else process.env.PHOTOCULL_HOME = savedHome;
  for (const dir of [home, tmp, bare]) await fs.rm(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 请求助手
// ─────────────────────────────────────────────────────────────────────────────

const TOKENS = { admin: null, editor: () => editorToken, viewer: () => viewerToken };

function headersFor(identity, session) {
  const headers = { 'content-type': 'application/json' };
  if (session) headers['X-PhotoCull-Session'] = session;
  const token = TOKENS[identity]?.();
  if (token) headers.cookie = `pc_user=${token}`;
  return headers;
}

async function openLibrary(root) {
  remoteOverride = null;
  const res = await fetch(`${base}/api/library/open`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root }),
  });
  return res.json();
}

/** 以指定身份 PUT 一批标记。 */
async function putMarks(identity, marks, session = sid) {
  remoteOverride = identity === 'admin' ? null : GUEST_IP;
  return fetch(`${base}/api/library/marks`, {
    method: 'PUT', headers: headersFor(identity, session), body: JSON.stringify({ marks }),
  });
}

async function getMarks(identity = 'admin', session = sid) {
  remoteOverride = identity === 'admin' ? null : GUEST_IP;
  const res = await fetch(`${base}/api/library/marks`, { headers: headersFor(identity, session) });
  return res.json();
}

/** 改全局设置。这条路由是 admin-only，所以没有身份参数。 */
async function putSettings(patch, session = sid) {
  remoteOverride = null;
  return fetch(`${base}/api/library/settings`, {
    method: 'PUT', headers: headersFor('admin', session), body: JSON.stringify(patch),
  });
}

/**
 * Task 15：管理员身份的 PUT / GET，返回已经解析好的 `{ status, body }`。
 *
 * 跟上面几个助手（返回原始 Response，调用方自己 `await .json()`）不是同一种
 * 形状——隐藏接口这组用例习惯了 `res.body.xxx` 这种写法（admin.test.js 的
 * `get`/`post` 就是这个形状）。两种助手在本文件里并存没有冲突：各自的用例
 * 只用各自那一种，都是本文件内部实现细节，不影响被测路由本身。
 */
async function adminPut(p, payload, session = sid) {
  remoteOverride = null;
  const res = await fetch(`${base}${p}`, {
    method: 'PUT', headers: headersFor('admin', session), body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function adminGet(p, session = sid) {
  remoteOverride = null;
  const res = await fetch(`${base}${p}`, { headers: headersFor('admin', session) });
  return { status: res.status, body: await res.json() };
}

/** 管理接口用的是 PATCH（改分享设置），不是上面那个 PUT。 */
async function adminPatch(p, payload, session = sid) {
  remoteOverride = null;
  const res = await fetch(`${base}${p}`, {
    method: 'PATCH', headers: headersFor('admin', session), body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE 监听
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 建一条真实的 SSE 连接并把收到的事件累积起来。
 * 不直接往 session.listeners 里塞假监听者：那样测的是 emit()，
 * 而这里要证明的是"访客真的收得到"，中间的每一段都算数。
 */
async function openStream(identity, session = sid) {
  remoteOverride = identity === 'admin' ? null : GUEST_IP;
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/library/stream`, {
    headers: headersFor(identity, session), signal: ctrl.signal,
  });
  if (res.status !== 200) throw new Error(`stream 建立失败：${res.status}`);
  const reader = res.body.getReader();
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
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
  return { events, close: () => { ctrl.abort(); return pump; } };
}

async function waitFor(sink, pred, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = sink.events.find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(`等待事件超时，收到的是：${JSON.stringify(sink.events)}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const isMarks = (e) => e.type === 'marks';

/** 该分享名下这次操作**新增**的审计记录（readEvents 是倒序，新的在前）。 */
async function auditDelta(fn, id = shareId) {
  const before = await readEvents(id, {});
  await fn();
  const after = await readEvents(id, {});
  return after.slice(0, after.length - before.length);
}

async function stream(identity) {
  const sink = await openStream(identity);
  streams.push(sink);
  return sink;
}

beforeEach(async () => {
  // 每条用例自己摆初始状态，避免上一条留下的标记影响 from。
  for (const sink of streams) sink.events.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
// 广播
// ─────────────────────────────────────────────────────────────────────────────

describe('SSE 广播', () => {
  it('editor 写标记时，会话里的每一个监听者都收到带 origin 的 marks 事件', async () => {
    const asAdmin = await stream('admin');
    const asViewer = await stream('viewer');

    expect((await putMarks('editor', { A: 'pick' })).status).toBe(200);

    for (const sink of [asAdmin, asViewer]) {
      const event = await waitFor(sink, isMarks);
      expect(event.origin).toMatch(/^u_/);
      expect(event.changes.A.mark).toBe('pick');
      expect(event.changes.A.by).toBe(event.origin);
      expect(typeof event.changes.A.at).toBe('number');
      expect(typeof event.seq).toBe('number');
    }
  });

  it('管理员写的 origin 是字面量 admin', async () => {
    const sink = await stream('admin');
    await putMarks('admin', { A: 'reject' });
    const event = await waitFor(sink, isMarks);
    expect(event.origin).toBe('admin');
    expect(event.changes.A).toEqual({ mark: 'reject', by: 'admin', at: expect.any(Number) });
  });

  it('清除标记时 changes 里的 mark 是 null', async () => {
    await putMarks('editor', { A: null });
    const sink = await stream('admin');
    await putMarks('admin', { A: 'pick' });
    await waitFor(sink, isMarks);
    sink.events.length = 0;

    await putMarks('admin', { A: null });
    const event = await waitFor(sink, isMarks);
    expect(event.changes.A.mark).toBeNull();
  });

  it('清除自己的标记后仍有其他人的意见时，广播有效标记和各自票的变化', async () => {
    await putMarks('editor', { A: 'pick' });
    await putMarks('admin', { A: 'reject' });
    const sink = await stream('admin');
    await putMarks('admin', { A: null });
    const event = await waitFor(sink, isMarks);
    expect(event.changes.A.mark).toBe('pick');
    expect(event.changes.A.by).not.toBe('admin');
    expect(event.contribChanges.A).toMatchObject({ by: 'admin', mark: null });
  });

  it('seq 在同一个会话里严格递增', async () => {
    const sink = await stream('admin');
    await putMarks('admin', { A: 'pick' });
    const first = await waitFor(sink, isMarks);
    sink.events.length = 0;
    await putMarks('admin', { A: 'reject' });
    const second = await waitFor(sink, isMarks);
    expect(second.seq).toBeGreaterThan(first.seq);
  });

  it('广播体里没有令牌，也没有摄影师磁盘上的绝对路径', async () => {
    const sink = await stream('viewer');
    await putMarks('editor', { 'cam-a/IMG_0421': 'pick' });
    const event = await waitFor(sink, isMarks);
    const text = JSON.stringify(event);
    for (const secret of [shareToken, editorToken, viewerToken, tmp, home]) {
      expect(text).not.toContain(secret);
    }
  });

  it('空的一批既不广播也不留痕', async () => {
    const sink = await stream('admin');
    const added = await auditDelta(async () => {
      expect((await putMarks('admin', {})).status).toBe(200);
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(sink.events.filter(isMarks)).toEqual([]);
    expect(added).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 留痕
// ─────────────────────────────────────────────────────────────────────────────

describe('审计留痕', () => {
  it('单张写产生且仅产生一条 mark.set，带 assetId / from / to', async () => {
    // 'A' 从上面「SSE 广播」那组用例开始就被 editor、admin 轮流标记过。取消
    // 现在是按人减票（Task 14 contrib）：admin 一个人的 null 写只会摘掉 admin
    // 自己那一票，摘不掉 editor 留下的那一票，'A' 没法再靠这一下冲回"从未
    // 标记过"。改用 bulk/B200：批量测试用的是前 3 个和全量两组，都在这条
    // 用例之后才跑，这里天然是没人碰过的起点，from: null 才有意义。
    const id = 'bulk/B200';

    const added = await auditDelta(async () => {
      expect((await putMarks('editor', { [id]: 'pick' })).status).toBe(200);
    });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      action: 'mark.set', assetId: id, from: null, to: 'pick', nickname: '新娘小林',
    });
    expect(added[0].actor).toMatch(/^u_/);

    // from 是写之前那一刻的值，不是恒为 null。
    const again = await auditDelta(async () => { await putMarks('editor', { [id]: 'reject' }); });
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ action: 'mark.set', from: 'pick', to: 'reject' });
  });

  it('批量写产生一条 mark.bulk，带 count / to / assetIds', async () => {
    const ids = bulkIds.slice(0, 3);
    const patch = Object.fromEntries(ids.map((id) => [id, 'pick']));
    const added = await auditDelta(async () => {
      expect((await putMarks('editor', patch)).status).toBe(200);
    });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ action: 'mark.bulk', count: 3, to: 'pick' });
    expect(added[0].assetIds).toEqual(ids);
  });

  it('assetIds 超过 200 时只记数量，不把整张清单写进日志', async () => {
    const patch = Object.fromEntries(bulkIds.map((id) => [id, 'reject']));
    const added = await auditDelta(async () => {
      expect((await putMarks('editor', patch)).status).toBe(200);
    });
    expect(added).toHaveLength(1);
    expect(added[0].action).toBe('mark.bulk');
    expect(added[0].count).toBe(BULK_COUNT);
    expect(added[0].assetIds).toBeUndefined();
  });

  it('令牌不会因为这条路径落进日志', async () => {
    await putMarks('editor', { A: 'pick' });
    const raw = await fs.readFile(path.join(home, 'shares', shareId, 'events.jsonl'), 'utf8');
    for (const token of [shareToken, editorToken, viewerToken]) {
      expect(raw).not.toContain(token);
    }
  });

  it('留痕时把该分享名下的全部令牌交给了脱敏闸门（第三个参数必须传）', async () => {
    auditSpy.calls.length = 0;
    await putMarks('editor', { A: 'reject' });
    const call = auditSpy.calls.find(([, event]) => event.action === 'mark.set');
    expect(call, 'mark.set 必须走 logEvent').toBeTruthy();
    const tokens = call[2];
    // share.token + 其下每一个 user.token，一个都不能少：少哪个，哪个就有可能
    // 在将来某个新字段里原样落盘。
    for (const token of [shareToken, editorToken, viewerToken]) {
      expect(tokens).toContain(token);
    }
  });

  /**
   * 访客的写**只记进自己那条分享**，不顺带记进同 root 的其它分享。
   *
   * 这不是"少记一条"的取舍，反过来才是错的：把访客的 userId 和昵称抄进另一批人
   * 的日志和 CSV 里，是一次跨分享的信息泄露——摄影师给同一个文件夹建"新人链接"
   * 和"父母链接"是这个功能被设计出来的用法，两拨人之间没有任何关系。
   * lib/presence.js 的名单过滤跟这条是同一个口径。
   *
   * 这条性质此前没有任何测试守着：上面那条只测了管理员那一支。
   */
  it('访客的写只记进自己那条分享，同 root 的另一条不记', async () => {
    const sibling = await createShare({ root: tmp, label: '同一个文件夹的另一条链接' });
    const before = new Map();
    for (const id of [shareId, sibling.id]) before.set(id, (await readEvents(id, {})).length);

    await putMarks('editor', { A: 'pick' });

    const delta = async (id) => (await readEvents(id, {})).length - before.get(id);
    expect(await delta(shareId)).toBe(1);
    expect(await delta(sibling.id), '另一条链接的日志里不该出现这个人').toBe(0);

    // 反面再钉一次：那条分享的日志里一个字都不该提到这个访客。
    const text = JSON.stringify(await readEvents(sibling.id, {}));
    expect(text).not.toContain('新娘小林');
  });

  it('管理员的写按该会话 root 下的每一条活跃分享各记一条；撤销的那条不记', async () => {
    const second = await createShare({ root: tmp, label: '第二条' });
    const dead = await createShare({ root: tmp, label: '已撤销' });
    await revokeShare(dead.id);
    const elsewhere = await createShare({ root: bare, label: '别的文件夹' });

    const before = new Map();
    for (const id of [shareId, second.id, dead.id, elsewhere.id]) {
      before.set(id, (await readEvents(id, {})).length);
    }

    await putMarks('admin', { A: 'pick' });

    const delta = async (id) => (await readEvents(id, {})).length - before.get(id);
    expect(await delta(shareId)).toBe(1);
    expect(await delta(second.id)).toBe(1);
    expect(await delta(dead.id)).toBe(0);
    expect(await delta(elsewhere.id)).toBe(0);

    const [event] = await readEvents(second.id, { limit: 1 });
    expect(event).toMatchObject({ action: 'mark.set', actor: 'admin', assetId: 'A', to: 'pick' });
  });

  it('root 下一条分享都没有时，管理员的写不留痕（本机单机使用没有审计对象）', async () => {
    // bare 在上一条用例里已经被挂上了一条分享，这里另开一个谁都没分享过的文件夹。
    const lonely = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'marks-lonely-')));
    try {
      await fs.writeFile(path.join(lonely, 'Z.CR3'), 'fake raw');
      const lonelySid = (await openLibrary(lonely)).sessionId;
      const counts = new Map();
      for (const s of await listShares()) counts.set(s.id, (await readEvents(s.id, {})).length);

      expect((await putMarks('admin', { Z: 'pick' }, lonelySid)).status).toBe(200);

      for (const s of await listShares()) {
        expect(await readEvents(s.id, {}).then((e) => e.length), `${s.label} 不该多出记录`)
          .toBe(counts.get(s.id) ?? 0);
      }
    } finally {
      await fs.rm(lonely, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 设置变更留痕
//
// 规格 3.4 的动作表里有 `settings.update`，但一度没有任何代码产生它。
// 这不是"少记一条无关紧要的事"：连拍阈值决定**所有人看到的分组**，
// 摄影师把它从 1 秒改成 5 秒，每个客户屏幕上的连拍堆当场重排，
// 而审计日志里一个字都没有——事后没人能解释"刚才那一屏为什么变了"。
// ─────────────────────────────────────────────────────────────────────────────

describe('设置变更留痕（settings.update）', () => {
  it('改连拍阈值产生且仅产生一条 settings.update，带变更前后的字段', async () => {
    await putSettings({ burstThresholdMs: 2000 });   // 摆一个已知的起点

    const added = await auditDelta(async () => {
      expect((await putSettings({ burstThresholdMs: 3500 })).status).toBe(200);
    });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      action: 'settings.update',
      actor: 'admin',
      from: { burstThresholdMs: 2000 },
      to: { burstThresholdMs: 3500 },
    });
    // 访客改不了设置（这条路由是 admin-only），所以永远不该有 nickname。
    expect(added[0].nickname).toBeUndefined();
  });

  it('只记真的变了的字段，未改动的和不认识的都不进日志', async () => {
    await putSettings({ burstThresholdMs: 4000, sort: 'time' });

    const added = await auditDelta(async () => {
      // burstThresholdMs 原样送回（没变），sort 换一个（变了），
      // burstMs 是个不存在的字段（会被 allowed 白名单挡在外面）。
      expect((await putSettings({
        burstThresholdMs: 4000, sort: 'name', burstMs: 999,
      })).status).toBe(200);
    });
    expect(added).toHaveLength(1);
    expect(added[0].to).toEqual({ sort: 'name' });
    expect(added[0].from).toEqual({ sort: 'time' });
  });

  it('一个字段都没真的变时什么都不记', async () => {
    await putSettings({ burstThresholdMs: 4500 });
    const added = await auditDelta(async () => {
      // 原样再发一次，外加一个白名单之外的字段。
      expect((await putSettings({ burstThresholdMs: 4500, nope: 1 })).status).toBe(200);
    });
    // 一条 {} 的变更记录读起来像是发生过什么，实际什么也没发生——
    // 那是审计日志里最容易误导人的一种噪音（与 share.update 同一口径）。
    expect(added).toEqual([]);
  });

  it('按该会话 root 下的每一条活跃分享各记一条；撤销的和别的文件夹的都不记', async () => {
    const second = await createShare({ root: tmp, label: '设置-第二条' });
    const dead = await createShare({ root: tmp, label: '设置-已撤销' });
    await revokeShare(dead.id);
    const elsewhere = await createShare({ root: bare, label: '设置-别的文件夹' });

    const before = new Map();
    for (const id of [shareId, second.id, dead.id, elsewhere.id]) {
      before.set(id, (await readEvents(id, {})).length);
    }

    expect((await putSettings({ burstThresholdMs: 5000 })).status).toBe(200);

    const delta = async (id) => (await readEvents(id, {})).length - before.get(id);
    expect(await delta(shareId)).toBe(1);
    expect(await delta(second.id)).toBe(1);
    expect(await delta(dead.id)).toBe(0);
    expect(await delta(elsewhere.id)).toBe(0);

    const [event] = await readEvents(second.id, { limit: 1 });
    expect(event).toMatchObject({
      action: 'settings.update', actor: 'admin', to: { burstThresholdMs: 5000 },
    });
  });

  it('root 下一条分享都没有时不留痕（本机单机使用没有审计对象）', async () => {
    const lonely = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'settings-lonely-')));
    try {
      await fs.writeFile(path.join(lonely, 'Z.CR3'), 'fake raw');
      const lonelySid = (await openLibrary(lonely)).sessionId;
      const counts = new Map();
      for (const s of await listShares()) counts.set(s.id, (await readEvents(s.id, {})).length);

      expect((await putSettings({ burstThresholdMs: 5500 }, lonelySid)).status).toBe(200);

      for (const s of await listShares()) {
        expect(await readEvents(s.id, {}).then((e) => e.length), `${s.label} 不该多出记录`)
          .toBe(counts.get(s.id) ?? 0);
      }
    } finally {
      await fs.rm(lonely, { recursive: true, force: true });
    }
  });

  it('留痕时把该分享名下的全部令牌交给了脱敏闸门（第三个参数必须传）', async () => {
    auditSpy.calls.length = 0;
    expect((await putSettings({ burstThresholdMs: 6000 })).status).toBe(200);

    // 按 shareId 定位，不取"第一条 settings.update"：管理员的这次改动会往
    // root 下每一条活跃分享各记一条，而上面的用例已经建过几条没有用户的分享，
    // 它们的令牌清单当然只有一个元素——那不是漏了脱敏，是找错了行。
    const call = auditSpy.calls.find(
      ([id, event]) => id === shareId && event.action === 'settings.update');
    expect(call, 'settings.update 必须走 logEvent').toBeTruthy();
    const tokens = call[2];
    // share.token + 其下每一个 user.token，一个都不能少：少哪个，哪个就有可能
    // 在将来某个新字段里原样落盘。
    for (const token of [shareToken, editorToken, viewerToken]) {
      expect(tokens).toContain(token);
    }
  });

  it('设置的响应体和落盘的日志里都没有令牌', async () => {
    const res = await putSettings({ burstThresholdMs: 6500 });
    const body = JSON.stringify(await res.json());
    const raw = await fs.readFile(path.join(home, 'shares', shareId, 'events.jsonl'), 'utf8');
    for (const token of [shareToken, editorToken, viewerToken]) {
      expect(body).not.toContain(token);
      expect(raw).not.toContain(token);
    }
  });

  // cellWidth 的归一必须发生在 from/to 的审计差异算出来之前——否则日志会
  // 记下管理员实际发送的原始值（比如 9999），而磁盘上落的是钳制后的值，
  // 审计日志因此会说谎。这两条钉住归一之后的值才是日志里出现的值。
  it('cellWidth 超范围：响应体和审计日志里的 to 都是钳制后的值，不是原始输入', async () => {
    await putSettings({ cellWidth: 210 });   // 摆一个已知的起点

    const added = await auditDelta(async () => {
      const res = await putSettings({ cellWidth: 9999 });
      expect(res.status).toBe(200);
      expect((await res.json()).settings.cellWidth).toBe(CELL_WIDTH_MAX);
    });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      action: 'settings.update',
      from: { cellWidth: 210 },
      to: { cellWidth: CELL_WIDTH_MAX },
    });
  });

  it('cellWidth 归一后与当前值相同时（已经是上限又发一个更大的数）：判定成没有变化，不产生审计噪音', async () => {
    await putSettings({ cellWidth: CELL_WIDTH_MAX });   // 摆到上限

    const added = await auditDelta(async () => {
      const res = await putSettings({ cellWidth: 9999 });   // 归一后同样是上限
      expect(res.status).toBe(200);
      expect((await res.json()).settings.cellWidth).toBe(CELL_WIDTH_MAX);
    });
    expect(added).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 被拒的写"没有发生"
// ─────────────────────────────────────────────────────────────────────────────

describe('viewer 的写被拒之后', () => {
  it('403 之后既不留痕也不广播（而同一条流上 editor 的写照样收得到）', async () => {
    const sink = await stream('admin');

    const added = await auditDelta(async () => {
      const res = await putMarks('viewer', { A: 'pick' });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('read-only');
    });
    expect(added).toEqual([]);
    await new Promise((r) => setTimeout(r, 200));
    expect(sink.events.filter(isMarks)).toEqual([]);

    // 对照组：这条流本身是活的，上面那条"没收到"才有意义。
    await putMarks('editor', { A: 'reject' });
    await waitFor(sink, isMarks);
  });

  it('403 的那一张标记根本没有落到 marks 上', async () => {
    // 不假设 A 此刻的值是什么——这个文件里好几组用例已经用不同的 actor 标记过
    // 它，取消现在是按人减票（Task 14 contrib），单个 admin 的 null 写不再
    // 保证能把它冲回未标记状态。真正要钉住的不变量是"被拒的写没有任何副作
    // 用"，用前后对照来验，不依赖某个具体的起始值。
    const before = (await getMarks()).marks.A;
    expect((await putMarks('viewer', { A: 'pick' })).status).toBe(403);
    expect((await getMarks()).marks.A).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// persist-failed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 落盘失败（只读文件夹、只读网络挂载、磁盘写满）之后的那条路径。
 *
 * 落盘是防抖后台做的，所以这一批的结果这会儿还不知道；但**上一批**如果写失败了，
 * 错误就一直存在 markStore 里。路由取走它并如实回 500 `persist-failed`，
 * 而客户端收到 500 会把这一批乐观更新回滚掉——所以这条路径上**既不广播也不留痕**：
 * 广播出去等于让别人看到一个发起者自己已经撤销的值；留痕等于在日志里记下一件
 * 磁盘上没有发生的事。
 *
 * 这条性质在代码注释里被当成性质写死，此前零测试。
 * 这里直接把 `markStore.takeError()` 换成"下一次返回一个错误"——那正是路由唯一
 * 读的那个信号，比真的去造一个只读文件夹更精确（后者还会牵扯到开库时的写探测）。
 */
describe('persist-failed', () => {
  it('500 之后既不广播也不留痕', async () => {
    const { getSession } = await import('../lib/session.js');
    const session = getSession(sid);
    const store = session.markStore;
    const original = store.takeError;
    let armed = true;
    store.takeError = () => {
      if (!armed) return original.call(store);
      armed = false;
      return new Error('磁盘写满了');
    };

    const sink = await stream('admin');
    try {
      const added = await auditDelta(async () => {
        const res = await putMarks('editor', { A: 'pick' });
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toBe('persist-failed');
        // 原因要如实带出来：一句泛泛的"保存失败"没法告诉摄影师该去处理什么。
        expect(body.message).toContain('磁盘写满了');
      });
      expect(added, '写不进磁盘的这一批不该留痕').toEqual([]);

      await new Promise((r) => setTimeout(r, 200));
      expect(sink.events.filter(isMarks), '写不进磁盘的这一批不该广播').toEqual([]);

      // 对照组：这条流是活的、留痕也照常——上面两条"什么都没有"才有意义。
      const after = await auditDelta(async () => {
        expect((await putMarks('editor', { A: 'reject' })).status).toBe(200);
      });
      expect(after).toHaveLength(1);
      await waitFor(sink, isMarks);
    } finally {
      store.takeError = original;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 归属的读取面
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/library/marks', () => {
  it('把 marksMeta 一并返回，且 marks 字段形状不变', async () => {
    await putMarks('editor', { 'cam-a/IMG_0421': 'pick' });
    const data = await getMarks('viewer');
    expect(data.marks['cam-a/IMG_0421']).toBe('pick');
    expect(data.marksMeta['cam-a/IMG_0421'].by).toMatch(/^u_/);
    expect(typeof data.marksMeta['cam-a/IMG_0421'].at).toBe('number');
  });

  it('marksMeta 里不含令牌', async () => {
    await putMarks('editor', { A: 'pick' });
    const text = JSON.stringify(await getMarks('viewer'));
    for (const token of [shareToken, editorToken, viewerToken]) expect(text).not.toContain(token);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 隐藏（Task 15）
// ─────────────────────────────────────────────────────────────────────────────

describe('PUT /api/library/hidden', () => {
  /**
   * 每条用例自己摆一个已知的起点：cam-a/IMG_1、IMG_2、IMG_3 都不带标记也不隐藏。
   *
   * 不这样做的话，前一条用例留下的状态会渗进下一条——比如"已标记的被跳过"那条
   * 会把 IMG_1 标成 pick，如果"GET /marks 把 hidden 一起带出来"那条紧跟着用同一个
   * IMG_1 去隐藏，隐藏会被正确地跳过（这正是这个接口的不变量），hidden 里就会
   * 出现上一条用例遗留的 IMG_2，而不是这条用例本身想验的 IMG_1。跟文件顶部
   * `beforeEach`（只清 SSE 缓冲区）不是一回事，这里清的是标记/隐藏这两张表。
   * IMG_3 只有"审计留痕"那组用例用到，一并复位是为了同一条规矩不留例外。
   */
  beforeEach(async () => {
    await adminPut('/api/library/marks', {
      marks: { 'cam-a/IMG_1': null, 'cam-a/IMG_2': null, 'cam-a/IMG_3': null },
    });
    await adminPut('/api/library/hidden', {
      ids: ['cam-a/IMG_1', 'cam-a/IMG_2', 'cam-a/IMG_3'], hidden: false,
    });
  });

  it('管理员能隐藏未标记的照片', async () => {
    const res = await adminPut('/api/library/hidden', { ids: ['cam-a/IMG_1'], hidden: true });
    expect(res.status).toBe(200);
    expect(res.body.hidden).toEqual(['cam-a/IMG_1']);
    expect(res.body.skipped).toEqual([]);
  });

  it('已标记的被跳过而不是让整批 400', async () => {
    await adminPut('/api/library/marks', { marks: { 'cam-a/IMG_1': 'pick' } });
    const res = await adminPut('/api/library/hidden', {
      ids: ['cam-a/IMG_1', 'cam-a/IMG_2'], hidden: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.hidden).toEqual(['cam-a/IMG_2']);
    expect(res.body.skipped).toEqual(['cam-a/IMG_1']);
  });

  it('未知资产 400', async () => {
    const res = await adminPut('/api/library/hidden', { ids: ['不存在'], hidden: true });
    expect(res.status).toBe(400);
  });

  it('ids 不是数组 400', async () => {
    const res = await adminPut('/api/library/hidden', { ids: 'cam-a/IMG_1', hidden: true });
    expect(res.status).toBe(400);
  });

  it('hidden 不是布尔 400', async () => {
    const res = await adminPut('/api/library/hidden', { ids: ['cam-a/IMG_1'], hidden: 'yes' });
    expect(res.status).toBe(400);
  });

  it('GET /marks 把 hidden 一起带出来', async () => {
    await adminPut('/api/library/hidden', { ids: ['cam-a/IMG_1'], hidden: true });
    const res = await adminGet('/api/library/marks');
    expect(res.body.hidden).toEqual(['cam-a/IMG_1']);
  });

  /**
   * 规格里"Produces"一栏列了 SSE 事件 `{ type: 'hidden', origin: 'admin', hidden }`，
   * 但上面六条（brief 逐字给出的用例）都不经过 SSE 断言——如果实现干脆不调用
   * emit()，那六条会照样全绿。这条补的是接口清单里那一半没有测试用例钉住的部分，
   * 写法照抄本文件"SSE 广播"一节的既有模式（真实连一条 SSE，不直接摸 session.listeners）。
   */
  it('隐藏会广播 SSE hidden 事件，origin 恒为 admin', async () => {
    const sink = await stream('admin');
    const res = await adminPut('/api/library/hidden', { ids: ['cam-a/IMG_1'], hidden: true });
    expect(res.status).toBe(200);
    const event = await waitFor(sink, (e) => e.type === 'hidden');
    expect(event.origin).toBe('admin');
    expect(event.hidden).toEqual(res.body.hidden);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 审计留痕（补验，brief 没给测试代码，但 Step 3 的路由实现里带了这段逻辑）
  //
  // 这个仓库对审计的立场很硬：一条记录说谎比不记还糟（store.js 的 takeError()
  // 注释、marks.js settings 路由算 from/to 那段注释讲的是同一件事；Task 7、
  // Task 11 都因为这条改过实现）。隐藏这条路由此前一条测试都没有守着
  // hidden.add / hidden.remove，将来有人重构，日志静默停记或者记错 id，
  // 不会有任何东西报红。
  // ───────────────────────────────────────────────────────────────────────────

  describe('审计留痕', () => {
    it('隐藏一批产生 hidden.add，记的是实际生效的 id——不是请求体原样的 ids，也不是当前完整的 hidden 集合', async () => {
      // 夹具刻意摆了两处"跟真正要验的那次调用不完全一致"的干扰：
      // 1. IMG_3 提前被隐藏、但不在这次调用的 ids 里——如果实现把 assetIds
      //    记成 setHidden() 返回的整份 hidden 集合（而不是这次真正新生效的
      //    那几个），IMG_3 会跟着混进日志。
      // 2. IMG_1 被标记过——如果实现直接记请求体里原样的 ids，被跳过的 IMG_1
      //    会跟着混进日志，即便它根本没有被隐藏。
      // 两种误实现都会被这条用例的精确断言分开。
      await adminPut('/api/library/hidden', { ids: ['cam-a/IMG_3'], hidden: true });
      await adminPut('/api/library/marks', { marks: { 'cam-a/IMG_1': 'pick' } });

      const added = await auditDelta(async () => {
        const res = await adminPut('/api/library/hidden', {
          ids: ['cam-a/IMG_1', 'cam-a/IMG_2'], hidden: true,
        });
        expect(res.status).toBe(200);
        expect(res.body.skipped).toEqual(['cam-a/IMG_1']);
      });

      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({ actor: 'admin', action: 'hidden.add', count: 1 });
      // 精确等于——不是 toContain：多一个（IMG_3）或多一个（IMG_1）都要红。
      expect(added[0].assetIds).toEqual(['cam-a/IMG_2']);
    });

    it('取消隐藏产生 hidden.remove，记的是实际生效的 id', async () => {
      await adminPut('/api/library/hidden', { ids: ['cam-a/IMG_1'], hidden: true });

      const added = await auditDelta(async () => {
        // IMG_2 混进请求里，但它从来没被隐藏过——"取消隐藏"对它没有意义，
        // 不该被记成这次调用生效的一部分。
        const res = await adminPut('/api/library/hidden', {
          ids: ['cam-a/IMG_1', 'cam-a/IMG_2'], hidden: false,
        });
        expect(res.status).toBe(200);
      });

      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({ actor: 'admin', action: 'hidden.remove', count: 1 });
      expect(added[0].assetIds).toEqual(['cam-a/IMG_1']);
    });

    it('一批全部被跳过时（混进的全是已标记的）不产生审计噪音', async () => {
      await adminPut('/api/library/marks', { marks: { 'cam-a/IMG_1': 'pick' } });

      const added = await auditDelta(async () => {
        const res = await adminPut('/api/library/hidden', { ids: ['cam-a/IMG_1'], hidden: true });
        expect(res.status).toBe(200);
        expect(res.body.hidden).toEqual([]);
        expect(res.body.skipped).toEqual(['cam-a/IMG_1']);
      });

      // 口径与 settings.update 一致：一条"看起来发生了什么、实际什么也没
      // 发生"的记录，是审计日志里最容易误导人的噪音。
      expect(added).toEqual([]);
    });

    /**
     * 补充用例（不在你点名的三条字面清单里，但直接复用同一段"实际生效"判定
     * 逻辑的取消隐藏分支）：取消隐藏一个从来没被隐藏过的 id，整批等于什么都
     * 没做，同样不该留痕。跟上一条互补——上一条测的是隐藏方向的空批，这条
     * 测的是取消隐藏方向的空批，两条走的不是同一段代码分支。
     */
    it('取消隐藏一个从来没被隐藏过的 id：不产生审计噪音', async () => {
      const added = await auditDelta(async () => {
        const res = await adminPut('/api/library/hidden', { ids: ['cam-a/IMG_2'], hidden: false });
        expect(res.status).toBe(200);
      });
      expect(added).toEqual([]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 16 追加：PUT /marks 触发不变量 3（打标记自动取消隐藏）时必须广播 hidden。
//
// server/lib/store.js 的 setMark 会把刚被标记的照片从 data.hidden 里摘掉——
// 服务端状态确实变了，但这条路由此前只广播 marks 事件。其它连着的客户端本地
// 那份 hidden 集合会因此过期：明明这张照片已经不再隐藏，它们还会继续把它挡在
// 「全部/收藏/排除」之外，只能在「隐藏」页签看到，直到下一次全量重连补拉才纠正。
// Task 16 之前这条路径没有可观察的后果（前端根本没有 hidden 状态）；这一轮把它
// 变成了真实的、可以被用户看到的分歧。
// ─────────────────────────────────────────────────────────────────────────────

describe('PUT /api/library/marks 让隐藏照片自动取消隐藏时', () => {
  // 同一条规矩：每条用例自己摆一个已知的起点，不依赖别的 describe 块跑完之后
  // 恰好是干净的（那种依赖正是 Task 15 报告里提醒过的坑）。
  beforeEach(async () => {
    await adminPut('/api/library/marks', {
      marks: { 'cam-a/IMG_1': null, 'cam-a/IMG_2': null },
    });
    await adminPut('/api/library/hidden', {
      ids: ['cam-a/IMG_1', 'cam-a/IMG_2'], hidden: false,
    });
  });

  it('给一张已隐藏的照片打标记，会广播 hidden 事件，且集合里已经不含它', async () => {
    await adminPut('/api/library/hidden', { ids: ['cam-a/IMG_1'], hidden: true });
    const sink = await stream('admin');

    const res = await adminPut('/api/library/marks', { marks: { 'cam-a/IMG_1': 'pick' } });
    expect(res.status).toBe(200);

    const event = await waitFor(sink, (e) => e.type === 'hidden');
    // 用 not.toContain 而不是精确比对整个集合：这条用例不该依赖"此刻全局
    // hidden 集合恰好只有这一个 id"这种跨用例的假设，只钉住"这次真正被
    // 取消隐藏的那个 id 确实从广播里消失了"。
    expect(event.hidden).not.toContain('cam-a/IMG_1');
  });

  it('给一张本来就没隐藏的照片打标记，不会多广播一条 hidden 事件', async () => {
    const sink = await stream('admin');

    const res = await adminPut('/api/library/marks', { marks: { 'cam-a/IMG_2': 'pick' } });
    expect(res.status).toBe(200);
    await waitFor(sink, isMarks);
    // marks 事件和"如果有的话"的 hidden 事件是同一次请求处理里背靠背 emit
    // 的（中间没有 await），marks 落地之后再留一点余量，避免"查得太早"
    // 把一个其实存在、只是还没到达的 hidden 事件误判成不存在。
    await new Promise((r) => setTimeout(r, 50));
    expect(sink.events.some((e) => e.type === 'hidden')).toBe(false);
  });

  // 不在你点名的两条字面清单里，是我自己加的：验证的是这次实现里一个具体的
  // 取舍——origin 用触发这次标记的 actor.id，不是照抄 PUT /hidden 那条路由
  // 写死的字面量 'admin'。PUT /marks 是 requirePerm('write')，editor 也能
  // 触发不变量 3（见 actorOf 上面的注释），写死 'admin' 会把 editor 的操作
  // 冒认成管理员的。
  it('editor 触发不变量 3 时，广播的 origin 是这个 editor 的 userId，不是字面量 admin', async () => {
    await adminPut('/api/library/hidden', { ids: ['cam-a/IMG_1'], hidden: true });
    const sink = await stream('admin');

    const res = await putMarks('editor', { 'cam-a/IMG_1': 'pick' });
    expect(res.status).toBe(200);

    const event = await waitFor(sink, (e) => e.type === 'hidden');
    expect(event.origin).toMatch(/^u_/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 20：showPeerMarks === false 时的按人过滤
//
// 「客户彼此看不见对方的标记」这件事必须在**服务端**做完。前端过滤只是把东西
// 藏起来，数据照样发到了对方的浏览器里，打开开发者工具就看得见「妈妈收藏了
// 哪些」——和 viewer 角色是同一条理由。
//
// 更细的一层是**时机**：把值换成她该看到的那个、照发不误，也是泄露。她那一格
// 在别人操作的瞬间重渲染一次，等于告诉她「刚才有人动了这张」。
// ─────────────────────────────────────────────────────────────────────────────

/** 把这条分享的开关拨到指定位置。落盘即生效——shares.js 每次都重新读盘。 */
async function setShowPeerMarks(value) {
  await updateShare(shareId, { showPeerMarks: value });
}

describe('showPeerMarks: false 时的按人过滤', () => {
  beforeEach(async () => {
    await setShowPeerMarks(false);
    await putMarks('admin', { 'cam-a/IMG_1': null, 'cam-a/IMG_2': null });
  });

  afterEach(async () => { await setShowPeerMarks(true); });

  it('访客看不到别的客户那一票', async () => {
    await putMarks('editor', { 'cam-a/IMG_1': 'pick' });
    const body = await getMarks('viewer');
    expect(body.marks['cam-a/IMG_1']).toBeUndefined();
  });

  it('访客看得到摄影师那一票', async () => {
    await putMarks('admin', { 'cam-a/IMG_1': 'pick' });
    const body = await getMarks('viewer');
    expect(body.marks['cam-a/IMG_1']).toBe('pick');
  });

  it('自己那一票优先于摄影师那一票', async () => {
    await putMarks('admin', { 'cam-a/IMG_1': 'reject' });
    await putMarks('editor', { 'cam-a/IMG_1': 'pick' });
    const body = await getMarks('editor');
    expect(body.marks['cam-a/IMG_1']).toBe('pick');
  });

  it('访客的响应里没有 contrib，也没有归属角标', async () => {
    // 整张贡献表发过去等于把过滤白做了。marksMeta 同理——它会把
    // 「这张是别的客户标的」原样说出来。
    await putMarks('editor', { 'cam-a/IMG_1': 'pick' });
    const body = await getMarks('viewer');
    expect(body.contrib).toBeUndefined();
    expect(body.marksMeta).toEqual({});
  });

  it('showPeerMarks: true 时访客拿到的就是共编那份，行为不变', async () => {
    // 这条是回归闸门：整个改造的前提是「开关打开时和以前一模一样」。
    await setShowPeerMarks(true);
    await putMarks('editor', { 'cam-a/IMG_1': 'pick' });
    const body = await getMarks('viewer');
    expect(body.marks['cam-a/IMG_1']).toBe('pick');
    expect(body.marksMeta['cam-a/IMG_1']?.by).toBeTruthy();
  });

  it('老的 shares.json 里没有这个字段时，访客照旧看得到别人的标记', async () => {
    // seesPeerMarks 是 `!== false` 这条口径的**第二个**落点（第一个是
    // admin.js 的 publicShare，那边另有用例）。两处必须给出同一个答案，
    // 否则就是「管理台显示公开、访客实际看不到」这种查都没法查的分歧。
    //
    // 写成 `=== true` 或 `!!x` 的后果不是少显示一点东西：升级之后**每一条
    // 老链接**的客户都会突然看不见彼此的标记，而摄影师从没做过这个操作。
    const file = path.join(home, 'shares.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    delete raw.shares[shareId].showPeerMarks;
    await fs.writeFile(file, JSON.stringify(raw));

    await putMarks('editor', { 'cam-a/IMG_1': 'pick' });
    const body = await getMarks('viewer');
    expect(body.marks['cam-a/IMG_1']).toBe('pick');
  });

  it('开关打开时访客拿得到别人的标记，但仍然拿不到 contrib', async () => {
    // 上面那条「访客的响应里没有 contrib」是在 showPeerMarks: false 下验的，
    // 而那条路径会提前 return，根本走不到 contrib 那一行——也就是说
    // 「contrib 只给管理员」这道门禁在那条用例下是**没有被验到**的。
    // 开关打开才是它唯一的落点，而那正是默认值。
    //
    // contrib 比 marksMeta 多说的是**被覆盖掉的那些票**：marksMeta 只有胜出的
    // 那一条归属，contrib 里能读出「妈妈先排除过、后来新娘又收藏了」。
    await setShowPeerMarks(true);
    await putMarks('editor', { 'cam-a/IMG_1': 'pick' });

    const body = await getMarks('viewer');
    expect(body.marks['cam-a/IMG_1']).toBe('pick');   // 确实看得见别人的标记
    expect(body.contrib).toBeUndefined();
  });

  it('管理员照常拿到全部，外加整张 contrib', async () => {
    await putMarks('editor', { 'cam-a/IMG_1': 'pick' });
    const body = await getMarks('admin');
    expect(body.marks['cam-a/IMG_1']).toBe('pick');
    expect(body.contrib['cam-a/IMG_1']).toBeTruthy();
    expect(Object.keys(body.contrib['cam-a/IMG_1'])[0]).toMatch(/^u_/);
  });
});

describe('showPeerMarks: false 时广播的按人过滤', () => {
  beforeEach(async () => {
    await setShowPeerMarks(false);
    await putMarks('admin', { 'cam-a/IMG_1': null, 'cam-a/IMG_2': null });
  });

  afterEach(async () => { await setShowPeerMarks(true); });

  /**
   * 「这一帧根本没发出去」只能靠等一段时间来证明。等的锚点不是凭空的时长，
   * 而是**另一条连接确实收到了**——管理员那条一定收得到，它一到就说明这次
   * 广播已经整段跑完了，此刻受限访客那边还是空的，就是真的没发。
   */
  async function assertNoFrameFor(sink, trigger) {
    const adminSink = await stream('admin');
    adminSink.events.length = 0;
    sink.events.length = 0;
    await trigger();
    await waitFor(adminSink, isMarks);
    expect(sink.events.filter(isMarks)).toEqual([]);
  }

  it('别的访客标记时，受限访客收不到这一帧', async () => {
    const her = await stream('viewer');
    await assertNoFrameFor(her, () => putMarks('editor', { 'cam-a/IMG_1': 'pick' }));
  });

  it('摄影师标记且她没碰过这张时，她收得到，但帧里没有归属', async () => {
    const her = await stream('viewer');
    her.events.length = 0;

    await putMarks('admin', { 'cam-a/IMG_1': 'pick' });

    const frame = await waitFor(her, isMarks);
    expect(frame.changes['cam-a/IMG_1'].mark).toBe('pick');
    // by/at 一并不给，和 GET 给她 marksMeta: {} 是同一个决定：两处不一致的话，
    // 她刷新前后看到的角标不一样。
    expect(frame.changes['cam-a/IMG_1'].by).toBeUndefined();
  });

  it('摄影师标记但她自己碰过这张时，她收不到（她看到的仍是自己那一票）', async () => {
    await putMarks('editor', { 'cam-a/IMG_1': 'pick' });
    const her = await stream('editor');
    await assertNoFrameFor(her, () => putMarks('admin', { 'cam-a/IMG_1': 'reject' }));
  });

  it('管理员那一侧照常收到全部，帧里带归属', async () => {
    const asAdmin = await stream('admin');
    asAdmin.events.length = 0;

    await putMarks('editor', { 'cam-a/IMG_1': 'pick' });

    const frame = await waitFor(asAdmin, isMarks);
    expect(frame.changes['cam-a/IMG_1'].mark).toBe('pick');
    expect(frame.changes['cam-a/IMG_1'].by).toMatch(/^u_/);
  });

  it('开关拨到 false 之后，已经连着的那条连接立刻按新口径过滤', async () => {
    // listener.actor 是**连接建立那一刻**的快照。不在 notifyPeerMarks 里把它
    // 换掉的话，她的界面确实会重拉一份过滤过的标记，可别人后续每一次写入
    // 仍然会把完整的那一帧推给她——刚过滤掉的东西又顺着 SSE 流回去了。
    await setShowPeerMarks(true);
    const her = await stream('viewer');   // 连上时开关还是开着的
    her.events.length = 0;

    expect((await adminPatch(`/api/admin/shares/${shareId}`, { showPeerMarks: false })).status).toBe(200);
    await waitFor(her, (e) => e.type === 'peer-marks');

    await assertNoFrameFor(her, () => putMarks('editor', { 'cam-a/IMG_2': 'pick' }));
  });
});
