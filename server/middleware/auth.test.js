import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  attachActor, requireAdmin, requirePerm, defaultDeny,
  sessionIdOf, rejectQuerySessionOnWrites,
} from './auth.js';
import { setAdminToken, USER_COOKIE } from '../lib/actor.js';
import { createShare } from '../lib/shares.js';
import { createUser } from '../lib/users.js';
import { openSession, closeAllSessions } from '../lib/session.js';

// 两个真实的库会话，指向两个不同的 root。"访客拿别条链接的 sessionId 读别的
// 文件夹"这条用例只有在会话是真的、root 是真的时候才算数——所以这里不 mock
// session.js，而是真的开两个空文件夹的会话。
let home;
let savedEnv;
let rootA;
let rootB;
let sidA;
let sidB;

beforeAll(async () => {
  rootA = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-auth-a-')));
  rootB = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-auth-b-')));
});

afterAll(async () => {
  await fs.rm(rootA, { recursive: true, force: true });
  await fs.rm(rootB, { recursive: true, force: true });
});

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-auth-home-'));
  savedEnv = process.env.PHOTOCULL_HOME;
  process.env.PHOTOCULL_HOME = home;
  sidA = (await openSession(rootA)).id;
  sidB = (await openSession(rootB)).id;
});

afterEach(async () => {
  await closeAllSessions();
  setAdminToken(null);
  if (savedEnv === undefined) delete process.env.PHOTOCULL_HOME;
  else process.env.PHOTOCULL_HOME = savedEnv;
  await fs.rm(home, { recursive: true, force: true });
});

function fakeReq({
  ip = '192.168.1.50',
  headers = {},
  cookie,
  method = 'GET',
  reqPath = '/api/library/marks',
  query = {},
  sid,
} = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  if (cookie !== undefined) h.cookie = cookie;
  if (sid !== undefined) h['x-photocull-session'] = sid;
  return { socket: { remoteAddress: ip }, headers: h, method, path: reqPath, baseUrl: '', query };
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

/** 跑一个中间件，返回它究竟是放行了还是自己把响应写掉了。 */
async function run(mw, req) {
  const res = fakeRes();
  let passed = false;
  await mw(req, res, () => { passed = true; });
  return { res, passed, status: res.statusCode, body: res.body };
}

/** 造一个已经解析好 actor 的请求：中间件的单元测试不该再依赖一次真实解析。 */
function withActor(actor, over = {}) {
  const req = fakeReq(over);
  req.actor = actor;
  return req;
}

// 每个访客都挂在自己新建的一条分享上，所以昵称不需要跨用例唯一。
async function guest(role, { root = rootA } = {}) {
  const share = await createShare({ root, defaultRole: role });
  const user = await createUser(share.id, '访客', role);
  return { kind: 'user', user, share };
}

const ADMIN = { kind: 'admin' };
const NONE = { kind: 'none' };

describe('attachActor', () => {
  it('把 actor 挂到 req 上并放行', async () => {
    const req = fakeReq({ ip: '127.0.0.1' });
    const { passed } = await run(attachActor, req);
    expect(passed).toBe(true);
    expect(req.actor.kind).toBe('admin');
  });

  it('解析不出身份也照样放行（拒绝是 defaultDeny 的事）', async () => {
    const req = fakeReq();
    const { passed, status } = await run(attachActor, req);
    expect(passed).toBe(true);
    expect(status).toBe(null);
    expect(req.actor.kind).toBe('none');
  });

  it('底层存储抛错时按无身份处理，而不是把异常抛给路由', async () => {
    // PHOTOCULL_HOME 指向一个"是文件不是目录"的路径：读用户表必然出错。
    const file = path.join(home, 'not-a-dir');
    await fs.writeFile(file, 'x');
    process.env.PHOTOCULL_HOME = file;
    const req = fakeReq({ cookie: `${USER_COOKIE}=${'a'.repeat(43)}` });
    const { passed } = await run(attachActor, req);
    expect(passed).toBe(true);
    expect(req.actor.kind).toBe('none');
  });
});

describe('requireAdmin', () => {
  it('admin 放行', async () => {
    expect((await run(requireAdmin, withActor(ADMIN))).passed).toBe(true);
  });

  it.each(['editor', 'viewer'])('%s 访客 403 admin-only', async (role) => {
    const { status, body, passed } = await run(requireAdmin, withActor(await guest(role)));
    expect(passed).toBe(false);
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'admin-only', message: '这个操作只能在本机进行' });
  });

  // 无身份的请求在真实接线里会先被 defaultDeny 拦成 401，走不到这里；
  // 万一有人把 requireAdmin 单独挂在白名单路由上，这里也必须是拒绝。
  it('无身份 403，绝不放行', async () => {
    expect((await run(requireAdmin, withActor(NONE))).passed).toBe(false);
  });

  it('actor 没被解析过（忘挂 attachActor）时也拒绝', async () => {
    expect((await run(requireAdmin, fakeReq())).passed).toBe(false);
  });
});

