import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.js';
import { closeAllSessions } from '../lib/session.js';
import { revokeShare } from '../lib/shares.js';
import { _test as libraryTest } from './library.js';

/**
 * 过期的分享要主动把人踢下线。
 *
 * 撤销一直是即时的（`DELETE /api/admin/shares/:id` 当场 endShare），**过期不是**：
 * 在补上这一段之前，没有任何东西去看一条分享是不是已经到期了。到期的访客
 * 手上那一屏还能继续看，还在跟着别人的标记实时变化，一直到他自己下一次
 * 发 HTTP 请求（可能是几分钟以后，也可能永远不会——他只是在滚动已经缓存好的图）。
 * 「有效期到了就看不到了」那时只是一句写在管理台上的话。
 *
 * 检查挂在 `/stream` 那个每 25 秒一次的 SSE 心跳上，不新增常驻定时器：
 * 没有人连着的时候本来就没有人需要被踢，一个空转的扫描进程是纯粹的浪费。
 *
 * 这个文件里每一条断言的都是**效果**，不是"某个函数被调用过"：
 * 事件真的到了客户端手里，连接真的被服务端关掉了。
 * mock 一个 presence 模块再数调用次数，测的是接线，不是断流。
 */

/** 访客请求的伪造源地址。必须不是回环，否则 resolveActor 直接判成管理员。 */
const GUEST_IP = '192.168.1.50';

/**
 * 用例里的心跳间隔。真实值是 25 秒，端到端等不起。
 * 20 毫秒足够在一次 readUntil 的窗口（3 秒）里跑上百轮。
 */
const FAST_HEARTBEAT_MS = 20;

let server;
let base;
let home;        // PHOTOCULL_HOME
let root;        // 被分享的照片文件夹
let other;       // 另一个文件夹，用来验证"别条分享的访客不受影响"
let savedHome;
let savedHeartbeat;

/**
 * 逐请求可切换的 TCP 源地址。做法与 admin.test.js / permissions.test.js 一致：
 * 请求仍然走真实 TCP，只有 `req.socket.remoteAddress` 这一个字段被换掉，
 * 而那正是 `isLoopback()` 唯一读的东西。keep-alive 会复用 socket，
 * 所以每次先 delete 掉上一轮留下的自有属性。
 * null = 回环 = 管理员。
 */
let remoteOverride = null;

/** 本条用例开出去的 SSE 连接，afterEach 统一断掉。 */
let openCtrls = [];

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-exp-root-')));
  other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-exp-other-')));
  // 只放 RAW：不生成缩略图，用例跑得快，SSE 上也少一类干扰帧。
  await fs.writeFile(path.join(root, 'A.CR3'), 'fake raw');
  await fs.writeFile(path.join(other, 'B.CR3'), 'fake raw');

  const app = createApp();
  server = http.createServer((req, res) => {
    delete req.socket.remoteAddress;
    if (remoteOverride !== null) {
      Object.defineProperty(req.socket, 'remoteAddress', {
        value: remoteOverride, configurable: true,
      });
    }
    app(req, res);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await closeAllSessions();
  await new Promise((r) => server.close(r));
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(other, { recursive: true, force: true });
});

beforeEach(async () => {
  savedHome = process.env.PHOTOCULL_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-exp-home-'));
  process.env.PHOTOCULL_HOME = home;
  remoteOverride = null;
  savedHeartbeat = libraryTest.setHeartbeatMs(FAST_HEARTBEAT_MS);
  openCtrls = [];
});

