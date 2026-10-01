import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp, API_MOUNTS } from '../index.js';
import { closeAllSessions } from '../lib/session.js';
import { createShare } from '../lib/shares.js';
import { createUser } from '../lib/users.js';
import { _test as exportTest } from './export.js';

/**
 * 权限矩阵：四种身份 x 每一个 /api 端点，全枚举。
 *
 * 这张表是本项目安全边界**唯一可执行的表达**。程序能读本机任意路径、能在 move 模式下
 * 删除不可再生的 RAW；分享功能又拿掉了"只监听 127.0.0.1"这条原始边界，
 * 剩下能兜住的就只有这张表。所以它必须是全枚举，而不是抽查。
 *
 * 文件末尾那条"每一个 /api 路由都出现在矩阵里"是整张表里最有价值的一条：
 * 它把"别忘了给新端点配权限"从人的纪律变成了机器的检查。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

/** 访客请求的伪造源地址。必须不是回环，否则 resolveActor 直接判成管理员。 */
const GUEST_IP = '192.168.1.50';

let server;
let base;
let home;      // PHOTOCULL_HOME：分享/用户存储，绝不能碰开发者真实的 ~/.photocull
let tmp;       // 被分享的照片文件夹（会话 root）
let out;       // 导出目标，同时兼作"另一条分享指向的别的文件夹"
let savedHome;
let jobId;     // 一个已经结束的导出任务，供 /api/export/:jobId/* 两条路由使用
let sid = '';  // 当前会话 id
let shareToken;  // tmp 那条分享的令牌，/api/share/:token/* 三行要用它拼 URL

/**
 * `/api/admin/*` 那九行的靶子。
 *
 * 全部是**一次性**的：管理员那一格会真的改标签、真的撤销、真的删人。拿矩阵
 * 自己赖以工作的那条分享（shareToken）或那两个用户（editor/viewer）当靶子的话，
 * 撤销之后 resolveActor 就再也解析不出访客身份，后面每一行的访客列都会从
 * 403 塌成 401——一整片假绿，而且看起来像是权限收得更紧了。
 * 每种破坏性操作各给一个靶子，`it.each` 里 admin 恒排第一，只会被打一次。
 */
let adminShareId;      // 只被读和改标签
let revokableShareId;  // 专供 DELETE /shares/:id 撤销
let adminUserId;       // 专供 PATCH  .../users/:uid 改角色
let deletableUserId;   // 专供 DELETE .../users/:uid 删除

/** 每种身份对应的用户令牌（管理员和无身份都不带 Cookie）。 */
const TOKENS = { admin: null, editor: null, viewer: null, none: null };

/**
 * 逐请求可切换的 TCP 源地址。
 *
 * `isLoopback()` 读的是 `req.socket.remoteAddress`，而测试服务器只能绑在
 * 127.0.0.1 上——不做点什么的话每一个请求都会被判成管理员，访客那三列根本无从测起。
 * 这里在把请求交给 Express 之前，用一个自有属性盖住 Socket.prototype 上的那个 getter：
 * 请求本身仍然是一次完整的、走真实 TCP 的 HTTP 请求，只有"从哪来"这一个字段被换掉，
 * 而那正是被测判定式唯一读的东西。
 *
 * keep-alive 会复用同一个 socket，所以每次先 delete 掉上一轮留下的自有属性，
 * 再按本轮身份决定要不要盖——否则一个访客请求会把后续的管理员请求也污染成访客。
 */
let remoteOverride = null;