describe('requirePerm', () => {
  it.each(['read', 'write'])('admin 的 %s 请求放行', async (perm) => {
    const { passed } = await run(requirePerm(perm), withActor(ADMIN, { sid: sidA }));
    expect(passed).toBe(true);
  });

  it.each(['read', 'write'])('editor 的 %s 请求放行', async (perm) => {
    const actor = await guest('editor');
    const { passed } = await run(requirePerm(perm), withActor(actor, { sid: sidA }));
    expect(passed).toBe(true);
  });

  it('viewer 的读请求放行', async () => {
    const actor = await guest('viewer');
    const { passed } = await run(requirePerm('read'), withActor(actor, { sid: sidA }));
    expect(passed).toBe(true);
  });

  it('viewer 的写请求 403 read-only', async () => {
    const actor = await guest('viewer');
    const { passed, status, body } = await run(requirePerm('write'), withActor(actor, { sid: sidA }));
    expect(passed).toBe(false);
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'read-only', message: '你当前是只读权限' });
  });

  it('角色是意料之外的值时，写请求一律拒绝', async () => {
    const actor = await guest('editor');
    actor.user.role = 'superuser';
    const { passed, status } = await run(requirePerm('write'), withActor(actor, { sid: sidA }));
    expect(passed).toBe(false);
    expect(status).toBe(403);
  });

  it.each(['read', 'write'])('无身份的 %s 请求 401 no-actor', async (perm) => {
    const { passed, status, body } = await run(requirePerm(perm), withActor(NONE, { sid: sidA }));
    expect(passed).toBe(false);
    expect(status).toBe(401);
    expect(body).toEqual({ error: 'no-actor' });
  });

  it('actor 没被解析过时 401，不放行', async () => {
    const { passed, status } = await run(requirePerm('read'), fakeReq({ sid: sidA }));
    expect(passed).toBe(false);
    expect(status).toBe(401);
  });

  it('未知权限名在接线时就抛错，不留到请求时', () => {
    expect(() => requirePerm('delete')).toThrow();
    expect(() => requirePerm()).toThrow();
  });
});