afterEach(async () => {
  // 心跳必须还原：这是模块级状态，漏还原会让后面每个文件里的 SSE 连接
  // 都跟着跑一个毫秒级定时器。
  libraryTest.setHeartbeatMs(savedHeartbeat);
  for (const ctrl of openCtrls) ctrl.abort();
  openCtrls = [];
  await closeAllSessions();
  if (savedHome === undefined) delete process.env.PHOTOCULL_HOME;
  else process.env.PHOTOCULL_HOME = savedHome;
  await fs.rm(home, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 请求助手
// ─────────────────────────────────────────────────────────────────────────────

async function request(method, p, { body, cookie, ip } = {}) {
  if (ip !== undefined) remoteOverride = ip;
  const init = { method, headers: {} };
  if (cookie !== undefined) init.headers.cookie = cookie;
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + p, init);
  const text = await res.text();
  let parsed = null;
  try { parsed = text === '' ? null : JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}

const get = (p, opts) => request('GET', p, opts);
const post = (p, opts) => request('POST', p, opts);
const patch = (p, opts) => request('PATCH', p, opts);

/** 从 Set-Cookie 串里取出 pc_user 的值，供后续请求当 Cookie 用。 */
function cookieFrom(res) {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('pc_user='));
  return raw.split(';')[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE
// ─────────────────────────────────────────────────────────────────────────────

/** readUntil 的超时哨兵。用 Symbol 是为了和任何一个真实的读取结果都不可能相等。 */
const TIMEOUT = Symbol('sse-timeout');

/**
 * 一条真实 SSE 连接的读取端。
 *
 * 按 `\n\n` 拆帧，不是"读一块就当一帧"：服务端那几次 `res.write()` 落进
 * 几个 TCP 分块完全由内核决定，一次 `read()` 可能给出四帧，也可能给出半帧。
 * 心跳调到 20 毫秒之后这条流上帧非常密，把分块当成帧一定会读到半帧。
 */
function sseClient(reader) {
  const decoder = new TextDecoder();
  const events = [];
  let buf = '';
  let closed = false;

  /**
   * 一直读到 `until(events)` 成立、或者流被服务端关掉、或者超时为止。
   * 返回**累计**收到的全部事件和此刻的关闭状态。
   *
   * 不传 `until` 就是"读到流结束为止"——断言"连接真的被断开了"要用的就是它。
   * 超时兜底让"本该断开却没断开"变成一条断言失败（closed === false），
   * 而不是一次 20 秒的 vitest 超时。
   */
  async function readUntil({ until = () => false, timeoutMs = 3000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (!closed && !until(events)) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      // read() 的 promise 在这里就把成功和失败都接住了，所以超时先到时
      // 它不会变成一条 unhandledRejection（连接随后被 abort，那个 read 必然拒绝）。
      const pending = reader.read().then((r) => r, () => ({ done: true }));
      let timer;
      const ticking = new Promise((r) => { timer = setTimeout(() => r(TIMEOUT), left); });
      const r = await Promise.race([pending, ticking]);
      clearTimeout(timer);
      if (r === TIMEOUT) break;
      if (r.done) { closed = true; break; }

      buf += decoder.decode(r.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        for (const line of buf.slice(0, i).split('\n')) {
          // `: ping` 之类的注释帧没有 data 前缀，跳过。
          if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
        }
        buf = buf.slice(i + 2);
      }
    }
    return { events, closed };
  }

  return { readUntil };
}

/**
 * 开一条真实的 SSE 连接，读到首帧快照为止。
 *
 * 读到任何一个字节就足以保证服务端的处理函数已经整段跑完（包括 addListener
 * 和 setInterval）——那个函数里没有 await，写响应、登记 listener、起心跳
 * 在同一个同步块里。等 `meta` 帧而不是"第一块数据"，是为了让后续读取
 * 从一个干净的帧边界开始。
 */
async function openStream(sessionId, cookie, ip) {
  remoteOverride = ip;
  const ctrl = new AbortController();
  openCtrls.push(ctrl);
  const res = await fetch(`${base}/api/library/stream?sid=${sessionId}`, {
    headers: cookie ? { cookie } : {}, signal: ctrl.signal,
  });
  expect(res.status).toBe(200);
  const client = sseClient(res.body.getReader());
  await client.readUntil({ until: (evs) => evs.some((e) => e.type === 'meta') });
  return client;
}

const isEnded = (e) => e.type === 'share-ended';

/**
 * 「访客先出现在名单上，随后又从名单上消失」——**按顺序**判，不按下标切。
 *
 * 摄影师在访客连上来之前就已经收到过一帧只有他自己的 `presence`。拿
 * "收到一帧只有 admin 的 presence"当条件的话，那一帧会让等待立刻成立，
 * "过期之后摄影师还在收东西"这条断言就空转了。要求"先看见访客、
 * 再看见他不见了"就与分帧无关。
 */
function guestCameAndWent(events) {
  const presence = (e) => e.type === 'presence';
  const arrived = events.findIndex((e) => presence(e) && e.users.some((u) => u.id !== 'admin'));
  if (arrived === -1) return false;
  return events.slice(arrived + 1)
    .some((e) => presence(e) && e.users.every((u) => u.id === 'admin'));
}

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 开库、建一条分享、让一位访客 join，并把开流要用的东西一并交出来。
 * `expiresAt` 默认给一个很远的将来——每条用例自己决定什么时候让它到期。
 */
async function shareWithGuest({
  folder = root, nickname = '新娘小林', expiresAt = Date.now() + 3_600_000,
} = {}) {
  const opened = await post('/api/library/open', { body: { root: folder }, ip: null });
  expect(opened.status).toBe(200);

  const created = await post('/api/admin/shares', {
    body: { root: folder, label: `到期测试 ${nickname}`, expiresAt },
  });
  expect(created.status).toBe(200);
  const share = created.body.share;

  const joined = await post(`/api/share/${share.token}/join`, {
    body: { nickname }, ip: GUEST_IP,
  });
  expect(joined.status).toBe(200);

  return {
    share,
    user: joined.body.user,
    sessionId: joined.body.sessionId,
    cookie: cookieFrom(joined),
  };
}

/** 把有效期改到 `msFromNow` 之后。走真实的管理接口，不绕过校验。 */
async function setExpiry(shareId, msFromNow) {
  const res = await patch(`/api/admin/shares/${shareId}`, {
    body: { expiresAt: Date.now() + msFromNow }, ip: null,
  });
  expect(res.status).toBe(200);
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// 用例
// ─────────────────────────────────────────────────────────────────────────────

describe('过期的分享会把已经连着的访客踢下线', () => {
  it('有效期一到，访客那条连接收到 share-ended(expired) 并被服务端断开', async () => {
    const { share, sessionId, cookie } = await shareWithGuest();
    const guest = await openStream(sessionId, cookie, GUEST_IP);

    // 到期时刻定在**连接建立之后**，而且这条 PATCH 在到期之前很久就发完了：
    // 真正让他下线的是时钟走过那一刻，不是这次管理操作。
    await setExpiry(share.id, 150);

    const seen = await guest.readUntil();
    expect(seen.events).toContainEqual({ type: 'share-ended', reason: 'expired' });
    // 只发事件不断开不叫踢人：客户端完全可以忽略那条事件继续用这条流，
    // 继续跟着别人的标记实时刷新——那正是这个缺口原来的样子。
    expect(seen.closed).toBe(true);
  });

  it('判的是盘上此刻的 expiresAt，不是连上来那一刻的快照', async () => {
    // 连上来的时候这条分享还有一个钟头，`actor.share` 那份快照永远是这个值。
    // 只信快照的实现在这条用例上永远等不到 share-ended。
    const { share, sessionId, cookie } = await shareWithGuest();
    const guest = await openStream(sessionId, cookie, GUEST_IP);

    await setExpiry(share.id, -1000);   // 有效期被改成一秒钟以前

    const seen = await guest.readUntil();
    expect(seen.events).toContainEqual({ type: 'share-ended', reason: 'expired' });
    expect(seen.closed).toBe(true);
  });

  it('摄影师自己的连接不受影响（到期的是链接，不是这个文件夹）', async () => {
    const { share, sessionId, cookie } = await shareWithGuest();

    const photographer = await openStream(sessionId, '', null);
    const guest = await openStream(sessionId, cookie, GUEST_IP);

    await setExpiry(share.id, -1000);

    const seen = await guest.readUntil();
    expect(seen.closed).toBe(true);

    // 摄影师这条连接不但没断，还收到了访客离场之后的新名单——
    // 「还活着」用"它继续在收东西"来证明，比"此刻碰巧还没关"结实：
    // 连接要是也被断掉了，这一帧永远等不到，closed 会变成 true。
    const mine = await photographer.readUntil({ until: guestCameAndWent });
    expect(mine.closed).toBe(false);
    expect(guestCameAndWent(mine.events)).toBe(true);
    expect(mine.events.filter(isEnded)).toEqual([]);
  });

  it('同一个文件夹上另一条还没到期的分享，它的访客不受影响', async () => {
    const alive = await shareWithGuest({ nickname: '伴娘小周' });
    const dying = await shareWithGuest({ nickname: '新郎老王' });
    // 同一个 root 只有一个会话，两位访客拿到的是同一个 sessionId。
    expect(dying.sessionId).toBe(alive.sessionId);

    const survivor = await openStream(alive.sessionId, alive.cookie, GUEST_IP);
    const doomed = await openStream(dying.sessionId, dying.cookie, GUEST_IP);

    await setExpiry(dying.share.id, -1000);

    const gone = await doomed.readUntil();
    expect(gone.events).toContainEqual({ type: 'share-ended', reason: 'expired' });
    expect(gone.closed).toBe(true);

    // 到期的是一条链接，不是这个文件夹——另一条链接的客人必须继续看得见照片。
    // 同样用"他还在收东西"来证明，不用"此刻碰巧还没关"。
    const still = await survivor.readUntil({
      until: (evs) => evs.filter((e) => e.type === 'presence').length >= 3,
    });
    expect(still.closed).toBe(false);
    expect(still.events.filter(isEnded)).toEqual([]);
  });

  it('还没到期的访客不会被踢（心跳跑过上百轮也一样）', async () => {
    // 对照组。没有它，一个"每次心跳都无条件 endShare"的实现也能让上面几条全绿。
    const { sessionId, cookie } = await shareWithGuest();
    const guest = await openStream(sessionId, cookie, GUEST_IP);

    // 20 毫秒一跳，1 秒就是 50 轮。读到超时为止：期间只该有心跳，不该有 share-ended。
    const seen = await guest.readUntil({ timeoutMs: 1000 });
    expect(seen.events.filter(isEnded)).toEqual([]);
    expect(seen.closed).toBe(false);
  });

  it('永不过期（expiresAt 为 null）的分享不会被踢', async () => {
    const { share, sessionId, cookie } = await shareWithGuest();
    const cleared = await patch(`/api/admin/shares/${share.id}`, {
      body: { expiresAt: null }, ip: null,
    });
    expect(cleared.status).toBe(200);

    const guest = await openStream(sessionId, cookie, GUEST_IP);
    const seen = await guest.readUntil({ timeoutMs: 500 });
    expect(seen.events.filter(isEnded)).toEqual([]);
    expect(seen.closed).toBe(false);
  });

  it('撤销那一刻没踢到的连接，下一次心跳补上', async () => {
    // `DELETE /api/admin/shares/:id` 里的 endShare 只能踢**那一刻已经登记在册**的
    // 连接。一个正好卡在"身份已经解析完、listener 还没登记"之间的访客会漏网，
    // 之后就一直挂着一条指向已撤销链接的活流。这里用 lib 层的 revokeShare
    // 直接改存储（绕开路由里的 endShare）来复现那个漏网的结果。
    const { share, sessionId, cookie } = await shareWithGuest();
    const guest = await openStream(sessionId, cookie, GUEST_IP);

    await revokeShare(share.id);

    const seen = await guest.readUntil();
    expect(seen.events).toContainEqual({ type: 'share-ended', reason: 'revoked' });
    expect(seen.closed).toBe(true);
  });

  it('踢完之后在线名单上不再有他，管理台的 online 也跟着降回去', async () => {
    const { share, sessionId, cookie } = await shareWithGuest();
    const photographer = await openStream(sessionId, '', null);
    const guest = await openStream(sessionId, cookie, GUEST_IP);

    const onlineOf = async () => {
      const list = await get('/api/admin/shares', { ip: null });
      expect(list.status).toBe(200);
      return list.body.shares.find((s) => s.id === share.id).online;
    };
    expect(await onlineOf()).toBe(1);

    await setExpiry(share.id, -1000);
    expect((await guest.readUntil()).closed).toBe(true);
    await photographer.readUntil({ until: guestCameAndWent });

    // 在线 = 一条活着的 SSE 连接。踢完还显示 1 就说明连接其实没断。
    expect(await onlineOf()).toBe(0);
  });
});

describe('心跳不会因为这件事变成一个别的东西', () => {
  it('管理员的连接照样有心跳，也照样不会被任何分享状态影响', async () => {
    // 管理员不属于任何一条分享，"过期"对他无从谈起。这条用例钉的是
    // 「查不出 shareId 就什么都不做」——而不是"查不出就当作过期"。
    const { share } = await shareWithGuest();
    const opened = await post('/api/library/open', { body: { root }, ip: null });
    const photographer = await openStream(opened.body.sessionId, '', null);

    await setExpiry(share.id, -1000);

    const seen = await photographer.readUntil({ timeoutMs: 500 });
    expect(seen.events.filter(isEnded)).toEqual([]);
    expect(seen.closed).toBe(false);
  });
});
