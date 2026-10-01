import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.js';
import { closeAllSessions, openSession, getSessionByRoot } from '../lib/session.js';
import { createShare, revokeShare, updateShare } from '../lib/shares.js';
import { createUser, updateUser, findUserByToken, listUsers } from '../lib/users.js';
import { readEvents, eventsPath } from '../lib/audit.js';
import { newToken } from '../lib/tokens.js';
import { _test as shareTest } from './share.js';

/**
 * `/api/share/*` —— 访客接入的全部入口。
 *
 * 这个文件里最要紧的一条是第一个 describe：**过期、撤销、不存在三种情况的
 * HTTP 响应必须逐字节一致**。任何一点差异（状态码、body、哪怕多一个响应头）
 * 都会变成一个"这个 token 曾经有效"的判定器，而那正是 43 字符随机令牌
 * 想要挡住的东西。真实原因只允许出现在审计日志里。
 */

/** 访客请求的伪造源地址。必须不是回环，否则 resolveActor 直接把访客判成管理员。 */
const GUEST_IP = '192.168.1.50';

let server;
let base;
let home;        // PHOTOCULL_HOME：分享/用户存储，绝不能碰开发者真实的 ~/.photocull
let root;        // 被分享的照片文件夹（会话 root）
let savedHome;

/** 每个用例一套全新的分享，避免上一条用例写进去的审计事件干扰断言的顺序。 */
let active;
let expired;
let revoked;

/**
 * 逐请求可切换的 TCP 源地址。做法与 permissions.test.js 一致：请求仍然走真实
 * TCP，只有 `req.socket.remoteAddress` 这一个字段被换掉，而那正是
 * `isLoopback()` 和 `clientAddress()` 唯一读的东西。
 * keep-alive 会复用 socket，所以每次先 delete 掉上一轮留下的自有属性。
 */
let remoteOverride = GUEST_IP;

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-share-root-')));

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
});