describe('requirePerm：访客只能访问自己那条分享指向的会话', () => {
  it('访客不能用别条链接的 sessionId 读别的文件夹', async () => {
    const actor = await guest('editor', { root: rootA });
    const { passed, status, body } = await run(requirePerm('read'), withActor(actor, { sid: sidB }));
    expect(passed).toBe(false);
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'wrong-library', message: '这条链接不对应当前打开的文件夹' });
  });

  it('写请求同样被 wrong-library 拦下', async () => {
    const actor = await guest('editor', { root: rootA });
    const { status, body } = await run(requirePerm('write'), withActor(actor, { sid: sidB }));
    expect(status).toBe(403);
    expect(body.error).toBe('wrong-library');
  });

  // 写请求收窄到只认请求头之后，越库校验必须仍然对**那条通道**成立——
  // 不然收紧 CSRF 的同时把越库这道闸门一起关掉了。
  it('真正的 PUT + 请求头带别条链接的 sessionId，照样 wrong-library', async () => {
    const actor = await guest('editor', { root: rootA });
    const req = withActor(actor, { method: 'PUT', sid: sidB });
    const { status, body } = await run(requirePerm('write'), req);
    expect(status).toBe(403);
    expect(body.error).toBe('wrong-library');
  });

  it('?sid= 查询参数这条通道同样要校验（<img src> 设不了请求头）', async () => {
    const actor = await guest('editor', { root: rootA });
    const req = withActor(actor, { query: { sid: sidB } });
    const { status, body } = await run(requirePerm('read'), req);
    expect(status).toBe(403);
    expect(body.error).toBe('wrong-library');
  });

  it('requireSession 已经解析好的 req.session 同样要校验', async () => {
    const actor = await guest('editor', { root: rootA });
    const req = withActor(actor);
    req.session = { id: sidB, root: rootB };
    const { status, body } = await run(requirePerm('read'), req);
    expect(status).toBe(403);
    expect(body.error).toBe('wrong-library');
  });

  it('分享指向的正是这个会话时放行', async () => {
    const actor = await guest('editor', { root: rootA });
    expect((await run(requirePerm('read'), withActor(actor, { sid: sidA }))).passed).toBe(true);
  });

  it('admin 不受这条约束（本机用户可以在任意会话之间切换）', async () => {
    expect((await run(requirePerm('read'), withActor(ADMIN, { sid: sidB }))).passed).toBe(true);
  });

  it('share 记录缺 root 时按不匹配处理', async () => {
    const actor = await guest('editor', { root: rootA });
    delete actor.share.root;
    const { status, body } = await run(requirePerm('read'), withActor(actor, { sid: sidA }));
    expect(status).toBe(403);
    expect(body.error).toBe('wrong-library');
  });
});

/**
 * CSRF 的第二道防线（第一道是 Cookie 的 `SameSite=Lax`）。
 *
 * 规格 §9.1、计划 Global Constraints、adminlogin.js 的 Cookie 注释，三处都写着
 * "所有写请求必须带自定义头 `X-PhotoCull-Session`"。在补上这一段之前，代码里
 * 两条通道是平权的（`请求头 || ?sid=`），也就是说那道防线**根本不存在**：
 * 一张挂在任意网站上的
 *   `<form method=POST action="http://127.0.0.1:5183/api/library/marks?sid=…">`
 * 只带 Cookie、不带任何自定义头，实测 200。
 *
 * 收紧的边界很窄，故意的：`?sid=` 存在的唯一理由是 `<img src>` 和 `EventSource`
 * 设不了请求头，而那两者发出来的都是 GET。所以只对写请求关掉这条通道，
 * 不会关掉任何一条真实存在的用法。
 */
describe('sessionIdOf：写请求只认请求头', () => {
  it('GET：请求头和 ?sid= 都认', () => {
    expect(sessionIdOf(fakeReq({ method: 'GET', sid: 'from-header' }))).toBe('from-header');
    expect(sessionIdOf(fakeReq({ method: 'GET', query: { sid: 'from-query' } }))).toBe('from-query');
  });

  // Express 拿 GET 的处理函数应答 HEAD，把它排除掉等于让一类请求换一条判定路径。
  it('HEAD 同样认 ?sid=', () => {
    expect(sessionIdOf(fakeReq({ method: 'HEAD', query: { sid: 'from-query' } }))).toBe('from-query');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s 不认 ?sid=', (method) => {
    expect(sessionIdOf(fakeReq({ method, query: { sid: 'from-query' } }))).toBe('');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s 认请求头', (method) => {
    expect(sessionIdOf(fakeReq({ method, sid: 'from-header' }))).toBe('from-header');
  });

  it('请求头优先于 ?sid=，两个都带时以请求头为准', () => {
    const req = fakeReq({ method: 'GET', sid: 'from-header', query: { sid: 'from-query' } });
    expect(sessionIdOf(req)).toBe('from-header');
  });

  it('方法认不出来时不认 ?sid=（不确定的一律拒绝）', () => {
    const req = fakeReq({ query: { sid: 'from-query' } });
    delete req.method;
    expect(sessionIdOf(req)).toBe('');
  });

  it('小写方法名同样按写请求处理', () => {
    expect(sessionIdOf(fakeReq({ method: 'put', query: { sid: 'from-query' } }))).toBe('');
    expect(sessionIdOf(fakeReq({ method: 'get', query: { sid: 'from-query' } }))).toBe('from-query');
  });
});

