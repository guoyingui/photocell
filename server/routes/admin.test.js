import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.js';
import { closeAllSessions } from '../lib/session.js';
import { createShare, getShareById, listShares, revokeShare } from '../lib/shares.js';
import { createUser, findUserByToken, listUsers } from '../lib/users.js';
import { ACTIONS, logEvent, readEvents } from '../lib/audit.js';

/**
 * `/api/admin/*` —— 管理接口。
 *
 * 这个文件里有三条性质是不可协商的，其余都是围着它们的边角：
 *
 * 1. **任何返回用户列表的响应都不得含令牌。** 断言方式必须是**子串搜索**：
 *    拿真实令牌值去 `JSON.stringify(body)` 里搜。检查字段名挡不住嵌套结构，
 *    也挡不住哪天有人把字段改名成 `secret`。
 * 2. **建分享时 root 必须过 `assertWithin` + `realpathDeep`。** 少了它，
 *    管理接口本身就是一条绕过路径边界的通道；而且没归一化的 root 会让
 *    `session.root === share.root` 这个**裸串比较**在 macOS 上恒假
 *    （`/var/...` vs `/private/var/...`），合法访客一律撞 wrong-library。
 * 3. **撤销是软删。** 用户表和审计日志必须保留——「谁在什么时候进来过」
 *    是撤销之后才更需要的信息。
 */

/** 访客请求的伪造源地址。必须不是回环，否则 resolveActor 直接判成管理员。 */
const GUEST_IP = '192.168.1.50';

let server;
let base;
let home;        // PHOTOCULL_HOME：分享/用户存储，绝不能碰开发者真实的 ~/.photocull
let root;        // 被分享的照片文件夹（真实路径）
let link;        // 指向 root 的软链接，用来验证 realpath 归一化
let savedHome;

/**
 * 逐请求可切换的 TCP 源地址。做法与 share.test.js / permissions.test.js 一致：
 * 请求仍然走真实 TCP，只有 `req.socket.remoteAddress` 这一个字段被换掉，
 * 而那正是 `isLoopback()` 唯一读的东西。keep-alive 会复用 socket，
 * 所以每次先 delete 掉上一轮留下的自有属性。
 * null = 回环 = 管理员，是本文件的默认身份。
 */
