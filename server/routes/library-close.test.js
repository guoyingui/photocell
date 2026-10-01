import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.js';
import { closeAllSessions, getSession } from '../lib/session.js';
import { createShare } from '../lib/shares.js';
import { createUser } from '../lib/users.js';

/**
 * 规格 §5.4：管理员在本地关闭一个**仍有访客在线**的库时，界面必须明确告知
 * "还有 N 位访客在线，链接仍然有效"，并给出直达撤销的入口。
 *
 * 修复之前 `POST /api/library/close` 是无条件生效的：closeSession() 会逐条
 * `end()` 掉该会话上的每一条 SSE 连接——**包括访客的**。摄影师以为自己只是
 * 切了个视图，正在浏览器中看图的客户当场掉线，而且没有任何东西提示这件事
 * 即将发生。这一组用例钉的就是那条拦截。
 *
 * 全部走**真实的 HTTP + 真实的 SSE**：要证明的是"被拒绝之后访客那条连接
 * 确实还开着"，假 listener 的 end() 是个空函数，它永远不会告诉你这件事。
 *
 * 每条用例都开一个**自己的**库会话（beforeEach 开、afterEach 关），因为这一组
 * 的主题就是关库——共用一个会话的话，第一条用例就会把后面几条的地基拆掉。
 */

/** 访客请求的伪造源地址。必须不是回环，否则 resolveActor 直接判成管理员。 */
const GUEST_IP = '192.168.1.50';

let server;
let base;
let home;        // PHOTOCULL_HOME：绝不能碰开发者真实的 ~/.photocull
let tmp;         // 被分享的照片文件夹（会话 root）
let savedHome;
let sid = '';

let share;
const USERS = {};
const TOKENS = { admin: null };

/** 逐请求可切换的 TCP 源地址，见 presence.test.js 里同样的手法。 */
let remoteOverride = null;

/** 本条用例开出去的全部 SSE 连接，afterEach 统一收掉。 */
let conns = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const hit = await fn();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`超时：一直没等到「${label}」`);
    await sleep(10);
  }
}

beforeAll(async () => {
  savedHome = process.env.PHOTOCULL_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-close-home-'));
  process.env.PHOTOCULL_HOME = home;

  // 只放 RAW：不生成缩略图，用例跑得快，SSE 上也少一类干扰帧。
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-close-lib-')));
  for (const stem of ['A', 'B']) await fs.writeFile(path.join(tmp, `${stem}.CR3`), `raw-${stem}`);

  share = await createShare({ root: tmp, label: '婚礼精选', defaultRole: 'editor' });
  USERS.editor = await createUser(share.id, '新娘小林', 'editor');
  USERS.viewer = await createUser(share.id, '伴娘', 'viewer');
  for (const k of ['editor', 'viewer']) TOKENS[k] = USERS[k].token;

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
});