describe('rejectQuerySessionOnWrites', () => {
  it('GET 带 ?sid= 放行（<img src> / EventSource 就这一条路）', async () => {
    const req = fakeReq({ method: 'GET', query: { sid: 'x' } });
    expect((await run(rejectQuerySessionOnWrites, req)).passed).toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    '%s 只带 ?sid= 没带请求头 -> 403 csrf-header-required',
    async (method) => {
      const { passed, status, body } = await run(
        rejectQuerySessionOnWrites, fakeReq({ method, query: { sid: 'x' } }),
      );
      expect(passed).toBe(false);
      expect(status).toBe(403);
      // 不能是 409 session-gone：会话好好活着，那句话是假的，
      // 而且前端会据此把人退回文件夹选择器——一条安全规则伪装成会话问题。
      expect(body.error).toBe('csrf-header-required');
    },
  );

  it('写请求带了请求头就放行（`?sid=` 一起带着也不影响）', async () => {
    const req = fakeReq({ method: 'PUT', sid: 'from-header', query: { sid: 'x' } });
    expect((await run(rejectQuerySessionOnWrites, req)).passed).toBe(true);
  });

  it('写请求两条都没带时放行——那是路由自己的会话闸门要回答的问题', async () => {
    // /api/share/:token/join、/api/export/:jobId/cancel 这类路由本来就不需要会话。
    expect((await run(rejectQuerySessionOnWrites, fakeReq({ method: 'POST' }))).passed).toBe(true);
  });

  it('空的 ?sid= 不算带了', async () => {
    const req = fakeReq({ method: 'POST', query: { sid: '' } });
    expect((await run(rejectQuerySessionOnWrites, req)).passed).toBe(true);
  });
});

describe('defaultDeny', () => {
  it('无身份访问受保护接口 -> 401 no-actor', async () => {
    const { passed, status, body } = await run(defaultDeny, withActor(NONE));
    expect(passed).toBe(false);
    expect(status).toBe(401);
    expect(body).toEqual({ error: 'no-actor' });
  });

  it.each([
    ['/'],
    ['/index.html'],
    ['/assets/index-abc.js'],
    ['/s/some-token'],
  ])('静态资源与 SPA 路径 %s 不需要身份', async (reqPath) => {
    expect((await run(defaultDeny, withActor(NONE, { reqPath }))).passed).toBe(true);
  });

  it.each([
    ['GET', '/api/share/sometoken/info'],
    ['POST', '/api/share/sometoken/join'],
    ['POST', '/api/share/sometoken/resume'],
  ])('白名单 %s %s 放行', async (method, reqPath) => {
    expect((await run(defaultDeny, withActor(NONE, { method, reqPath }))).passed).toBe(true);
  });

  it.each([
    ['POST', '/api/share/sometoken/info'],
    ['GET', '/api/share/sometoken/join'],
    ['DELETE', '/api/share/sometoken/join'],
  ])('方法不对的 %s %s 不在白名单里', async (method, reqPath) => {
    expect((await run(defaultDeny, withActor(NONE, { method, reqPath }))).status).toBe(401);
  });

  it.each([
    ['/api/share/tok/info/../../library/marks'],
    ['/api/share/tok/join/extra'],
    ['/api/sharex/tok/info'],
    ['/api/admin/shares'],
  ])('长得像白名单的 %s 不放行', async (reqPath) => {
    expect((await run(defaultDeny, withActor(NONE, { reqPath }))).status).toBe(401);
  });

  /**
   * resume 是白名单的第四项（Task 8 补上的，规格 6.2 那句只列了前三项）。
   *
   * 这条用例守的是一个很容易被"收紧一下更安全"的直觉改回去的决定：
   * 令牌**有效**的回访者本来就被 resolveActor 解析成 user，压根走不到
   * defaultDeny 的拒绝分支；白名单只对令牌**失效**的回访者起作用。而那正是
   * 必须放进处理函数的情形——只有处理函数才会回 401 need-join 并清掉那枚
   * 死 Cookie。挡在这里的话浏览器会一直带着死 Cookie 撞 401 no-actor，
   * 用户卡在一个没有出口的循环里。
   */
  it('resume 在白名单里：无身份也要能走到处理函数，才有人清得掉那枚死 Cookie', async () => {
    const { passed, status } = await run(
      defaultDeny, withActor(NONE, { method: 'POST', reqPath: '/api/share/tok/resume' }),
    );
    expect(passed).toBe(true);
    expect(status).toBe(null);
  });

  it.each([
    ['GET', '/api/share/tok/resume'],
    ['POST', '/api/share/tok/resume/extra'],
  ])('但白名单只放行精确的 POST resume：%s %s 仍然 401', async (method, reqPath) => {
    expect((await run(defaultDeny, withActor(NONE, { method, reqPath }))).status).toBe(401);
  });

  /**
   * `/admin-login` 必须无身份可达，否则它救不了任何人：
   * 走这条路的人正是**还没有管理员身份**的那个浏览器。
   *
   * 老实说一句：这条路径今天靠的是上面那条"非 /api 一律放行"就已经过得去了，
   * 白名单那一项目前是冗余的。它写在那里是为了在"非 /api 一律放行"哪天被收紧时，
   * 这条入口不会跟着一起被关掉——一个进不去的登录入口不会有任何测试变红，
   * 只会表现成摄影师突然打不开自己的界面。
   */
  it('GET /admin-login 无身份可达——走这条路的人本来就还没有身份', async () => {
    const { passed, status } = await run(
      defaultDeny, withActor(NONE, { reqPath: '/admin-login' }),
    );
    expect(passed).toBe(true);
    expect(status).toBe(null);
  });

  it.each([['admin'], ['user']])('已经有 %s 身份的请求放行', async (kind) => {
    const actor = kind === 'admin' ? ADMIN : await guest('viewer');
    expect((await run(defaultDeny, withActor(actor))).passed).toBe(true);
  });

  it('忘挂 attachActor 时按无身份拒绝，不是默认放行', async () => {
    expect((await run(defaultDeny, fakeReq())).status).toBe(401);
  });

  /**
   * 大小写。Express 默认 `case sensitive routing = false`，`/API/share/leave`
   * 和 `/api/share/leave` 落到**同一个处理函数**；这里以前是逐字节的
   * `startsWith('/api/')`，于是大写路径整个绕开了这道默认拒绝——
   * 实测匿名非回环的 `POST /API/share/leave` 拿到 200。
   */
  it.each([
    ['/API/admin/shares'],
    ['/Api/library/marks'],
    ['/aPi/share/leave'],
    ['/API/EXPORT'],
  ])('大写路径 %s 同样被默认拒绝拦下', async (reqPath) => {
    expect((await run(defaultDeny, withActor(NONE, { reqPath }))).status).toBe(401);
  });

  it('白名单也按小写匹配，大写路径拿到和小写路径一样的答案', async () => {
    for (const reqPath of ['/api/share/tok/join', '/API/share/TOK/join']) {
      const { passed } = await run(defaultDeny, withActor(NONE, { method: 'POST', reqPath }));
      expect(passed, reqPath).toBe(true);
    }
  });

  it('非 /api 的大写路径照旧放行（静态资源本来就不需要身份）', async () => {
    expect((await run(defaultDeny, withActor(NONE, { reqPath: '/Assets/Index-ABC.js' }))).passed)
      .toBe(true);
  });
});