beforeAll(async () => {
  savedHome = process.env.PHOTOCULL_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-perm-home-'));
  process.env.PHOTOCULL_HOME = home;

  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'perm-src-')));
  out = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'perm-out-')));
  await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 8, g: 60, b: 120 } } })
    .jpeg().toFile(path.join(tmp, 'A.JPG'));
  await fs.writeFile(path.join(tmp, 'A.CR3'), 'fake raw');

  const share = await createShare({ root: tmp, label: '权限矩阵', defaultRole: 'editor' });
  shareToken = share.token;
  TOKENS.editor = (await createUser(share.id, '编辑', 'editor')).token;
  TOKENS.viewer = (await createUser(share.id, '只读', 'viewer')).token;

  // 另一条分享，指向**别的**文件夹。用来验证 wrong-library 这条边界在真实接线里
  // 也确实生效（Task 6 只在中间件层面单测过它）。
  const other = await createShare({ root: out, label: '别的文件夹' });
  TOKENS.stranger = (await createUser(other.id, '外人', 'editor')).token;

  // /api/admin/* 的一次性靶子，见上面的声明处。
  adminShareId = (await createShare({ root: tmp, label: '管理矩阵' })).id;
  revokableShareId = (await createShare({ root: tmp, label: '等着被撤销' })).id;
  adminUserId = (await createUser(adminShareId, '被改角色的', 'editor')).id;
  deletableUserId = (await createUser(adminShareId, '被删掉的', 'viewer')).id;

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

  // /api/export/:jobId/{stream,cancel} 需要一个真实存在的任务 id，否则管理员那一列
  // 会因为 404 而不是因为权限失败。直接用 export.js 的测试钩子造一个已完成的任务：
  // 它和真实导出走的是同一个注册表、同一套 createJob/finishJob。
  const job = exportTest.createJob('copy');
  exportTest.finishJob(job, { type: 'done', summary: { exported: 0 } });
  jobId = job.id;

  await ensureLibrary();
});

