import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.js';
import { closeAllSessions, getSession } from './session.js';
import { createShare } from './shares.js';
import { createUser } from './users.js';
import { kickUser, endShare, notifyRoleChanged } from './presence.js';

/**
 * 在线状态 = SSE 连接本身。
 *
 * 所以这一组用例全部走**真实的 HTTP + 真实的 SSE 连接**，不用假 listener：
 * 「被服务端主动断开」这条要求只有在真连接上才有意义——只发事件不断开，
 * 客户端完全可以忽略事件继续用，那不叫踢人。假 listener 的 end() 是个空函数，
 * 它永远不会告诉你连接其实还开着。
 */

/** 访客请求的伪造源地址。必须不是回环，否则 resolveActor 直接判成管理员。 */
const GUEST_IP = '192.168.1.50';

let server;
let base;
let home;        // PHOTOCULL_HOME：分享/用户存储，绝不能碰开发者真实的 ~/.photocull
let tmp;         // 被分享的照片文件夹（会话 root）
let savedHome;
let sid = '';    // 当前会话 id

let shareA;
let shareB;      // 指向同一个文件夹的**另一条**分享，用来验证撤销只影响自己那条
const USERS = {};        // identity -> 用户记录
const TOKENS = { admin: null };

/** 逐请求可切换的 TCP 源地址，见 permissions.test.js 里同样的手法。 */
let remoteOverride = null;

/** 本条用例开出去的全部连接，afterEach 统一收掉。 */
let conns = [];

beforeAll(async () => {
  savedHome = process.env.PHOTOCULL_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-presence-home-'));
  process.env.PHOTOCULL_HOME = home;

  // 只放 RAW：不生成缩略图，用例跑得快，SSE 上也少一类干扰帧。
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-presence-lib-')));
  for (const stem of ['A', 'B']) await fs.writeFile(path.join(tmp, `${stem}.CR3`), `raw-${stem}`);

  shareA = await createShare({ root: tmp, label: '婚礼精选', defaultRole: 'editor' });
  shareB = await createShare({ root: tmp, label: '同一个文件夹的另一条链接', defaultRole: 'editor' });
  USERS.editor = await createUser(shareA.id, '新娘小林', 'editor');
  USERS.viewer = await createUser(shareA.id, '伴娘', 'viewer');
  USERS.outsider = await createUser(shareB.id, '婚庆策划', 'editor');
  for (const k of ['editor', 'viewer', 'outsider']) TOKENS[k] = USERS[k].token;

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

  remoteOverride = null;   // 开库是管理员操作
  const res = await fetch(`${base}/api/library/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: tmp }),
  });
  sid = (await res.json()).sessionId;

  // 等元数据后台任务跑完，之后建立的连接不会再收到它自己产生的 meta/metaDone 帧。
  for (let i = 0; i < 100; i++) {
    const meta = await fetch(`${base}/api/library/meta?sid=${encodeURIComponent(sid)}`).then((r) => r.json());
    if (meta.done) break;
    await sleep(20);
  }
});

afterAll(async () => {
  await closeAllSessions();
  await new Promise((r) => server.close(r));
  if (savedHome === undefined) delete process.env.PHOTOCULL_HOME;
  else process.env.PHOTOCULL_HOME = savedHome;
  for (const dir of [home, tmp]) await fs.rm(dir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const conn of conns) conn.abort();
  conns = [];
  // 等服务端真的把这些连接从名单里摘掉，否则上一条用例的残留连接会污染下一条的名单。
  await waitUntil(() => (getSession(sid)?.listeners.size ?? 0) === 0, '残留连接被清空');
});

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

/**
 * 开一条真实的 SSE 连接，后台持续解析帧。
 * `identity` 为 'admin' 时走回环（管理员），其余走 GUEST_IP + 该用户的 Cookie。
 */
async function connect(identity) {
  remoteOverride = identity === 'admin' ? null : GUEST_IP;
  const headers = {};
  if (TOKENS[identity]) headers.cookie = `pc_user=${TOKENS[identity]}`;

  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/library/stream?sid=${encodeURIComponent(sid)}`,
    { headers, signal: ctrl.signal });
  if (res.status !== 200) throw new Error(`${identity} 连不上流：${res.status} ${await res.text()}`);

  const conn = { identity, events: [], raw: [], ended: false, abort: () => ctrl.abort() };
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
          conn.raw.push(frame);
          conn.events.push(JSON.parse(frame.slice('data: '.length)));
        }
      }
    } catch { /* 客户端主动 abort，或者连接被服务端断掉 */ }
    conn.ended = true;
  })();

  conns.push(conn);
  // 每条连接建立后服务端都会广播一次名单，等到它再返回，用例里就不必再等一次。
  await waitUntil(() => lastPresence(conn), `${identity} 的首份在线名单`);
  return conn;
}