beforeEach(async () => {
  savedHome = process.env.PHOTOCULL_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-share-home-'));
  process.env.PHOTOCULL_HOME = home;
  remoteOverride = GUEST_IP;
  // 限流器是模块级状态，用例之间必须清干净：上一条用例攒下的失败次数会让
  // 下一条用例莫名其妙地拿到 429。
  shareTest.failures.reset();

  active = await createShare({ root, label: '婚礼初选给新人' });
  expired = await createShare({ root, label: '已过期', expiresAt: Date.now() - 1 });
  revoked = await createShare({ root, label: '已撤销' });
  await revokeShare(revoked.id);
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
  return {
    status: res.status,
    body: parsed,
    setCookie: res.headers.getSetCookie(),
    headers: res.headers,
  };
}

const get = (p, opts) => request('GET', p, opts);
const post = (p, opts) => request('POST', p, opts);

/** 除 date 之外的全部响应头。date 是唯一一个不由响应内容决定的头。 */
function stableHeaders(res) {
  const out = {};
  for (const [k, v] of res.headers) {
    if (k.toLowerCase() === 'date') continue;
    out[k.toLowerCase()] = v;
  }
  return out;
}

const joinAs = (share, nickname, opts) =>
  post(`/api/share/${share.token}/join`, { body: { nickname }, ...opts });

/** 从 Set-Cookie 串里取出 pc_user 的值，供后续请求当 Cookie 用。 */
function cookieFrom(res) {
  const raw = res.setCookie.find((c) => c.startsWith('pc_user='));
  return raw.split(';')[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 三种无效原因不可区分
// ─────────────────────────────────────────────────────────────────────────────

describe('无效链接：过期 / 撤销 / 不存在不可区分', () => {
  it('过期、撤销、不存在三种情况的响应逐字节一致', async () => {
    const a = await get(`/api/share/${expired.token}/info`);
    const b = await get(`/api/share/${revoked.token}/info`);
    const c = await get(`/api/share/${newToken()}/info`);

    expect(a.status).toBe(404);
    expect(b.status).toBe(a.status);
    expect(c.status).toBe(a.status);
    expect(b.body).toEqual(a.body);
    expect(c.body).toEqual(a.body);   // 不得泄露有效 token 的存在性
    expect(a.body).toEqual({ error: 'invalid-link', message: '链接不存在或已失效' });
  });

  it('连响应头都一致（多一个 Set-Cookie 就够当判定器用了）', async () => {
    const a = await get(`/api/share/${expired.token}/info`);
    const b = await get(`/api/share/${revoked.token}/info`);
    const c = await get(`/api/share/${newToken()}/info`);

    expect(stableHeaders(b)).toEqual(stableHeaders(a));
    expect(stableHeaders(c)).toEqual(stableHeaders(a));
    for (const res of [a, b, c]) expect(res.setCookie).toEqual([]);
  });

  it('join 上的三种无效原因同样不可区分', async () => {
    const a = await joinAs(expired, '小林');
    const b = await joinAs(revoked, '小林');
    const c = await post(`/api/share/${newToken()}/join`, { body: { nickname: '小林' } });

    expect(a.status).toBe(404);
    expect(b.body).toEqual(a.body);
    expect(c.body).toEqual(a.body);
    expect(stableHeaders(b)).toEqual(stableHeaders(a));
    expect(stableHeaders(c)).toEqual(stableHeaders(a));
  });

  it('resume 上的三种无效原因同样不可区分', async () => {
    const a = await post(`/api/share/${expired.token}/resume`);
    const b = await post(`/api/share/${revoked.token}/resume`);
    const c = await post(`/api/share/${newToken()}/resume`);

    expect(a.status).toBe(404);
    expect(b.body).toEqual(a.body);
    expect(c.body).toEqual(a.body);
    expect(stableHeaders(b)).toEqual(stableHeaders(a));
    expect(stableHeaders(c)).toEqual(stableHeaders(a));
  });

  it('但审计日志里记下了真实原因', async () => {
    await get(`/api/share/${expired.token}/info`);
    const events = await readEvents(expired.id, {});
    expect(events[0]).toMatchObject({ action: 'user.denied', reason: 'expired' });
  });

  it('撤销记的是 revoked，不是 expired', async () => {
    await get(`/api/share/${revoked.token}/info`);
    const events = await readEvents(revoked.id, {});
    expect(events[0]).toMatchObject({ action: 'user.denied', reason: 'revoked' });
  });

  it('不存在的 token 不写任何日志（无从得知 shareId，也不该被人凭空造出目录）', async () => {
    await get(`/api/share/${newToken()}/info`);
    const dirs = await fs.readdir(path.join(home, 'shares')).catch(() => []);
    expect(dirs).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. info
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/share/:token/info', () => {
  it('有效链接返回约定的五个字段', async () => {
    const res = await get(`/api/share/${active.token}/info`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ['allowUserCreation', 'assetCountHint', 'expiresAt', 'label', 'requiresNickname'],
    );
    expect(res.body.label).toBe('婚礼初选给新人');
    expect(res.body.allowUserCreation).toBe(true);
    expect(res.body.requiresNickname).toBe(true);
    expect(res.body.expiresAt).toBe(null);
  });

  it('info 不泄露任何令牌或路径', async () => {
    const res = await get(`/api/share/${active.token}/info`);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(active.token);
    expect(text).not.toContain(root);        // 客户不该知道照片在摄影师磁盘的哪里
    expect(text).not.toContain(active.id);
  });

  it('无身份也能读（白名单：门禁是链接本身，不是身份）', async () => {
    const res = await get(`/api/share/${active.token}/info`);
    expect(res.status).toBe(200);
  });
});

/**
 * assetCountHint —— 「约 N 张照片」那行字的来源。
 *
 * 三种状态必须分得开，而且区别不在措辞上而在**语义**上：
 *   没开库   -> null（不知道）
 *   扫完了   -> 数字（知道）
 *   正在扫   -> null（还不知道）**不是 0**
 * 最后一条是这组用例真正的理由：session.assets 在扫完之前一直是空数组，
 * 直接取 .length 会得到 0，而前端只判 `!= null`，于是客人会看到
 * 「约 0 张照片」——一句读起来像"这个库是空的"的假话。
 *
 * 同时这个端点是**无身份**可达的，所以它只许查已经开着的会话，
 * 绝不能为了回答这个问题去碰磁盘（那等于挂一个谁都能按的扫盘按钮）。
 */
describe('GET /api/share/:token/info —— assetCountHint', () => {
  // 用 RAW 后缀而不是 .jpg，这不是随手挑的：asset.jpg 为 null 时 readAllMeta
  // 整段跳过 exifr（meta.js 的 `if (asset.jpg)`），烘焙的 total 也是 0。
  // 这组用例要证的是"数得对不对"，不该顺带把 EXIF 解析和 sharp 拖进来。
  // 换成 .jpg 会立刻有代价：exifr 解析畸形文件时抛异常并**漏掉自己的
  // FileHandle**（已实测，见 progress.md），跑一次就往输出里灌一串
  // "Closing file descriptor N on garbage collection"。
  // root 要等外层 beforeAll 才有值，所以这里只能存文件名，路径进钩子里再拼。
  const FIXTURES = ['a.cr2', 'b.cr2'];

  beforeAll(async () => {
    for (const n of FIXTURES) await fs.writeFile(path.join(root, n), 'x');
  });

  afterAll(async () => {
    await closeAllSessions();
    for (const n of FIXTURES) await fs.rm(path.join(root, n), { force: true });
  });

  afterEach(async () => { await closeAllSessions(); });

  it('库没开着时是 null（无身份端点不为了回答它去扫盘）', async () => {
    const res = await get(`/api/share/${active.token}/info`);
    expect(res.body.assetCountHint).toBe(null);
  });

  it('库开着且扫完了就给出实际张数', async () => {
    await openSession(root);
    const res = await get(`/api/share/${active.token}/info`);
    expect(res.body.assetCountHint).toBe(2);
  });

  it('还在扫的时候是 null，不是 0', async () => {
    await openSession(root);
    const session = getSessionByRoot(root);
    // 确定性探针：与其去赛跑一个真实的扫描窗口，不如直接把会话按回"扫描中"，
    // 精确打在那一个分支上。assets 此时是**扫完的**（非空），所以这条用例
    // 只可能因为漏判 scan.done 而变红，不会因为"恰好还没扫出东西"而蒙对。
    expect(session.assets.length).toBe(2);
    session.scan.done = false;
    try {
      const res = await get(`/api/share/${active.token}/info`);
      expect(res.body.assetCountHint).toBe(null);
    } finally {
      session.scan.done = true;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. join
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/share/:token/join', () => {
  it('join 下发的 Cookie 是 HttpOnly + SameSite=Lax', async () => {
    const res = await joinAs(active, '新娘小林');
    expect(res.status).toBe(200);
    const raw = res.setCookie.find((c) => c.startsWith('pc_user='));
    expect(raw).toBeDefined();
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    expect(raw).toContain('Path=/');
    // 令牌只能走 Cookie，绝不能同时出现在响应体里（那样 JS 就读得到了）。
    const user = (await listUsers(active.id))[0];
    expect(JSON.stringify(res.body)).not.toContain(user.token);
  });

  it('join 的响应体带上会话与用户，但同样没有 root', async () => {
    const res = await joinAs(active, '新娘小林');
    expect(res.body.user).toEqual({
      id: expect.any(String), nickname: '新娘小林', role: 'editor',
    });
    expect(res.body.share).toEqual({ label: '婚礼初选给新人' });
    expect(typeof res.body.sessionId).toBe('string');
    expect(JSON.stringify(res.body)).not.toContain(root);
  });

  it('join 成功后复用已经开着的库会话，而不是另开一个', async () => {
    // 摄影师本机先把库打开
    const opened = await post('/api/library/open', { body: { root }, ip: null });
    expect(opened.status).toBe(200);
    remoteOverride = GUEST_IP;

    const res = await joinAs(active, '新娘小林');
    expect(res.body.sessionId).toBe(opened.body.sessionId);

    // 而且这个会话对访客是真的可用的
    const assets = await get('/api/library/assets', {
      headers: { 'X-PhotoCull-Session': res.body.sessionId },
      cookie: cookieFrom(res),
    });
    expect(assets.status).toBe(200);
  });

  it('昵称被占用返回 409 且文案固定', async () => {
    await createUser(active.id, '新娘小林', 'editor');
    const res = await joinAs(active, '新娘小林');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'nickname-taken', message: '这个昵称已经有人在用了，换一个吧',
    });
  });

  it('昵称唯一性按归一化后的 key 判定（半角/全角、大小写算同一个人）', async () => {
    await createUser(active.id, 'Amy', 'editor');
    expect((await joinAs(active, 'ａｍｙ')).status).toBe(409);
  });

  it.each([
    ['   ', 'empty'],
    ['x'.repeat(25), 'too-long'],
    ['小林\u0007', 'bad-chars'],
  ])('昵称 %j 被拒成 400 bad-nickname（reason=%s）', async (nickname, reason) => {
    const res = await joinAs(active, nickname);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad-nickname');
    expect(res.body.reason).toBe(reason);
    expect(typeof res.body.message).toBe('string');
    expect(res.body.message.length).toBeGreaterThan(0);
  });

  it('三种 bad-nickname 的文案互不相同（否则等于没按 reason 给文案）', async () => {
    const messages = new Set();
    for (const nickname of ['   ', 'x'.repeat(25), '小林\u0007']) {
      messages.add((await joinAs(active, nickname)).body.message);
    }
    expect(messages.size).toBe(3);
  });

  it('allowUserCreation=false 时新昵称 403 creation-off', async () => {
    const closed = await createShare({ root, label: '不再接纳', allowUserCreation: false });
    await createUser(closed.id, '小林', 'editor');
    const res = await joinAs(closed, '小王');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'creation-off', message: '这条链接已停止接纳新成员' });
  });

  it('allowUserCreation=false 时已存在的昵称仍是 409，不能凭昵称顶替别人的身份', async () => {
    // 规格 §5.2「同一分享内昵称唯一，已被占用时返回 409」是无条件的。
    // 如果这里放行，任何拿到链接的人只要打出"新娘小林"就能顶替她的身份、
    // 继承她的全部操作记录——审计日志的价值会被一次输入清零。
    const closed = await createShare({ root, label: '不再接纳', allowUserCreation: false });
    await createUser(closed.id, '小林', 'editor');
    const res = await joinAs(closed, '小林');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('nickname-taken');
  });

  it('allowUserCreation=false 不影响已建号的人凭 Cookie 回访', async () => {
    const closed = await createShare({ root, label: '不再接纳' });
    const joined = await joinAs(closed, '小林');
    const cookie = cookieFrom(joined);
    await (await import('../lib/shares.js')).updateShare(closed.id, { allowUserCreation: false });

    const res = await post(`/api/share/${closed.token}/resume`, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.user.nickname).toBe('小林');
  });

  it('maxUsers 满了返回 403 full', async () => {
    const small = await createShare({ root, label: '只准一个人', maxUsers: 1 });
    expect((await joinAs(small, '第一个')).status).toBe(200);
    const res = await joinAs(small, '第二个');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'full', message: '参与人数已达上限' });
  });

  it('每条路径都留痕：join 成功记 user.join，被拒记 user.denied 带 reason', async () => {
    await joinAs(active, '新娘小林');
    await joinAs(active, '新娘小林');
    const events = await readEvents(active.id, {});
    expect(events[0]).toMatchObject({ action: 'user.denied', reason: 'nickname-taken' });
    expect(events[1]).toMatchObject({ action: 'user.join', nickname: '新娘小林' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. resume
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/share/:token/resume', () => {
  it('令牌有效就直接进入，跳过昵称表单', async () => {
    const joined = await joinAs(active, '新娘小林');
    const res = await post(`/api/share/${active.token}/resume`, { cookie: cookieFrom(joined) });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ nickname: '新娘小林', role: 'editor' });
    expect(JSON.stringify(res.body)).not.toContain(root);
    const events = await readEvents(active.id, {});
    expect(events[0]).toMatchObject({ action: 'user.resume' });
  });

  it('resume 在用户被禁用后清 Cookie 并返回 401 need-join', async () => {
    const joined = await joinAs(active, '新娘小林');
    const cookie = cookieFrom(joined);
    const user = (await listUsers(active.id))[0];
    await updateUser(active.id, user.id, { disabled: true });

    const res = await post(`/api/share/${active.token}/resume`, { cookie });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'need-join' });
    const raw = res.setCookie.find((c) => c.startsWith('pc_user='));
    expect(raw).toContain('Max-Age=0');
    expect(raw).toContain('HttpOnly');
    expect(await readEvents(active.id, { action: 'user.denied' })).toMatchObject(
      [{ reason: 'disabled' }],
    );
  });

  it('没有 Cookie 时 401 need-join —— 而且请求确实走到了处理函数', async () => {
    // 这一条同时是白名单第四项的回归测试：resume 若不在 defaultDeny 的白名单里，
    // 无身份的回访者会拿到 401 no-actor，那枚死 Cookie 就永远清不掉。
    const res = await post(`/api/share/${active.token}/resume`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'need-join' });
  });

  it('拿着一枚已经不存在的令牌 -> 401 need-join 并清掉它', async () => {
    const res = await post(`/api/share/${active.token}/resume`, {
      cookie: `pc_user=${newToken()}`,
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'need-join' });
    expect(res.setCookie.find((c) => c.startsWith('pc_user='))).toContain('Max-Age=0');
  });

  it('拿着别条分享的 Cookie -> 401 need-join，但**不**清掉那枚仍然有效的 Cookie', async () => {
    // 清掉的话，这个人回到自己那条链接时会被弹回昵称表单，而他的昵称已经被
    // 自己占着——409 nickname-taken，从此再也进不去。
    const other = await createShare({ root, label: '另一条' });
    const joined = await joinAs(other, '小林');
    const cookie = cookieFrom(joined);

    const res = await post(`/api/share/${active.token}/resume`, { cookie });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'need-join' });
    expect(res.setCookie).toEqual([]);

    // 回到自己那条链接照旧能进
    expect((await post(`/api/share/${other.token}/resume`, { cookie })).status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. leave
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/share/leave', () => {
  it('清 Cookie 并记 session.disconnect', async () => {
    const joined = await joinAs(active, '新娘小林');
    const res = await post('/api/share/leave', { cookie: cookieFrom(joined) });
    expect(res.status).toBe(200);
    expect(res.setCookie.find((c) => c.startsWith('pc_user='))).toContain('Max-Age=0');
    const events = await readEvents(active.id, {});
    expect(events[0]).toMatchObject({ action: 'session.disconnect', nickname: '新娘小林' });
  });

  it('leave 不销毁用户记录，令牌照旧有效（只是浏览器不再带着它）', async () => {
    const joined = await joinAs(active, '新娘小林');
    const cookie = cookieFrom(joined);
    await post('/api/share/leave', { cookie });
    const token = cookie.slice('pc_user='.length);
    expect(await findUserByToken(token)).toMatchObject({ nickname: '新娘小林' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. 限流
// ─────────────────────────────────────────────────────────────────────────────

describe('按 IP 的失败限流', () => {
  const badJoin = () => post(`/api/share/${newToken()}/join`, { body: { nickname: '随便' } });

  it('20 次失败后第 21 次 429', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await badJoin()).status).toBe(404);
    }
    const res = await badJoin();
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'rate-limited', message: '尝试过于频繁，请稍后再试' });
  });

  it('成功的 join 不计入', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await joinAs(active, `访客${i}`)).status).toBe(200);
    }
    // 若成功也计数，这一次早就变成 429 了
    expect((await badJoin()).status).toBe(404);
  });

  it('限流按 TCP 源地址，换个 X-Forwarded-For 骗不过去', async () => {
    for (let i = 0; i < 21; i++) await badJoin();
    const res = await post(`/api/share/${newToken()}/join`, {
      body: { nickname: '随便' },
      headers: { 'X-Forwarded-For': '10.0.0.9' },
    });
    expect(res.status).toBe(429);
  });

  it('换一个真实源地址不受上一个地址的额度影响', async () => {
    for (let i = 0; i < 21; i++) await badJoin();
    expect((await post(`/api/share/${newToken()}/join`, {
      body: { nickname: '随便' }, ip: '192.168.1.77',
    })).status).toBe(404);
  });

  it('info 与 resume 的失败同样计数（否则猜 token 只要换个端点就绕过去了）', async () => {
    for (let i = 0; i < 21; i++) await get(`/api/share/${newToken()}/info`);
    expect((await get(`/api/share/${newToken()}/info`)).status).toBe(429);
    expect((await post(`/api/share/${newToken()}/resume`)).status).toBe(429);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. 令牌不落盘
// ─────────────────────────────────────────────────────────────────────────────

describe('审计日志里没有令牌', () => {
  it('走完一整轮 join/denied/resume/leave 之后日志里搜不到任何令牌', async () => {
    const joined = await joinAs(active, '新娘小林');
    const cookie = cookieFrom(joined);
    await joinAs(active, '新娘小林');           // nickname-taken
    await joinAs(active, '  ');                 // bad-nickname
    await post(`/api/share/${active.token}/resume`, { cookie });
    await post('/api/share/leave', { cookie });
    await get(`/api/share/${expired.token}/info`);

    const user = (await listUsers(active.id))[0];
    for (const shareId of [active.id, expired.id]) {
      const raw = await fs.readFile(eventsPath(shareId), 'utf8');
      expect(raw).not.toContain(active.token);
      expect(raw).not.toContain(expired.token);
      expect(raw).not.toContain(user.token);
      // 结构性的兜底：43 字符的 base64url 串就是一枚令牌的形状。
      expect(raw).not.toMatch(/[A-Za-z0-9_-]{43}/);
    }
  });

  it('logShareEvent 保证脱敏：就算调用方把令牌塞进事件也写不进文件', async () => {
    // 这是这一层的**契约**，不是巧合：路由今天没往事件里放令牌，明天加一个
    // 字段就可能放进去。logShareEvent 必须无条件把该分享名下的全部令牌
    // （share.token + 其下每个 user.token）交给 logEvent 脱敏。
    const user = await createUser(active.id, '小林', 'editor');
    await shareTest.logShareEvent(active, {
      actor: user.id, action: 'user.denied', reason: 'test',
      leaked: active.token, nested: { t: user.token },
    });
    const raw = await fs.readFile(eventsPath(active.id), 'utf8');
    expect(raw).not.toContain(active.token);
    expect(raw).not.toContain(user.token);
    expect(raw).toContain('[redacted]');
  });
});