afterAll(async () => {
  await closeAllSessions();
  await new Promise((r) => server.close(r));
  if (savedHome === undefined) delete process.env.PHOTOCULL_HOME;
  else process.env.PHOTOCULL_HOME = savedHome;
  for (const dir of [home, tmp, out]) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/**
 * 确保 tmp 这个库是开着的，并刷新 sid。
 *
 * 矩阵里有 `POST /api/library/close` 这一行，管理员那一格会真的把会话关掉；
 * 后面的行需要一个活着的会话，所以每一次请求之前都重开一遍（同一个 root 会被复用，
 * 不重扫，代价接近零）。
 */
async function ensureLibrary() {
  remoteOverride = null;   // 开库是管理员操作
  const res = await fetch(`${base}/api/library/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: tmp }),
  });
  const data = await res.json();
  sid = data.sessionId ?? '';
  return data;
}

/**
 * 以指定身份发一次请求。
 *
 * 每种身份都带上有效的会话 id：这样"无身份 -> 401"证明的是身份不足，
 * 而不是"没带会话"这种无关的原因。
 */
async function requestAs(endpoint, identity, ctrl) {
  remoteOverride = identity === 'admin' ? null : GUEST_IP;

  const headers = { 'content-type': 'application/json' };
  if (sid) headers['X-PhotoCull-Session'] = sid;
  const token = TOKENS[identity];
  if (token) headers.cookie = `pc_user=${token}`;

  const url = base + (endpoint.url ? endpoint.url() : endpoint.path);
  const init = { method: endpoint.method, headers, signal: ctrl.signal };
  if (endpoint.method !== 'GET') init.body = JSON.stringify(endpoint.body ? endpoint.body() : {});
  return fetch(url, init);
}

// ─────────────────────────────────────────────────────────────────────────────
// 矩阵本体
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 每一行：`path` 是**注册时的路径模式**（末尾那条自检用例拿它跟 Express 里实际注册的
 * 路径求差集），`url()` 是实际发出去的 URL。`deny` 是这一行出现 403 时应有的错误码——
 * 只断言状态码是不够的：一条本该 admin-only 的路由退化成 read-only 也是 403，
 * 但那意味着 editor 已经能进去了。
 *
 * `unauth` 是这一行出现 401 时应有的错误码，缺省是 `no-actor`（来自全局早挂的
 * defaultDeny）。`/api/share/:token/resume` 是唯一的例外：它在白名单里，无身份
 * 的请求会一路走进处理函数，拿到的 401 是 `need-join`。这条差别本身就是白名单
 * 存在的理由，所以它必须被断言——resume 哪天被从白名单里拿掉，这里立刻红。
 */
const ENDPOINTS = [
  // ── 文件系统浏览：访客永远不能碰（Global Constraints）
  { method: 'GET', path: '/api/fs/roots', deny: 'admin-only',
    admin: 200, editor: 403, viewer: 403, none: 401 },
  { method: 'GET', path: '/api/fs/list', deny: 'admin-only',
    url: () => `/api/fs/list?path=${encodeURIComponent(tmp)}`,
    admin: 200, editor: 403, viewer: 403, none: 401 },
  { method: 'POST', path: '/api/fs/mkdir', deny: 'admin-only',
    body: () => ({ parent: tmp, name: 'perm-probe' }),
    admin: 200, editor: 403, viewer: 403, none: 401 },

  // ── 库的生命周期与全局设置：同样只有本机
  { method: 'POST', path: '/api/library/open', deny: 'admin-only',
    body: () => ({ root: tmp }),
    admin: 200, editor: 403, viewer: 403, none: 401 },
  { method: 'POST', path: '/api/library/close', deny: 'admin-only',
    admin: 200, editor: 403, viewer: 403, none: 401 },
  // 刷新会替换所有人正在看的资产表，跟 open/close 同一档：只有本机能按。
  { method: 'POST', path: '/api/library/refresh', deny: 'admin-only',
    admin: 200, editor: 403, viewer: 403, none: 401 },
  { method: 'PUT', path: '/api/library/settings', deny: 'admin-only',
    body: () => ({ cellWidth: 240 }),
    admin: 200, editor: 403, viewer: 403, none: 401 },

  // ── 只读资产：访客要看照片才谈得上选片
  { method: 'GET', path: '/api/library/assets', admin: 200, editor: 200, viewer: 200, none: 401 },
  { method: 'GET', path: '/api/library/meta', admin: 200, editor: 200, viewer: 200, none: 401 },
  { method: 'GET', path: '/api/library/stream', sse: true,
    admin: 200, editor: 200, viewer: 200, none: 401 },
  { method: 'GET', path: '/api/library/marks', admin: 200, editor: 200, viewer: 200, none: 401 },
  { method: 'GET', path: '/api/thumb', url: () => '/api/thumb?id=A&tier=grid',
    admin: 200, editor: 200, viewer: 200, none: 401 },
  { method: 'GET', path: '/api/original', url: () => '/api/original?id=A',
    admin: 200, editor: 200, viewer: 200, none: 401 },
  // 烘焙优先级：只重排一个内存队列，不读也不写任何用户数据。它一度是 admin-only，
  // 后果是访客滚动时前端那条"先烤我正在看的这一屏"的信号发不出去，出图明显变慢——
  // 而"客户流畅地看图"正是这整个功能存在的理由。访客本来就能狂发缩略图请求，
  // 让他重排自己那条队列不增加任何实质风险，所以这一行是 read。
  { method: 'POST', path: '/api/library/prioritize',
    body: () => ({ ids: [] }),
    admin: 200, editor: 200, viewer: 200, none: 401 },

  // ── 写标记：editor 可以，viewer 不可以
  { method: 'PUT', path: '/api/library/marks', deny: 'read-only',
    body: () => ({ marks: {} }),
    admin: 200, editor: 200, viewer: 403, none: 401 },

  // ── 隐藏（Task 15）：admin-only，和导出同一档。隐藏改变的是所有人看到的照片
  //    集合，而且没有撤销入口——一个客户的手滑不该有这个权力，所以跟 editor
  //    能写标记的那一行不同，这里 editor 也进不去。
  { method: 'PUT', path: '/api/library/hidden', deny: 'admin-only',
    body: () => ({ ids: [], hidden: true }),
    admin: 200, editor: 403, viewer: 403, none: 401 },

  // ── 导出：访客永远不能导出，硬编码仅管理员，不是可配置开关
  { method: 'POST', path: '/api/export', deny: 'admin-only',
    body: () => ({ destRoot: out, mode: 'copy', manifest: false }),
    admin: 200, editor: 403, viewer: 403, none: 401 },
  { method: 'GET', path: '/api/export/:jobId/stream', deny: 'admin-only',
    url: () => `/api/export/${jobId}/stream`,
    admin: 200, editor: 403, viewer: 403, none: 401 },
  { method: 'POST', path: '/api/export/:jobId/cancel', deny: 'admin-only',
    url: () => `/api/export/${jobId}/cancel`,
    admin: 200, editor: 403, viewer: 403, none: 401 },

  // ── 分享接入：这三条的门禁是**链接本身**，不是身份，所以四种身份一视同仁。
  //    它们同时是白名单的三项——`none` 这一列不是 401 就是这里唯一的证明。
  { method: 'GET', path: '/api/share/:token/info',
    url: () => `/api/share/${shareToken}/info`,
    admin: 200, editor: 200, viewer: 200, none: 200 },
  // 用一个**已被占用**的昵称：四种身份都停在 409，既证明了这条路由对谁都开着，
  // 又不会在矩阵跑一遍的过程中凭空建出四个用户来污染后面的行。
  { method: 'POST', path: '/api/share/:token/join',
    url: () => `/api/share/${shareToken}/join`,
    body: () => ({ nickname: '编辑' }),
    admin: 409, editor: 409, viewer: 409, none: 409 },
  // admin 和 none 都没带 pc_user Cookie，所以拿到的是 need-join 而不是 no-actor。
  { method: 'POST', path: '/api/share/:token/resume',
    url: () => `/api/share/${shareToken}/resume`,
    unauth: 'need-join',
    admin: 401, editor: 200, viewer: 200, none: 401 },
  // leave 不在白名单里：它要求先有身份，所以 none 这一格回到标准的 401 no-actor。
  { method: 'POST', path: '/api/share/leave',
    admin: 200, editor: 200, viewer: 200, none: 401 },

  // ── 管理接口：分享的生命周期、用户的角色与去留、全部审计日志。
  //    访客碰到其中任何一条都等于自己给自己发权限、或者读到别人的全部操作记录，
  //    所以这九行的访客列没有例外，一律 403 admin-only。
  { method: 'GET', path: '/api/admin/shares', deny: 'admin-only',
    admin: 200, editor: 403, viewer: 403, none: 401 },
  { method: 'POST', path: '/api/admin/shares', deny: 'admin-only',
    body: () => ({ root: tmp, label: '矩阵建的' }),
    admin: 200, editor: 403, viewer: 403, none: 401 },
  { method: 'PATCH', path: '/api/admin/shares/:id', deny: 'admin-only',
    url: () => `/api/admin/shares/${adminShareId}`,
    body: () => ({ label: '矩阵改的' }),
    admin: 200, editor: 403, viewer: 403, none: 401 },
  { method: 'DELETE', path: '/api/admin/shares/:id', deny: 'admin-only',
    url: () => `/api/admin/shares/${revokableShareId}`,
    admin: 200, editor: 403, viewer: 403, none: 401 },
  { method: 'GET', path: '/api/admin/shares/:id/users', deny: 'admin-only',
    url: () => `/api/admin/shares/${adminShareId}/users`,
    admin: 200, editor: 403, viewer: 403, none: 401 },
  { method: 'PATCH', path: '/api/admin/shares/:id/users/:uid', deny: 'admin-only',
    url: () => `/api/admin/shares/${adminShareId}/users/${adminUserId}`,
    body: () => ({ role: 'viewer' }),
    admin: 200, editor: 403, viewer: 403, none: 401 },
  { method: 'DELETE', path: '/api/admin/shares/:id/users/:uid', deny: 'admin-only',
    url: () => `/api/admin/shares/${adminShareId}/users/${deletableUserId}`,
    admin: 200, editor: 403, viewer: 403, none: 401 },
  { method: 'GET', path: '/api/admin/shares/:id/events', deny: 'admin-only',
    url: () => `/api/admin/shares/${adminShareId}/events`,
    admin: 200, editor: 403, viewer: 403, none: 401 },
  { method: 'GET', path: '/api/admin/shares/:id/events.csv', deny: 'admin-only',
    url: () => `/api/admin/shares/${adminShareId}/events.csv`,
    admin: 200, editor: 403, viewer: 403, none: 401 },

  // 名册（Task 21）：跨分享合并的用户目录，用来在标记者离线之后还能查到昵称。
  // 里面是客户的真实昵称，是摄影师的经营信息，跟上面九行一样 admin-only。
  { method: 'GET', path: '/api/admin/library-users', deny: 'admin-only',
    admin: 200, editor: 403, viewer: 403, none: 401 },

  // ── 局域网地址探测（Task 13）。挂在 /api/admin 下的**另一个** Router
  //    （netaddrRouter，见 index.js），所以它跟上面九行一样是 admin-only：
  //    网卡地址是内网拓扑，而且这条接口是给摄影师拼分享链接用的——
  //    访客手里已经有链接了，没有任何理由问这个。
  { method: 'GET', path: '/api/admin/netaddr', deny: 'admin-only',
    admin: 200, editor: 403, viewer: 403, none: 401 },
];

/**
 * 受保护路由上的 401 只有一种来源：全局早挂的 defaultDeny。
 * （requireAdmin 对无身份返回的是 403。）白名单里的路由是唯一的例外——
 * 它们自己的处理函数可以回别的 401 错误码，那些行用 `unauth` 显式写出来。
 */
const NO_ACTOR = 'no-actor';

describe('权限矩阵（四种身份 x 全部 /api 端点）', () => {
  it.each(ENDPOINTS)(
    '$method $path -> admin=$admin editor=$editor viewer=$viewer none=$none',
    async (endpoint) => {
      for (const identity of ['admin', 'editor', 'viewer', 'none']) {
        const expected = endpoint[identity];
        // 每一格之前都把库重开一遍：上一格可能正好是 POST /api/library/close。
        await ensureLibrary();

        const ctrl = new AbortController();
        const res = await requestAs(endpoint, identity, ctrl);
        const where = `${identity} ${endpoint.method} ${endpoint.path}`;

        expect(res.status, `${where} 的状态码`).toBe(expected);

        if (expected === 401) {
          expect((await res.json()).error, `${where} 的错误码`).toBe(endpoint.unauth ?? NO_ACTOR);
        } else if (expected === 403) {
          expect((await res.json()).error, `${where} 的错误码`).toBe(endpoint.deny);
        } else {
          // 200：不关心响应体，直接掐断（SSE 那两条永远不会自己结束）。
          ctrl.abort();
        }
      }
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 矩阵的自检：路由枚举 vs 矩阵
// ─────────────────────────────────────────────────────────────────────────────

/** `/api/export` + `/` 要合成 `/api/export`，不能留一条永远匹配不上的 `/api/export/`。 */
function joinPath(prefix, routePath) {
  const joined = `${prefix}${routePath}`.replace(/\/+$/, '');
  return joined === '' ? '/' : joined;
}

/**
 * 从 Express 的路由栈枚举实际注册的每一条 `/api` 路径。
 *
 * Express 5 的 Layer **不保存挂载前缀**（`layer.path` 只在匹配过程中被赋值，
 * path-to-regexp 编出来的 matcher 是闭包，取不回原始字符串），所以前缀只能来自
 * `API_MOUNTS` 这张挂载表——它同时也是 createApp() 真正用来挂载的那一份数据，
 * 不是给测试另抄的一份。路径本身则是从 Router 的 stack 上读出来的，
 * 谁加了新路由这里就多一条。
 */
function registeredApiRoutes() {
  const found = new Set();
  for (const [prefix, router] of API_MOUNTS) {
    for (const layer of router.stack) {
      if (!layer.route) {
        // 挂在 Router 上的普通中间件层。但如果它自己也是一个 Router，
        // 就说明有一整层嵌套挂载没被枚举——那是个洞，必须响亮地失败。
        if (Array.isArray(layer.handle?.stack)) {
          throw new Error(`${prefix} 下有未被枚举的嵌套 Router，请扩展 registeredApiRoutes()`);
        }
        continue;
      }
      for (const routePath of [].concat(layer.route.path)) {
        for (const method of Object.keys(layer.route.methods ?? {})) {
          if (method === '_all') continue;
          found.add(`${method.toUpperCase()} ${joinPath(prefix, routePath)}`);
        }
      }
    }
  }
  return found;
}

const coveredRoutes = () => new Set(ENDPOINTS.map((e) => `${e.method} ${e.path}`));

describe('矩阵覆盖了全部路由', () => {
  it('每一个 /api 路由都出现在矩阵里', () => {
    const registered = registeredApiRoutes();
    const covered = coveredRoutes();
    const uncovered = [...registered].filter((k) => !covered.has(k)).sort();
    // 以后有人加了新端点却忘了配权限，这里立刻红。
    expect(uncovered).toEqual([]);
  });

  it('矩阵里没有已经不存在的端点', () => {
    const registered = registeredApiRoutes();
    const stale = [...coveredRoutes()].filter((k) => !registered.has(k)).sort();
    // 反方向同样要查：一条路由被删掉之后，矩阵里那一行会变成永远绿的空壳，
    // 而它看起来还在守着什么。
    expect(stale).toEqual([]);
  });

  it('app 上没有游离在 API_MOUNTS 之外的 Router 或 /api 路由', () => {
    const app = createApp();
    const known = new Set(API_MOUNTS.map(([, router]) => router));
    const strays = [];
    for (const layer of app.router.stack) {
      // 直接 app.use('/api/x', someRouter) 挂上来的 Router：绕开了挂载表，
      // 上面的枚举看不到它，它下面的端点就成了矩阵的盲区。
      if (Array.isArray(layer.handle?.stack) && !known.has(layer.handle)) {
        strays.push(`router:${layer.name}`);
      }
      // 直接 app.get('/api/...') 注册的路由，同理。
      for (const p of [].concat(layer.route?.path ?? [])) {
        if (String(p).startsWith('/api')) strays.push(`route:${layer.name} ${p}`);
      }
    }
    expect(strays).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 接线本身的两条前提。矩阵的每一行都建立在它们成立之上。
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 路径大小写：矩阵那一整列的答案不能因为换个写法就变
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Express 默认 `case sensitive routing = false`：`/API/share/leave` 和
 * `/api/share/leave` 落到**同一个处理函数**。而全局的 defaultDeny 以前用的是
 * 逐字节的 `startsWith('/api/')`，于是大写路径整个绕开了它——
 * 实测匿名非回环的 `POST /API/share/leave` 拿到 **200**，
 * `GET /API/admin/shares` 拿到 403（落到路由自己的闸门上）而不是 401。
 *
 * 没有提权，但上面那张矩阵里 `none -> 401` 那一整列从此不是权威答案，
 * 而那张表是本项目安全边界唯一可执行的表达。
 *
 * 只把开头那一段 `/api` 换成大写，不是整条 URL：路径里的分享令牌是**大小写
 * 敏感**的，整条大写会把它变成一个不存在的令牌，测出来的就是 404 而不是权限。
 */
const upperApi = (url) => url.replace(/^\/api\b/, '/API');

describe('路径大小写不改变授权结果', () => {
  it.each([
    // 这一行以前是 200：绕过 defaultDeny 之后没有任何人接管它。
    { method: 'POST', path: '/api/share/leave', identity: 'none', expected: 401 },
    // 这一行以前是 403：绕过之后落到路由自己的 requireAdmin 上。
    { method: 'GET', path: '/api/admin/shares', identity: 'none', expected: 401 },
    { method: 'GET', path: '/api/fs/roots', identity: 'none', expected: 401 },
    { method: 'GET', path: '/api/library/assets', identity: 'none', expected: 401 },
    // 反面两条：收紧不能把本来能用的大写路径变成 401。
    { method: 'GET', path: '/api/library/assets', identity: 'viewer', expected: 200 },
    { method: 'PUT', path: '/api/library/marks', identity: 'viewer', expected: 403,
      body: () => ({ marks: {} }) },
  ])('$method $path（$identity）大写与小写同为 $expected', async (row) => {
    await ensureLibrary();
    for (const url of [row.path, upperApi(row.path)]) {
      const ctrl = new AbortController();
      const res = await requestAs({ ...row, url: () => url }, row.identity, ctrl);
      expect(res.status, `${row.identity} ${row.method} ${url}`).toBe(row.expected);
      if (res.status === 200) ctrl.abort(); else await res.json();
    }
  });
});

describe('接线前提', () => {
  it('夹具可信：同一条请求换成非回环源地址就不再是管理员', async () => {
    await ensureLibrary();
    const ctrl = new AbortController();

    remoteOverride = null;
    const asLocal = await fetch(`${base}/api/fs/roots`, { signal: ctrl.signal });
    expect(asLocal.status).toBe(200);
    await asLocal.json();

    remoteOverride = GUEST_IP;
    const asRemote = await fetch(`${base}/api/fs/roots`, { signal: ctrl.signal });
    expect(asRemote.status).toBe(401);
    expect((await asRemote.json()).error).toBe(NO_ACTOR);
  });

  it('访客不能用别条链接的会话读别的文件夹（wrong-library 在真实接线里也生效）', async () => {
    await ensureLibrary();
    remoteOverride = GUEST_IP;
    const res = await fetch(`${base}/api/library/assets`, {
      headers: { 'X-PhotoCull-Session': sid, cookie: `pc_user=${TOKENS.stranger}` },
    });
    // 这个人手里的令牌有效、分享也 active，只是那条分享指向 out 而不是 tmp。
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('wrong-library');
  });

  /**
   * `/stream` 的越库闸门 —— 单拎出来，因为它跟上面那条不是同一回事。
   *
   * 这是全项目**唯一一条常连通道**：接上去之后，别人每一次标记、每一次上下线、
   * 每一批元数据（含文件名）都会持续推过来，而且推的是**另一个**文件夹的。
   * 一次 403 的 `/assets` 只丢一个响应；一次放行的 `/stream` 是一条一直开着的
   * 旁路，而且没有任何后续请求会再被检查一次。
   *
   * 这条闸门此前**没有任何测试守着**：把 `/stream` 上的 `requirePerm('read')`
   * 摘掉，全量一条都不红——权限矩阵里那一行只断言 editor/viewer 拿 200、
   * 无身份拿 401，而 401 来自全局的 defaultDeny，跟这条路由自己挂没挂闸门无关。
   *
   * 两条通道都要测：`EventSource` 设不了请求头，真正的访客只会走 `?sid=`。
   * 只测请求头那条，等于测了一条真实攻击者不会走的路。
   */
  it.each([
    ['请求头', (s) => ({ url: '/api/library/stream', headers: { 'X-PhotoCull-Session': s } })],
    ['?sid=（EventSource 唯一能走的那条）',
      (s) => ({ url: `/api/library/stream?sid=${encodeURIComponent(s)}`, headers: {} })],
  ])('A 分享的访客带 B 库的 sid 打 /stream -> 403 wrong-library（%s）', async (_label, build) => {
    await ensureLibrary();
    remoteOverride = GUEST_IP;
    const { url, headers } = build(sid);
    const ctrl = new AbortController();
    const res = await fetch(base + url, {
      headers: { ...headers, cookie: `pc_user=${TOKENS.stranger}` },
      signal: ctrl.signal,
    });
    // 放行的话这里会是 200 + 一条永远不结束的 text/event-stream，
    // 里面有另一个文件夹的文件名和在线名单。
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('wrong-library');
    ctrl.abort();
  });

  /**
   * CSRF 第二道防线的**端到端**证据（单元层面见 middleware/auth.test.js）。
   *
   * 这条请求就是一张挂在任意网站上的表单发出来的形状：只有 Cookie，没有任何
   * 自定义头，会话 id 塞在查询参数里。补上这道防线之前它实测 200 —— 也就是
   * 规格 §9.1 写的那"两道独立防线"其实只有一道。
   */
  it('写请求只带 Cookie + ?sid=（跨站表单的形状）-> 403 csrf-header-required', async () => {
    await ensureLibrary();
    remoteOverride = GUEST_IP;
    const res = await fetch(`${base}/api/library/marks?sid=${encodeURIComponent(sid)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: `pc_user=${TOKENS.editor}` },
      body: JSON.stringify({ marks: {} }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('csrf-header-required');
  });

  it('同一条写请求换成带 X-PhotoCull-Session 请求头 -> 200', async () => {
    await ensureLibrary();
    remoteOverride = GUEST_IP;
    const res = await fetch(`${base}/api/library/marks`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: `pc_user=${TOKENS.editor}`,
        'X-PhotoCull-Session': sid,
      },
      body: JSON.stringify({ marks: {} }),
    });
    expect(res.status).toBe(200);
  });

  /** GET 那条通道不能被这次收紧误伤：`<img src>` 和 `EventSource` 全靠它。 */
  it('GET 仍然认 ?sid=（缩略图和 SSE 设不了请求头）', async () => {
    await ensureLibrary();
    remoteOverride = GUEST_IP;
    const res = await fetch(`${base}/api/thumb?id=A&tier=grid&sid=${encodeURIComponent(sid)}`, {
      headers: { cookie: `pc_user=${TOKENS.viewer}` },
    });
    expect(res.status).toBe(200);
  });

  /** 反面：自己那条分享指向的会话上，同一条流必须照常连得上。 */
  it('自己那条分享的访客照常连得上 /stream', async () => {
    await ensureLibrary();
    remoteOverride = GUEST_IP;
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/library/stream?sid=${encodeURIComponent(sid)}`, {
      headers: { cookie: `pc_user=${TOKENS.viewer}` },
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    ctrl.abort();
  });
});