const lastPresence = (conn) => [...conn.events].reverse().find((e) => e.type === 'presence') ?? null;
const idsOf = (conn) => (lastPresence(conn)?.users ?? []).map((u) => u.id);
const eventsOfType = (conn, type) => conn.events.filter((e) => e.type === type);

describe('在线状态由 SSE 连接直接派生', () => {
  it('连接建立即上线，断开即下线', async () => {
    const admin = await connect('admin');
    expect(idsOf(admin)).toEqual(['admin']);

    const editor = await connect('editor');
    await waitUntil(() => idsOf(admin).includes(USERS.editor.id), '管理员看到访客上线');
    expect(lastPresence(admin).users).toContainEqual({
      id: USERS.editor.id, nickname: '新娘小林', role: 'editor',
    });

    editor.abort();
    await waitUntil(() => !idsOf(admin).includes(USERS.editor.id), '管理员看到访客下线');
  });

  it('同一用户两个标签页在名单里只出现一次', async () => {
    const admin = await connect('admin');
    await connect('editor');
    await connect('editor');   // 第二个标签页，同一个用户令牌

    await waitUntil(() => idsOf(admin).includes(USERS.editor.id), '访客上线');
    const mine = lastPresence(admin).users.filter((u) => u.id === USERS.editor.id);
    // 不去重的话，一个人开三个标签页就会在成员条上显示成三个人。
    expect(mine).toHaveLength(1);
    expect(idsOf(admin).sort()).toEqual(['admin', USERS.editor.id].sort());
  });

  it('presence 名单里不含令牌，也不含摄影师磁盘上的绝对路径', async () => {
    // SSE 对 viewer 也是开放的（Task 7），名单里泄露的任何东西都等于直接发给了访客。
    const viewer = await connect('viewer');
    await connect('editor');
    await waitUntil(() => idsOf(viewer).includes(USERS.editor.id), '两个访客都在名单里');

    const text = viewer.raw.filter((f) => f.includes('"presence"')).join('\n');
    expect(text).not.toBe('');
    for (const token of Object.values(TOKENS)) {
      if (token) expect(text).not.toContain(token);
    }
    expect(text).not.toContain(shareA.token);
    expect(text).not.toContain(shareB.token);
    expect(text).not.toContain(tmp);
    // 名单条目只有 id / nickname / role 三个字段，多一个都是泄露面。
    for (const user of lastPresence(viewer).users) {
      expect(Object.keys(user).sort()).toEqual(['id', 'nickname', 'role']);
    }
  });
});