let remoteOverride = null;

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-admin-root-')));
  // 软链接必须和目标不同名，且自己也落在 browseRoots() 允许的范围内（临时目录）。
  link = path.join(await fs.realpath(os.tmpdir()), `pc-admin-link-${process.pid}`);
  await fs.rm(link, { force: true });
  await fs.symlink(root, link);

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
  await fs.rm(link, { force: true });
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  savedHome = process.env.PHOTOCULL_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-admin-home-'));
  process.env.PHOTOCULL_HOME = home;
  remoteOverride = null;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.PHOTOCULL_HOME;
  else process.env.PHOTOCULL_HOME = savedHome;
  await fs.rm(home, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 请求助手
// ─────────────────────────────────────────────────────────────────────────────

async function request(method, p, { body, cookie, headers = {}, ip } = {}) {
  if (ip !== undefined) remoteOverride = ip;
  const init = { method, headers: { ...headers } };
  if (cookie !== undefined) init.headers.cookie = cookie;
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + p, init);
  const text = await res.text();
  let parsed = null;
  try { parsed = text === '' ? null : JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

const get = (p, opts) => request('GET', p, opts);
const post = (p, opts) => request('POST', p, opts);
const patch = (p, opts) => request('PATCH', p, opts);
const del = (p, opts) => request('DELETE', p, opts);

/** 从 Set-Cookie 串里取出 pc_user 的值，供后续请求当 Cookie 用。 */
function cookieFrom(res) {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('pc_user='));
  return raw.split(';')[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 令牌绝不随用户列表外流
// ─────────────────────────────────────────────────────────────────────────────

describe('用户列表不含令牌', () => {
  it('GET users 的响应里搜不到任何令牌（子串搜索，不是字段名检查）', async () => {
    const share = await createShare({ root, label: '婚礼初选' });
    const lin = await createUser(share.id, '新娘小林', 'editor');
    const zhang = await createUser(share.id, '摄影助理', 'viewer');

    const res = await get(`/api/admin/shares/${share.id}/users`);
    expect(res.status).toBe(200);

    // 先证明这条断言不是在一个空列表上空转——没有这一句，
    // 一个永远返回 [] 的实现也能让下面的 not.toContain 全绿。
    expect(res.body.users).toHaveLength(2);
    expect(res.body.users.map((u) => u.nickname).sort()).toEqual(['摄影助理', '新娘小林']);

    const blob = JSON.stringify(res.body);
    for (const token of [lin.token, zhang.token, share.token]) {
      expect(blob).not.toContain(token);
    }
  });

  it('PATCH 单个用户的响应里也搜不到令牌', async () => {
    const share = await createShare({ root });
    const user = await createUser(share.id, '新娘小林', 'editor');

    const res = await patch(`/api/admin/shares/${share.id}/users/${user.id}`, {
      body: { role: 'viewer' },
    });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('viewer');
    expect(JSON.stringify(res.body)).not.toContain(user.token);
  });

  it('分享列表带着 share.token（分享面板靠它拼链接），但绝不带用户令牌', async () => {
    const share = await createShare({ root, label: '婚礼初选' });
    const user = await createUser(share.id, '新娘小林', 'editor');

    const res = await get('/api/admin/shares');
    expect(res.status).toBe(200);
    const row = res.body.shares.find((s) => s.id === share.id);
    expect(row).toBeTruthy();
    // 这条不对称是刻意的：链接本身必须回到摄影师手里，否则分享面板拼不出
    // `/s/<token>`；用户令牌则只属于它的持有者，永不下发给别人（规格 3.3）。
    expect(row.token).toBe(share.token);
    expect(JSON.stringify(res.body)).not.toContain(user.token);
    expect(row.userCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1b. 在线人数
// ─────────────────────────────────────────────────────────────────────────────

/** readUntil 的超时哨兵。用 Symbol 是为了和任何一个真实的读取结果都不可能相等。 */
const TIMEOUT = Symbol('sse-timeout');

/**
 * 一条真实 SSE 连接的读取端。
 *
 * **按 `\n\n` 拆帧，不是"读一块就当一帧"。** 服务端那几次 `res.write()` 落进
 * 几个 TCP 分块完全由内核决定：一次 `read()` 可能给出四帧，也可能给出半帧。
 * 把分块当成帧的写法在负载下会随机读到"上一帧的尾巴"，那正是
 * `routes.test.js` 那条 F5 用例曾经的偶发红。所以缓冲区跨越多次 read 存活。
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
   * 超时兜底是为了让"本该断开却没断开"变成一条断言失败（closed === false），
   * 而不是一次 20 秒的 vitest 超时：后者读起来像基础设施出了问题，
   * 而这里失败的是一条明确的产品性质。
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
 * 「访客先出现在名单上，随后又从名单上消失」——**按顺序**判，不按下标切。
 *
 * 摄影师在访客连上来之前就已经收到过一帧只有他自己的 `presence`（他自己
 * 上线时广播的那一帧）。拿"收到一帧只有 admin 的 presence"当条件的话，
 * 那一帧会让等待立刻成立，"撤销之后摄影师还在收东西"这条断言就空转了；
 * 而"读到第 n 帧之后"同样不行——那一帧落在哪一次 read() 里由 TCP 分块决定。
 * 要求"先看见访客、再看见他不见了"就与分帧无关：中间那一帧
 * `presence[admin, 访客]` 是访客上线时必然广播的。
 */
function guestCameAndWent(events) {
  const presence = (e) => e.type === 'presence';
  const arrived = events.findIndex((e) => presence(e) && e.users.some((u) => u.id !== 'admin'));
  if (arrived === -1) return false;
  return events.slice(arrived + 1)
    .some((e) => presence(e) && e.users.every((u) => u.id === 'admin'));
}

/**
 * 开一条真实的 SSE 连接，读到首帧快照为止。
 *
 * 读到任何一个字节就足以保证服务端的处理函数已经整段跑完（包括 addListener）——
 * 那个函数里没有 await，写响应和登记 listener 在同一个同步块里。
 * 这里等的是 `meta` 帧而不是"第一块数据"，这样后续读取从一个干净的帧边界开始。
 */
async function openStream(sessionId, cookie, signal) {
  const res = await fetch(`${base}/api/library/stream?sid=${sessionId}`, {
    headers: { cookie }, signal,
  });
  expect(res.status).toBe(200);
  const client = sseClient(res.body.getReader());
  await client.readUntil({ until: (evs) => evs.some((e) => e.type === 'meta') });
  return client;
}

describe('在线人数', () => {
  it('数的是这条链接此刻的连接，多标签页算一个人', async () => {
    await post('/api/library/open', { body: { root } });
    const created = await post('/api/admin/shares', { body: { root } });
    const share = created.body.share;

    // ip: null 明确切回回环 = 管理员。这个测试中途会以访客身份发请求，
    // 而 remoteOverride 是模块级的——不写这一句，join 之后的每一次查询
    // 都会以访客身份发出去，拿到 401 而不是分享列表。
    const onlineOf = async () => {
      const list = await get('/api/admin/shares', { ip: null });
      expect(list.status).toBe(200);
      return list.body.shares.find((s) => s.id === share.id).online;
    };

    // 没人连上来时是确定的 0，不是"不知道"。
    expect(await onlineOf()).toBe(0);

    const joined = await post(`/api/share/${share.token}/join`, {
      body: { nickname: '新娘小林' }, ip: GUEST_IP,
    });
    const cookie = cookieFrom(joined);
    // join 本身不算在线：在线状态是 SSE 连接，不是"建过号"。
    expect(await onlineOf()).toBe(0);

    const ctrl = new AbortController();
    remoteOverride = GUEST_IP;
    await openStream(joined.body.sessionId, cookie, ctrl.signal);
    await openStream(joined.body.sessionId, cookie, ctrl.signal);   // 第二个标签页

    expect(await onlineOf()).toBe(1);
    ctrl.abort();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1c. 管理操作对**已经建立的** SSE 连接立即生效
//
// 这一组钉住的是一条曾经真实存在的缺口：管理接口只落库、不动实时通道。
// 后果不是"少个动画"——撤销一条分享之后，那位客人屏幕上的图还在，
// 还在跟着别人的标记实时变化，直到他自己关掉标签页。
// 「链接就是授权本身、撤销即刻生效」那时只兑现了一半。
//
// 所以每一条用例断言的都是**效果**，不是"某个函数被调用过"：
// 事件真的到了客户端手里，连接真的被服务端关掉了。
// mock 一个 presence 模块再断言调用次数，测的是接线，不是断流。
// ─────────────────────────────────────────────────────────────────────────────

describe('管理操作对已经建立的 SSE 连接立即生效', () => {
  /** 建一条分享、让一位访客 join，并把开流要用的东西一并交出来。 */
  async function shareWithGuest(nickname = '新娘小林') {
    await post('/api/library/open', { body: { root } });
    const created = await post('/api/admin/shares', { body: { root } });
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

  it('撤销分享后，访客那条连接收到 share-ended 并被服务端断开', async () => {
    const { share, sessionId, cookie } = await shareWithGuest();
    const ctrl = new AbortController();

    // 摄影师自己也开着界面。撤销一条链接正是为了继续在本机干活，
    // 把他自己的连接一起打断是荒谬的——所以这条连接必须活下来。
    remoteOverride = null;
    const photographer = await openStream(sessionId, '', ctrl.signal);

    remoteOverride = GUEST_IP;
    const guest = await openStream(sessionId, cookie, ctrl.signal);

    const res = await del(`/api/admin/shares/${share.id}`, { ip: null });
    expect(res.status).toBe(200);

    const seen = await guest.readUntil();
    expect(seen.events).toContainEqual({ type: 'share-ended', reason: 'revoked' });
    // 只发事件不断开不叫撤销：客户端完全可以忽略那条事件继续用这条流。
    expect(seen.closed).toBe(true);

    // 摄影师这条连接不但没断，还收到了访客离场之后的新名单——
    // 「还活着」用"它继续在收东西"来证明，比"此刻碰巧还没关"结实：
    // 连接要是也被 endShare 断掉了，这一帧永远等不到，closed 会变成 true。
    const mine = await photographer.readUntil({ until: guestCameAndWent });
    expect(mine.closed).toBe(false);
    expect(guestCameAndWent(mine.events)).toBe(true);

    ctrl.abort();
  });

  it('禁用用户后，他的每一个标签页都收到 kicked 并被断开', async () => {
    const { share, user, sessionId, cookie } = await shareWithGuest();
    const ctrl = new AbortController();
    remoteOverride = GUEST_IP;

    // 两个标签页。只断掉其中一条等于没踢：剩下那条照样在收广播。
    const tabs = [
      await openStream(sessionId, cookie, ctrl.signal),
      await openStream(sessionId, cookie, ctrl.signal),
    ];

    const res = await patch(`/api/admin/shares/${share.id}/users/${user.id}`, {
      body: { disabled: true }, ip: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.user.disabled).toBe(true);

    for (const tab of tabs) {
      const seen = await tab.readUntil();
      expect(seen.events).toContainEqual({ type: 'kicked', reason: 'disabled' });
      expect(seen.closed).toBe(true);
    }

    ctrl.abort();
  });

  it('删除用户后，他的连接收到 kicked 并被断开（令牌都不存在了，连接不能留着）', async () => {
    const { share, user, sessionId, cookie } = await shareWithGuest();
    const ctrl = new AbortController();
    remoteOverride = GUEST_IP;
    const guest = await openStream(sessionId, cookie, ctrl.signal);

    const res = await del(`/api/admin/shares/${share.id}/users/${user.id}`, { ip: null });
    expect(res.status).toBe(200);
    expect(await listUsers(share.id)).toEqual([]);

    const seen = await guest.readUntil();
    expect(seen.events).toContainEqual({ type: 'kicked', reason: 'disabled' });
    expect(seen.closed).toBe(true);

    ctrl.abort();
  });

  it('改角色只推 role 事件，连接必须留着（被改成只读的人应该继续看得见照片）', async () => {
    const { share, user, sessionId, cookie } = await shareWithGuest();
    const url = `/api/admin/shares/${share.id}/users/${user.id}`;
    const ctrl = new AbortController();
    remoteOverride = GUEST_IP;
    const guest = await openStream(sessionId, cookie, ctrl.signal);

    expect((await patch(url, { body: { role: 'viewer' }, ip: null })).status).toBe(200);
    const first = await guest.readUntil({
      until: (evs) => evs.some((e) => e.type === 'role'),
    });
    expect(first.events).toContainEqual({ type: 'role', userId: user.id, role: 'viewer' });

    // **改权限不是踢人。** 光断言"此刻还没断"证明不了什么（断开的字节可能
    // 只是还没到），真正的证明是这条流还能继续送东西过来：连接要是被断掉了，
    // 下面这次读只会读到流结束，until 永远不成立。
    expect((await patch(url, { body: { role: 'editor' }, ip: null })).status).toBe(200);
    const second = await guest.readUntil({
      until: (evs) => evs.some((e) => e.type === 'role' && e.role === 'editor'),
    });
    expect(second.closed).toBe(false);
    expect(second.events).toContainEqual({ type: 'role', userId: user.id, role: 'editor' });

    ctrl.abort();
  });

  it('改 showPeerMarks 会推 peer-marks 给该分享的访客，连接留着', async () => {
    // 没有这条，「PATCH 白名单里加了字段、但忘了推事件」不会被任何用例抓到：
    // 落盘和响应都对，只有已经开着页面的客户会一直看着一份过期的标记，
    // 直到她自己刷新。同一形状在这个计划里已经栽过两次。
    const { share, sessionId, cookie } = await shareWithGuest();
    const ctrl = new AbortController();
    remoteOverride = GUEST_IP;
    const guest = await openStream(sessionId, cookie, ctrl.signal);

    expect((await patch(`/api/admin/shares/${share.id}`, {
      body: { showPeerMarks: false }, ip: null,
    })).status).toBe(200);

    const off = await guest.readUntil({
      until: (evs) => evs.some((e) => e.type === 'peer-marks'),
    });
    expect(off.events).toContainEqual({ type: 'peer-marks', showPeerMarks: false });

    // 反方向也要推：只推 true → false 的话，摄影师在管理台上重新打开开关，
    // 客户那边还是空的，而管理台显示的是"已公开"。
    expect((await patch(`/api/admin/shares/${share.id}`, {
      body: { showPeerMarks: true }, ip: null,
    })).status).toBe(200);
    const on = await guest.readUntil({
      until: (evs) => evs.some((e) => e.type === 'peer-marks' && e.showPeerMarks === true),
    });
    expect(on.closed).toBe(false);

    ctrl.abort();
  });

  it('值没变时不推 peer-marks', async () => {
    // 新建的分享本来就是 true，再设一次 true 什么都没变。无条件推的话，
    // 每个在线访客都会白重拉一次标记，而屏幕上一个像素都不会动。
    const { share, sessionId, cookie } = await shareWithGuest();
    const ctrl = new AbortController();
    remoteOverride = GUEST_IP;
    const guest = await openStream(sessionId, cookie, ctrl.signal);

    expect((await patch(`/api/admin/shares/${share.id}`, {
      body: { showPeerMarks: true }, ip: null,
    })).status).toBe(200);

    // 「没有这帧」只能靠超时来证明。readUntil 不带 until 就是读到超时为止，
    // 和上面 share-ended 那条用例用的是同一个套路。
    const seen = await guest.readUntil();
    expect(seen.events.some((e) => e.type === 'peer-marks')).toBe(false);

    ctrl.abort();
  });

  it('管理员那条连接收不到 peer-marks', async () => {
    // 这个开关对摄影师没有任何影响——他看到的从来就是全部。推给他只会让
    // 他的界面白重算一遍，还会让「这条事件意味着要按新口径过滤」这个约定
    // 在管理员侧变成一句没有意义的话。
    const { share, sessionId, cookie } = await shareWithGuest();
    const ctrl = new AbortController();

    remoteOverride = null;
    const photographer = await openStream(sessionId, '', ctrl.signal);
    remoteOverride = GUEST_IP;
    const guest = await openStream(sessionId, cookie, ctrl.signal);

    expect((await patch(`/api/admin/shares/${share.id}`, {
      body: { showPeerMarks: false }, ip: null,
    })).status).toBe(200);

    // 先等访客真的收到，再看摄影师那边——否则"摄影师没收到"可能只是因为
    // 这一刻谁都还没收到，这条用例会变成永远为真。
    await guest.readUntil({ until: (evs) => evs.some((e) => e.type === 'peer-marks') });
    const mine = await photographer.readUntil();
    expect(mine.events.some((e) => e.type === 'peer-marks')).toBe(false);

    ctrl.abort();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 建分享的路径边界
// ─────────────────────────────────────────────────────────────────────────────

describe('建分享时 root 过 assertWithin + realpathDeep', () => {
  it('root 越界被拒，且不会留下半条分享', async () => {
    const res = await post('/api/admin/shares', { body: { root: '/etc' } });
    expect(res.status).toBe(403);
    expect(await listShares()).toHaveLength(0);
  });

  it('软链接进来的 root 被归一化成和会话完全相同的真实路径', async () => {
    const opened = await post('/api/library/open', { body: { root: link } });
    expect(opened.status).toBe(200);

    const created = await post('/api/admin/shares', { body: { root: link, label: '软链接' } });
    expect(created.status).toBe(200);

    // 裸串比较是 requirePerm 判 wrong-library 的方式，所以这里必须是**全等**，
    // 不是"指向同一个文件夹"。
    expect(created.body.share.root).toBe(opened.body.root);
    expect(created.body.share.root).toBe(root);
  });

  it('经软链接建的分享，访客 join 之后读得到资产（不会撞 wrong-library）', async () => {
    const created = await post('/api/admin/shares', { body: { root: link } });
    expect(created.status).toBe(200);
    const token = created.body.share.token;

    const joined = await post(`/api/share/${token}/join`, {
      body: { nickname: '新娘小林' }, ip: GUEST_IP,
    });
    expect(joined.status).toBe(200);

    const assets = await get('/api/library/assets', {
      cookie: cookieFrom(joined),
      headers: { 'X-PhotoCull-Session': joined.body.sessionId },
      ip: GUEST_IP,
    });
    expect(assets.status).toBe(200);
  });

  it('不传 root 时取当前会话的 root', async () => {
    const opened = await post('/api/library/open', { body: { root } });
    const created = await post('/api/admin/shares', {
      body: { label: '当前这个库' },
      headers: { 'X-PhotoCull-Session': opened.body.sessionId },
    });
    expect(created.status).toBe(200);
    expect(created.body.share.root).toBe(root);
  });

  it('既没传 root 又没有会话时 400，不是凭空猜一个目录', async () => {
    const res = await post('/api/admin/shares', { body: { label: '没说分享哪个文件夹' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no-root');
    expect(await listShares()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 撤销是软删
// ─────────────────────────────────────────────────────────────────────────────

describe('撤销分享是软删', () => {
  it('撤销后分享记录、用户表、审计日志全都还在', async () => {
    const share = await createShare({ root, label: '婚礼初选' });
    const user = await createUser(share.id, '新娘小林', 'editor');
    await logEvent(share.id, { actor: user.id, nickname: user.nickname, action: 'user.join' }, []);

    const res = await del(`/api/admin/shares/${share.id}`);
    expect(res.status).toBe(200);

    const after = await getShareById(share.id);
    expect(after).toBeTruthy();
    expect(after.revoked).toBe(true);

    // 「谁在什么时候进来过」是撤销之后才更需要的信息。
    expect((await listUsers(share.id)).map((u) => u.id)).toEqual([user.id]);
    expect((await readEvents(share.id, {})).map((e) => e.action))
      .toEqual(['share.revoke', 'user.join']);
  });

  it('撤销之后 users / events 两条查询接口仍然可用', async () => {
    const share = await createShare({ root });
    await createUser(share.id, '新娘小林', 'editor');
    await del(`/api/admin/shares/${share.id}`);

    const users = await get(`/api/admin/shares/${share.id}/users`);
    expect(users.status).toBe(200);
    expect(users.body.users).toHaveLength(1);

    const events = await get(`/api/admin/shares/${share.id}/events`);
    expect(events.status).toBe(200);
    expect(events.body.events.map((e) => e.action)).toContain('share.revoke');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. 留痕
// ─────────────────────────────────────────────────────────────────────────────

describe('管理操作留痕', () => {
  it('建分享写一条 share.create', async () => {
    const created = await post('/api/admin/shares', { body: { root, label: '婚礼初选' } });
    const events = await readEvents(created.body.share.id, {});
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('share.create');
    expect(events[0].actor).toBe('admin');
    expect(events[0].label).toBe('婚礼初选');
  });

  it('改分享写一条 share.update，记下变更前后的字段', async () => {
    const share = await createShare({ root, label: '旧标签' });
    const res = await patch(`/api/admin/shares/${share.id}`, { body: { label: '新标签' } });
    expect(res.status).toBe(200);
    expect(res.body.share.label).toBe('新标签');

    const events = await readEvents(share.id, { action: 'share.update' });
    expect(events).toHaveLength(1);
    expect(events[0].from).toEqual({ label: '旧标签' });
    expect(events[0].to).toEqual({ label: '新标签' });
  });

  it('PATCH 分享改不动 root 和 token', async () => {
    const share = await createShare({ root, label: '旧标签' });
    await patch(`/api/admin/shares/${share.id}`, {
      body: { root: '/etc', token: 'ffff', label: '新标签' },
    });
    const after = await getShareById(share.id);
    expect(after.root).toBe(root);
    expect(after.token).toBe(share.token);
    expect(after.label).toBe('新标签');
  });

  it('改角色写一条 user.role-change，from/to 正确', async () => {
    const share = await createShare({ root });
    const user = await createUser(share.id, '新娘小林', 'editor');

    await patch(`/api/admin/shares/${share.id}/users/${user.id}`, { body: { role: 'viewer' } });

    const events = await readEvents(share.id, { action: 'user.role-change' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: 'admin', nickname: '新娘小林', targetUserId: user.id, from: 'editor', to: 'viewer',
    });
    expect((await listUsers(share.id))[0].role).toBe('viewer');
  });

  it('角色没变时不写留痕（审计日志不该被无操作填满）', async () => {
    const share = await createShare({ root });
    const user = await createUser(share.id, '新娘小林', 'editor');

    // 先证明这一次 PATCH 真的被受理了——否则一条根本没接线的路由
    // （或者一个 404）也能让下面那句 toEqual([]) 空转成绿。
    const res = await patch(`/api/admin/shares/${share.id}/users/${user.id}`, {
      body: { role: 'editor' },
    });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('editor');

    expect(await readEvents(share.id, {})).toEqual([]);
  });

  it('禁用 / 启用分别写 user.disable / user.enable', async () => {
    const share = await createShare({ root });
    const user = await createUser(share.id, '新娘小林', 'editor');
    const url = `/api/admin/shares/${share.id}/users/${user.id}`;

    const off = await patch(url, { body: { disabled: true } });
    expect(off.body.user.disabled).toBe(true);
    const on = await patch(url, { body: { disabled: false } });
    expect(on.body.user.disabled).toBe(false);

    expect((await readEvents(share.id, {})).map((e) => e.action))
      .toEqual(['user.enable', 'user.disable']);   // 倒序
  });

  it('删除用户留痕，且令牌立即失效', async () => {
    const share = await createShare({ root });
    const user = await createUser(share.id, '新娘小林', 'editor');

    const res = await del(`/api/admin/shares/${share.id}/users/${user.id}`);
    expect(res.status).toBe(200);

    expect(await listUsers(share.id)).toEqual([]);
    expect(await findUserByToken(user.token)).toBeNull();

    const events = await readEvents(share.id, {});
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: 'admin', nickname: '新娘小林', targetUserId: user.id,
    });
    // 删除是不可撤销的，它必须留下一条**区分得开**的痕迹，不能记成 user.disable。
    expect(events[0].action).not.toBe('user.disable');
    expect(events[0].action).toBe('user.delete');
    // 而且这个字面量必须真的在动作全集里。logEvent 不校验 ACTIONS，所以一个
    // 只存在于 admin.js 里的现造字符串照样能落盘、照样能被过滤和导出——
    // 唯一会发现"全集其实不全"的地方就是这一行。
    expect(ACTIONS).toContain(events[0].action);
  });

  it('留痕里搜不到任何令牌', async () => {
    const created = await post('/api/admin/shares', { body: { root, label: '婚礼初选' } });
    const share = created.body.share;
    const user = await createUser(share.id, '新娘小林', 'editor');
    await patch(`/api/admin/shares/${share.id}/users/${user.id}`, { body: { role: 'viewer' } });
    await del(`/api/admin/shares/${share.id}/users/${user.id}`);
    await del(`/api/admin/shares/${share.id}`);

    const res = await get(`/api/admin/shares/${share.id}/events`);
    const blob = JSON.stringify(res.body);
    expect(res.body.events.length).toBeGreaterThan(0);
    for (const token of [share.token, user.token]) {
      expect(blob).not.toContain(token);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 审计日志查询与 CSV
// ─────────────────────────────────────────────────────────────────────────────

describe('审计日志查询', () => {
  it('按 actor 和 action 过滤', async () => {
    const share = await createShare({ root });
    await logEvent(share.id, { actor: 'u_1', action: 'mark.set', assetId: 'a' }, []);
    await logEvent(share.id, { actor: 'u_2', action: 'mark.set', assetId: 'b' }, []);
    await logEvent(share.id, { actor: 'u_1', action: 'user.join' }, []);

    const byActor = await get(`/api/admin/shares/${share.id}/events?actor=u_1`);
    expect(byActor.body.events.map((e) => e.action)).toEqual(['user.join', 'mark.set']);

    const byAction = await get(`/api/admin/shares/${share.id}/events?action=mark.set`);
    expect(byAction.body.events.map((e) => e.actor)).toEqual(['u_2', 'u_1']);

    const both = await get(`/api/admin/shares/${share.id}/events?actor=u_1&action=mark.set`);
    expect(both.body.events).toHaveLength(1);
    expect(both.body.total).toBe(1);
  });

  /**
   * 同一毫秒里写进来的多条事件是常态（批量标记、一次撤销带出的连锁事件）。
   * 用「下一页从最后一条的 ts 往前取」做游标，边界上同 ts 的兄弟会被整批跳过——
   * 审计日志丢行是最不能接受的一种 bug，所以分页必须按序号切，不是按时间戳切。
   */
  it('同一毫秒的多条事件分页时不丢行也不重复', async () => {
    const share = await createShare({ root });
    const ts = 1785000000000;
    for (let i = 0; i < 5; i++) {
      await logEvent(share.id, { ts, actor: 'admin', action: 'mark.set', assetId: `a${i}` }, []);
    }

    const seen = [];
    for (let offset = 0; offset < 6; offset += 2) {
      const page = await get(`/api/admin/shares/${share.id}/events?limit=2&offset=${offset}`);
      expect(page.body.total).toBe(5);
      seen.push(...page.body.events.map((e) => e.assetId));
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('limit 有上限，不会被一个巨大的值拖垮', async () => {
    const share = await createShare({ root });
    const res = await get(`/api/admin/shares/${share.id}/events?limit=999999`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBeLessThanOrEqual(1000);
  });
});

describe('审计日志 CSV', () => {
  it('列布局是 ts,actor,nickname,action,payload', async () => {
    const share = await createShare({ root });
    const res = await get(`/api/admin/shares/${share.id}/events.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.text.split('\r\n')[0]).toBe('ts,actor,nickname,action,payload');
  });

  it('含逗号和引号的昵称被正确转义，且全文搜不到令牌', async () => {
    const share = await createShare({ root });
    // 昵称归一化只拒控制字符，逗号和引号是合法的——正是它们会撑破一份没转义的 CSV。
    const user = await createUser(share.id, '小林,"甲"', 'editor');
    await patch(`/api/admin/shares/${share.id}/users/${user.id}`, { body: { role: 'viewer' } });

    const res = await get(`/api/admin/shares/${share.id}/events.csv`);
    expect(res.text).toContain('"小林,""甲"""');
    expect(res.text).not.toContain(user.token);
    expect(res.text).not.toContain(share.token);

    const rows = res.text.trim().split('\r\n');
    expect(rows).toHaveLength(2);        // 表头 + 一条，转义没把一行撑成两行
    expect(rows[1]).toContain('user.role-change');
  });

  it('CSV 也吃 actor / action 过滤', async () => {
    const share = await createShare({ root });
    await logEvent(share.id, { actor: 'u_1', action: 'mark.set', assetId: 'a' }, []);
    await logEvent(share.id, { actor: 'u_2', action: 'user.join' }, []);

    const res = await get(`/api/admin/shares/${share.id}/events.csv?action=user.join`);
    const rows = res.text.trim().split('\r\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('user.join');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. 找不到的东西一律 404，不是 500
// ─────────────────────────────────────────────────────────────────────────────

describe('未知 id', () => {
  it('未知 share id 的每一条路由都是 404 share-not-found', async () => {
    const id = 'sh_deadbeef';
    const calls = [
      patch(`/api/admin/shares/${id}`, { body: { label: 'x' } }),
      del(`/api/admin/shares/${id}`),
      get(`/api/admin/shares/${id}/users`),
      patch(`/api/admin/shares/${id}/users/u_1`, { body: { role: 'viewer' } }),
      del(`/api/admin/shares/${id}/users/u_1`),
      get(`/api/admin/shares/${id}/events`),
      get(`/api/admin/shares/${id}/events.csv`),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('share-not-found');
    }
  });

  it('未知 user id 是 404 user-not-found', async () => {
    const share = await createShare({ root });
    const res = await patch(`/api/admin/shares/${share.id}/users/u_nope`, {
      body: { role: 'viewer' },
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('user-not-found');
    const gone = await del(`/api/admin/shares/${share.id}/users/u_nope`);
    expect(gone.status).toBe(404);
  });

  it('非法角色被拒，不会把一个乱码角色写进用户表', async () => {
    const share = await createShare({ root });
    const user = await createUser(share.id, '新娘小林', 'editor');
    const res = await patch(`/api/admin/shares/${share.id}/users/${user.id}`, {
      body: { role: 'superuser' },
    });
    expect(res.status).toBe(400);
    expect((await listUsers(share.id))[0].role).toBe('editor');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. 名册（Task 21）：GET /api/admin/library-users
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 打开 root 对应的库并以管理员身份发一个 GET，自动带上当前会话的
 * X-PhotoCull-Session。复用 beginSession 对同一个 canonicalRoot 的幂等语义——
 * 这个 root 在文件里其它用例可能已经开过库，这里再开一次只是原地拿回
 * 同一个会话，不会重扫。
 */
async function adminGet(p) {
  const opened = await post('/api/library/open', { body: { root }, ip: null });
  return get(p, { ip: null, headers: { 'X-PhotoCull-Session': opened.body.sessionId } });
}

/** 管理员身份，但不带任何会话 id——模拟"还没有打开任何文件夹"。 */
function adminGetWithoutSession(p) {
  return get(p, { ip: null });
}

/**
 * 一个真的建过用户记录的访客：kind 是 'user'，不是 'none'。
 *
 * 必须走真实的用户身份而不是干脆不带 Cookie——不带 Cookie 的请求会在
 * defaultDeny 那一层就被拦成 401，验证不到 requireAdmin 自己给出的 403。
 */
async function guestGet(p) {
  const share = await createShare({ root });
  const user = await createUser(share.id, '路人', 'viewer');
  return get(p, { cookie: `pc_user=${user.token}`, ip: GUEST_IP });
}

describe('GET /api/admin/library-users', () => {
  let testRoot;
  beforeEach(() => { testRoot = root; });

  it('把当前文件夹下所有分享的用户合并列出', async () => {
    // 筛选下拉必须列出**所有贡献过的人**，包括早就离线的——
    // 客户端手里只有一份在线名单，解析不出他们的昵称。
    const s1 = await createShare({ root: testRoot, label: '新人' });
    const s2 = await createShare({ root: testRoot, label: '父母' });
    await createUser(s1.id, '小林', 'editor');
    await createUser(s2.id, '妈妈', 'editor');

    const res = await adminGet('/api/admin/library-users');
    expect(res.status).toBe(200);
    expect(res.body.users.map((u) => u.nickname).sort()).toEqual(['妈妈', '小林']);
  });

  it('别的文件夹的分享不算进来', async () => {
    const other = await createShare({ root: '/tmp/别的文件夹' });
    await createUser(other.id, '路人', 'editor');
    const res = await adminGet('/api/admin/library-users');
    expect(res.body.users.map((u) => u.nickname)).not.toContain('路人');
  });

  it('已撤销/已过期的分享下的用户照常列出', async () => {
    // 他们的贡献还在 contrib 里，筛不出名字才是问题。
    const s = await createShare({ root: testRoot });
    await createUser(s.id, '老客户', 'editor');
    await revokeShare(s.id);
    const res = await adminGet('/api/admin/library-users');
    expect(res.body.users.map((u) => u.nickname)).toContain('老客户');
  });

  it('响应里没有令牌', async () => {
    const s = await createShare({ root: testRoot });
    await createUser(s.id, '小林', 'editor');
    const res = await adminGet('/api/admin/library-users');
    expect(JSON.stringify(res.body)).not.toContain('token');
    for (const u of res.body.users) expect(Object.keys(u).sort()).toEqual(['id', 'nickname']);
  });

  it('没有打开任何文件夹时回 400', async () => {
    const res = await adminGetWithoutSession('/api/admin/library-users');
    expect(res.status).toBe(400);
  });

  it('访客 403', async () => {
    const res = await guestGet('/api/admin/library-users');
    expect(res.status).toBe(403);
  });
});

describe('PATCH showPeerMarks', () => {
  it('改得动，并且回在响应里', async () => {
    const share = await createShare({ root });
    const res = await patch(`/api/admin/shares/${share.id}`, {
      body: { showPeerMarks: false }, ip: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.share.showPeerMarks).toBe(false);
  });

  it('非布尔值 400，且什么都没改', async () => {
    const share = await createShare({ root });
    const res = await patch(`/api/admin/shares/${share.id}`, {
      body: { showPeerMarks: 'no' }, ip: null,
    });
    expect(res.status).toBe(400);
    // 400 之后落盘必须原样。校验和写入分两步的实现里，"先写后校验"同样能回 400。
    expect((await getShareById(share.id)).showPeerMarks).toBe(true);
  });

  it('老记录里没有这个字段时，接口报公开', async () => {
    // 判据必须是 `!== false`。写成 `=== true` 或 `!!x` 的话，升级之后每一条
    // 老链接在管理台上都会显示成"已隐藏客户标记"——摄影师从没做过这个操作。
    const share = await createShare({ root });
    const file = path.join(home, 'shares.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    delete raw.shares[share.id].showPeerMarks;
    await fs.writeFile(file, JSON.stringify(raw));

    const res = await get('/api/admin/shares', { ip: null });
    expect(res.status).toBe(200);
    const found = res.body.shares.find((s) => s.id === share.id);
    expect(found.showPeerMarks).toBe(true);
  });
});