afterAll(async () => {
  await closeAllSessions();
  await new Promise((r) => server.close(r));
  if (savedHome === undefined) delete process.env.PHOTOCULL_HOME;
  else process.env.PHOTOCULL_HOME = savedHome;
  for (const dir of [home, tmp]) await fs.rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  remoteOverride = null;                  // 开库是管理员操作，走回环
  const res = await fetch(`${base}/api/library/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: tmp }),
  });
  sid = (await res.json()).sessionId;

  // 等元数据后台任务跑完，之后建立的连接不会再收到它自己产生的 meta/metaDone 帧。
  await waitUntil(async () => (await fetch(
    `${base}/api/library/meta?sid=${encodeURIComponent(sid)}`,
  ).then((r) => r.json())).done, '元数据读完');
});

afterEach(async () => {
  for (const conn of conns) conn.abort();
  conns = [];
  await closeAllSessions();
});

/** 管理员的 `POST /api/library/close`（走回环）。 */
async function close(body) {
  remoteOverride = null;
  const res = await fetch(`${base}/api/library/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-PhotoCull-Session': sid },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

/**
 * 开一条真实的 SSE 连接。`identity` 为 'admin' 时走回环（管理员），
 * 其余走 GUEST_IP + 该用户的 Cookie。
 */
async function connect(identity) {
  remoteOverride = identity === 'admin' ? null : GUEST_IP;
  const headers = {};
  if (TOKENS[identity]) headers.cookie = `pc_user=${TOKENS[identity]}`;

  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/library/stream?sid=${encodeURIComponent(sid)}`,
    { headers, signal: ctrl.signal });
  if (res.status !== 200) throw new Error(`${identity} 连不上流：${res.status} ${await res.text()}`);

  const conn = { identity, events: [], ended: false, abort: () => ctrl.abort() };
  const reader = res.body.getReader();
  conn.pump = (async () => {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          if (!frame.startsWith('data: ')) continue;   // ": ping" 心跳注释
          conn.events.push(JSON.parse(frame.slice('data: '.length)));
        }
      }
    } catch { /* 客户端主动 abort，或者连接被服务端断掉 */ }
    conn.ended = true;
  })();

  conns.push(conn);
  // 服务端在每条连接建立后都会广播一次名单，等到它就说明这条连接已经进了 listeners。
  await waitUntil(() => conn.events.some((e) => e.type === 'presence'), `${identity} 的首份在线名单`);
  return conn;
}

/** 同一个用户的第二个标签页：Cookie 相同，源地址相同。 */
const connectAgain = (identity) => connect(identity);

describe('POST /api/library/close：仍有访客在线时先拦一道（规格 §5.4）', () => {
  it('一位访客在线时返回 409 guests-online，并带上在线人数', async () => {
    await connect('editor');

    const res = await close();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('guests-online');
    expect(res.body.online).toBe(1);
  });

  it('文案里必须有"还有 N 位访客在线"和"链接仍然有效"', async () => {
    await connect('editor');

    const { body } = await close();
    // 规格 §5.4 逐字要求的两句话。摄影师要靠它分清"我只是本地脱离"
    // 和"我把客户踢下线了"——这两件事的区别正是这条修复的全部意义。
    expect(body.message).toContain('还有 1 位访客在线');
    expect(body.message).toContain('链接仍然有效');
    // 还要给出出路：撤销才是真正结束访问的那个动作。
    expect(body.message).toContain('撤销');
  });

  it('被拒绝之后会话必须还活着，访客那条流一条都不能断', async () => {
    const guest = await connect('editor');

    expect((await close()).status).toBe(409);

    // 修复前这里已经是 undefined 了：closeSession() 先跑完，再由响应告诉你结果。
    expect(getSession(sid)).not.toBe(null);
    await sleep(50);
    expect(guest.ended).toBe(false);
    expect(guest.events.some((e) => e.type === 'kicked' || e.type === 'share-ended')).toBe(false);
  });

  it('两位访客各自在线时人数是 2', async () => {
    await connect('editor');
    await connect('viewer');

    const { body } = await close();
    expect(body.online).toBe(2);
    expect(body.message).toContain('还有 2 位访客在线');
  });

  it('同一位访客开两个标签页只算一个人', async () => {
    await connect('editor');
    await connectAgain('editor');

    const { body } = await close();
    expect(body.online).toBe(1);
  });

  it('force: true 时照常关闭，访客也确实被断开', async () => {
    const guest = await connect('editor');

    const res = await close({ force: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(getSession(sid)).toBe(null);
    await waitUntil(() => guest.ended, '访客的流被服务端断掉');
  });

  // ── 反向对照 ────────────────────────────────────────────────────────────
  // 单机流程（一个访客都没有）必须一点都没变：换文件夹是摄影师每天要按几十次的
  // 按钮，给它加一道谁都躲不开的确认框，比这个 bug 本身更让人不能忍。
  it('反向对照：一个访客都没有时，close 直接成功', async () => {
    expect(await close()).toEqual({ status: 200, body: { ok: true } });
    expect(getSession(sid)).toBe(null);
  });

  it('反向对照：只有管理员自己连着时也直接成功（他不是"访客"）', async () => {
    await connect('admin');

    expect((await close()).status).toBe(200);
    expect(getSession(sid)).toBe(null);
  });

  it('反向对照：访客断开之后就不再拦', async () => {
    const guest = await connect('editor');
    expect((await close()).status).toBe(409);

    guest.abort();
    await waitUntil(() => (getSession(sid)?.listeners.size ?? 0) === 0, '访客从名单里被摘掉');

    expect((await close()).status).toBe(200);
  });

  it('访客自己发的 close 仍然是 403，不会因为这条新分支泄露在线人数', async () => {
    await connect('editor');

    remoteOverride = GUEST_IP;
    const res = await fetch(`${base}/api/library/close`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-PhotoCull-Session': sid,
        cookie: `pc_user=${TOKENS.editor}`,
      },
      body: JSON.stringify({ force: true }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('admin-only');
    expect(getSession(sid)).not.toBe(null);
  });
});