describe('生命周期事件', () => {
  it('管理员改角色后，该用户的连接立即收到 role 事件', async () => {
    const admin = await connect('admin');
    const editor = await connect('editor');
    await waitUntil(() => idsOf(admin).includes(USERS.editor.id), '访客上线');

    notifyRoleChanged(USERS.editor.id, 'viewer');

    const evt = await waitUntil(() => eventsOfType(editor, 'role')[0], '访客收到 role 事件');
    expect(evt).toEqual({ type: 'role', userId: USERS.editor.id, role: 'viewer' });
    // 名单上的角色也要跟着变，否则成员条会一直显示旧权限。
    await waitUntil(
      () => lastPresence(admin).users.find((u) => u.id === USERS.editor.id)?.role === 'viewer',
      '名单上的角色跟着变',
    );
    expect(editor.ended).toBe(false);   // 改权限不是踢人，连接必须留着
  });

  it('禁用用户后，其连接收到 kicked 并被服务端主动断开', async () => {
    const admin = await connect('admin');
    const editor = await connect('editor');
    const viewer = await connect('viewer');
    await waitUntil(() => idsOf(admin).includes(USERS.editor.id), '访客上线');

    kickUser(USERS.editor.id, 'disabled');

    const evt = await waitUntil(() => eventsOfType(editor, 'kicked')[0], '被踢的用户收到 kicked');
    expect(evt).toEqual({ type: 'kicked', reason: 'disabled' });
    // 断开是必须的：只发事件不断开，客户端可以忽略事件继续用。
    await waitUntil(() => editor.ended, '被踢的连接真的被服务端断开');
    await waitUntil(() => !idsOf(admin).includes(USERS.editor.id), '被踢的用户从名单上消失');

    // 只踢这一个人。
    expect(viewer.ended).toBe(false);
    expect(eventsOfType(viewer, 'kicked')).toEqual([]);
    expect(admin.ended).toBe(false);
  });

  it('同一个用户的多个标签页会被一起踢掉', async () => {
    const tabA = await connect('editor');
    const tabB = await connect('editor');

    kickUser(USERS.editor.id, 'disabled');

    await waitUntil(() => tabA.ended && tabB.ended, '两个标签页都被断开');
    expect(eventsOfType(tabA, 'kicked')).toHaveLength(1);
    expect(eventsOfType(tabB, 'kicked')).toHaveLength(1);
  });

  it('撤销分享后，该分享的全部访客收到 share-ended 并被断开，管理员连接不受影响', async () => {
    const admin = await connect('admin');
    const editor = await connect('editor');     // shareA
    const viewer = await connect('viewer');     // shareA
    const outsider = await connect('outsider'); // shareB：同一个文件夹，另一条链接
    await waitUntil(() => idsOf(admin).includes(USERS.outsider.id), '四条连接都在线');

    endShare(shareA.id, 'revoked');

    for (const conn of [editor, viewer]) {
      const evt = await waitUntil(() => eventsOfType(conn, 'share-ended')[0], `${conn.identity} 收到 share-ended`);
      expect(evt).toEqual({ type: 'share-ended', reason: 'revoked' });
      await waitUntil(() => conn.ended, `${conn.identity} 的连接被断开`);
    }

    // 管理员是摄影师自己，撤销一条链接不该把他自己的界面也打断——
    // 他撤销分享正是为了继续在本机干活。
    expect(admin.ended).toBe(false);
    expect(eventsOfType(admin, 'share-ended')).toEqual([]);
    // 另一条分享的访客同样不受影响：撤销的是链接，不是这个文件夹。
    expect(outsider.ended).toBe(false);
    expect(eventsOfType(outsider, 'share-ended')).toEqual([]);

    await waitUntil(
      () => idsOf(admin).sort().join() === ['admin', USERS.outsider.id].sort().join(),
      '被撤销那条分享的人全部从名单上消失',
    );
  });

  it('share-ended / kicked 之后，名单上不再有他们', async () => {
    const admin = await connect('admin');
    await connect('editor');
    await connect('viewer');
    await waitUntil(() => idsOf(admin).length === 3, '三个人都在线');

    kickUser(USERS.editor.id, 'disabled');
    endShare(shareA.id, 'expired');

    await waitUntil(() => idsOf(admin).join() === 'admin', '只剩管理员自己');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 名单按分享隔离
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 摄影师给同一个文件夹建两条链接是这个功能被设计出来的用法：一条给新人，
 * 一条给父母。在补上过滤之前，父母那条链接的访客能在 presence 事件里读到
 * 新人那条链接的访客的昵称和 userId——两拨人彼此没有任何关系，摄影师也从来
 * 没有把他们介绍给对方。
 *
 * routes/marks.js 的 auditTargets 特意**拒绝**做同一件事，注释原文称之为
 * "一次跨分享的信息泄露"。这一组把两处的口径对齐。
 *
 * 夹具里 shareA = {新娘小林(editor), 伴娘(viewer)}，shareB = {婚庆策划}，
 * 两条分享指向同一个文件夹、同一个会话。
 */
describe('presence 按 shareId 隔离', () => {
  it('另一条链接的访客不出现在我的名单里（两个方向都测）', async () => {
    const editor = await connect('editor');      // shareA
    const outsider = await connect('outsider');  // shareB

    // 两条连接都已建立（outsider 上线时 editor 也会收到一帧，内容里不含他）。
    await waitUntil(() => (getSession(sid)?.listeners.size ?? 0) === 2, '两条连接都在');
    await waitUntil(() => lastPresence(outsider), 'shareB 拿到自己的首份名单');

    expect(idsOf(editor)).toEqual([USERS.editor.id]);
    expect(idsOf(outsider)).toEqual([USERS.outsider.id]);
  });

  it('同一条链接进来的两个人互相看得见', async () => {
    const editor = await connect('editor');   // shareA
    const viewer = await connect('viewer');   // shareA
    await waitUntil(() => idsOf(editor).includes(USERS.viewer.id), '同条分享的两个人互见');
    expect(idsOf(viewer).sort()).toEqual([USERS.editor.id, USERS.viewer.id].sort());
  });

  it('访客看得见摄影师——他不属于任何一条分享，隔离对他无从谈起', async () => {
    await connect('admin');
    const outsider = await connect('outsider');
    await waitUntil(() => idsOf(outsider).includes('admin'), '访客看到摄影师在线');
    expect(idsOf(outsider).sort()).toEqual(['admin', USERS.outsider.id].sort());
  });

  it('管理员全见：两条分享的人都在他的名单里', async () => {
    const admin = await connect('admin');
    await connect('editor');     // shareA
    await connect('outsider');   // shareB
    await waitUntil(() => idsOf(admin).length === 3, '摄影师看到全部三个人');
    expect(idsOf(admin).sort())
      .toEqual(['admin', USERS.editor.id, USERS.outsider.id].sort());
  });

  /**
   * 隔离的是**每一帧**，不只是首帧。上线/下线/改角色都会重新广播，
   * 只过滤首帧的实现会在第二个人进来的那一刻把名单整个漏出去。
   */
  it('别条链接的人上线之后，我收到的每一帧里都没有他', async () => {
    const editor = await connect('editor');
    await connect('outsider');
    await connect('outsider');   // 第二个标签页，再触发一次广播
    await waitUntil(() => (getSession(sid)?.listeners.size ?? 0) === 3, '三条连接都在');

    const frames = editor.events.filter((e) => e.type === 'presence');
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.users.map((u) => u.id)).not.toContain(USERS.outsider.id);
    }
    // 昵称同样不能出现在这条流的任何一个字节里。
    expect(editor.raw.join('\n')).not.toContain('婚庆策划');
  });

  /**
   * 标记广播**保持全局**，这是与上面相反的、同样刻意的决定。
   *
   * 标记是单一共享集合（规格 §4.1）：所有人编辑同一份 marks.json。收到别人的
   * 改动是功能本身，不是泄露——不发的话两条链接的人会看到两份互相矛盾的结果，
   * 而这个功能存在的全部理由就是"一起做出一份结果"。
   *
   * 代价如实记下：广播体里的 `origin` 是发起者的 userId，收到的人可能根本
   * 不在自己的名单上。前端已有"已离开的成员"那条兜底，会显示成一个叫不出
   * 名字的色块。
   */
  it('marks 广播不按分享过滤——单一共享标记集，收到别人的改动是功能', async () => {
    const outsider = await connect('outsider');   // shareB
    remoteOverride = GUEST_IP;
    const res = await fetch(`${base}/api/library/marks`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: `pc_user=${TOKENS.editor}`,       // shareA 的人在标记
        'X-PhotoCull-Session': sid,
      },
      body: JSON.stringify({ marks: { A: 'pick' } }),
    });
    expect(res.status).toBe(200);

    const evt = await waitUntil(() => eventsOfType(outsider, 'marks')[0], '另一条分享也收到标记');
    expect(evt.changes.A.mark).toBe('pick');
    expect(evt.origin).toBe(USERS.editor.id);

    // 收拾干净，别影响后面的用例。
    await fetch(`${base}/api/library/marks`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: `pc_user=${TOKENS.editor}`,
        'X-PhotoCull-Session': sid,
      },
      body: JSON.stringify({ marks: { A: null } }),
    });
  });
});
