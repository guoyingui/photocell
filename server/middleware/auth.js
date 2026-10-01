import { resolveActor } from '../lib/actor.js';
import { getSession } from '../lib/session.js';

/**
 * 身份与授权中间件。
 *
 * 分工是刻意的：actor.js 只回答"你是谁"，这里只回答"你能做什么"。
 * 四个中间件都遵守同一条规矩——**不确定的一律拒绝**。任何一处的
 * "没解析出来就当作没限制"都会把整层变成装饰品。
 */

/** 把 resolveActor 的结果挂到 req.actor。永不拒绝，拒绝是下面三个的事。 */
export async function attachActor(req, res, next) {
  try {
    req.actor = await resolveActor(req);
  } catch (err) {
    // resolveActor 内部已经兜过一次底，这里是第二道：它绝不能把异常
    // 泄漏成一个 500，否则"解析失败"和"拒绝"就混成了同一种表现。
    console.error('[auth] 解析身份失败，按无身份处理', err);
    req.actor = { kind: 'none' };
  }
  next();
}

/** 只有管理员放行。非管理员一律 403（无身份的请求在真实接线里先被 defaultDeny 拦成 401）。 */
export function requireAdmin(req, res, next) {
  if (req.actor?.kind === 'admin') return next();
  return res.status(403).json({ error: 'admin-only', message: '这个操作只能在本机进行' });
}

const PERMS = new Set(['read', 'write']);

/**
 * 方法本身不改变任何状态的那几个。
 *
 * `?sid=` 这条通道只对它们开放（见 sessionIdOf）。HEAD 一并算进来是因为
 * Express 会拿 GET 的处理函数去应答 HEAD，把它排除掉等于悄悄让一类请求
 * 换一条判定路径。
 */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * 会话 id 的通道。**这是 CSRF 的第二道防线**（第一道是 Cookie 的 `SameSite=Lax`）。
 *
 * | 方法 | `X-PhotoCull-Session` 请求头 | `?sid=` 查询参数 |
 * |---|---|---|
 * | GET / HEAD | 认 | 认 |
 * | 其余（写） | 认 | **不认** |
 *
 * 规格 §9.1 那一行写的是"所有写请求必须带自定义头 `X-PhotoCull-Session`——
 * 跨站表单提交无法设置自定义头"。以前这里是 `请求头 || ?sid=`，两条通道平权，
 * 于是那道防线在代码里根本不存在：一张挂在任意网站上的
 * `<form method=POST action="http://127.0.0.1:5183/api/library/marks?sid=…">`
 * 只带 Cookie、不带任何自定义头，照样 200。
 *
 * `?sid=` 存在的唯一理由是 `<img src>` 和 `EventSource` **设不了请求头**——
 * 而那两者发出来的都是 GET。所以把它收窄到安全方法上，不会关掉任何一条
 * 真实存在的通道；能被关掉的只有伪造出来的那一种。
 *
 * 认不出方法（`req.method` 缺失）时落到"不认 ?sid="这一边：不确定的一律拒绝。
 */
export function sessionIdOf(req) {
  const header = req.headers?.['x-photocull-session'];
  if (typeof header === 'string' && header !== '') return header;
  if (!SAFE_METHODS.has(String(req.method ?? '').toUpperCase())) return '';
  const query = req.query?.sid;
  if (typeof query === 'string' && query !== '') return query;
  return '';
}

/**
 * 上面那条规矩的**可读的失败**，全局早挂（见 index.js 的接线）。
 *
 * 没有它的话，一个只带 `?sid=` 的写请求会一路走到 requireSession 那里拿到
 * 409 `session-gone`——而那句话是假的（会话好好活着），前端还会据此把人退回
 * 文件夹选择器。一条安全规则被伪装成一个会话问题，是最难被查明的那种表现。
 *
 * 同时它覆盖的比 sessionIdOf 更宽：将来有人加一条不走 sessionIdOf 的写路由，
 * 这条规矩仍然对它成立，不需要那个人记得。
 *
 * 只在"带了 `?sid=` 却没带请求头"时说话。没带 `?sid=` 的写请求不关它的事——
 * 那可能是一条根本不需要会话的路由（`/api/share/:token/join`、`/api/export/:jobId/cancel`）。
 */
export function rejectQuerySessionOnWrites(req, res, next) {
  if (SAFE_METHODS.has(String(req.method ?? '').toUpperCase())) return next();
  const header = req.headers?.['x-photocull-session'];
  if (typeof header === 'string' && header !== '') return next();
  const query = req.query?.sid;
  if (typeof query !== 'string' || query === '') return next();
  return res.status(403).json({
    error: 'csrf-header-required',
    message: '写请求的会话 id 必须放在 X-PhotoCull-Session 请求头里，不接受 ?sid= 查询参数',
  });
}

function sessionOf(req) {
  // requireSession 已经解析过就直接用它那一份，避免同一个请求解析两次
  // 拿到两个不同的会话（两次之间会话可能已经被关掉）。
  if (req.session && typeof req.session.root === 'string') return req.session;
  const id = sessionIdOf(req);
  if (id === '') return null;
  return getSession(id);
}

/**
 * `requirePerm('read' | 'write')`。
 *
 * | actor          | read | write |
 * |----------------|------|-------|
 * | admin          | 放行 | 放行  |
 * | user / editor  | 放行 | 放行  |
 * | user / viewer  | 放行 | 403 read-only |
 * | none           | 401  | 401   |
 *
 * 外加一条同等重要的：**访客只能访问自己那条分享指向的会话**。
 * 请求带来的 sessionId 对应的会话必须满足 `session.root === actor.share.root`，
 * 不等则 403 wrong-library。少了这一条，一个访客就能拿另一条链接的 sessionId
 * 去读别的文件夹——所有资产接口都只按 sessionId 找库，它们不会替你问这个问题。
 *
 * 注意接线要求：本函数只在"请求确实带来了一个还活着的会话"时才做这条校验。
 * 请求没带 sessionId、或者 sessionId 已经失效时，它把判断留给既有的
 * requireSession（返回 409 session-gone，前端据此重新 join）。
 * 因此**每个会话相关的路由都必须同时挂 requireSession**，不能只挂 requirePerm。
 */
export function requirePerm(perm) {
  if (!PERMS.has(perm)) {
    // 接线时就炸掉。写错权限名是配置错误，绝不能等到某个请求进来才发现。
    throw new TypeError(`未知的权限名：${JSON.stringify(perm)}`);
  }

  return function permGate(req, res, next) {
    const actor = req.actor;

    if (!actor || actor.kind === 'none') {
      return res.status(401).json({ error: 'no-actor' });
    }
    if (actor.kind === 'admin') return next();
    if (actor.kind !== 'user') {
      // 认不出的 kind 一律当没有身份。将来多一种 actor 时，
      // 默认落点是拒绝而不是放行。
      return res.status(401).json({ error: 'no-actor' });
    }

    const session = sessionOf(req);
    if (session && session.root !== actor.share?.root) {
      return res.status(403).json({
        error: 'wrong-library',
        message: '这条链接不对应当前打开的文件夹',
      });
    }

    // 写权限只认 editor：角色字段被改坏成任何意外值时，落点是只读。
    if (perm === 'write' && actor.user?.role !== 'editor') {
      return res.status(403).json({ error: 'read-only', message: '你当前是只读权限' });
    }

    return next();
  };
}

/**
 * 默认拒绝。白名单：静态资源、`GET /api/share/:token/info`、
 * `POST /api/share/:token/join`、`POST /api/share/:token/resume`
 * （计划 Global Constraints 逐字的四项），外加 `GET /admin-login`。
 *
 * `resume` 是第四项，规格 6.2 那句只列了前三项，以它为准会漏掉一整条出口：
 * 令牌**有效**的回访者本来就被 resolveActor 解析成 user、根本走不到这里；
 * 白名单只对令牌**失效**的回访者起作用。而那正是必须让请求进到处理函数的
 * 情形——只有处理函数才会回 401 `need-join` 并**清掉那枚死 Cookie**。
 * 挡在外面的话浏览器会一直带着那枚死 Cookie 重试 401 `no-actor`，
 * 用户卡在一个没有出口的循环里。
 * 安全代价为零：无身份访问 resume 只会读一下 Cookie 然后 401，不泄露任何东西，
 * 且和另外两条一样受 routes/share.js 里那个按 IP 的失败闸门约束。
 *
 * `GET /admin-login` 是后来补的第五项，理由同构：走那条路的人正是还没有身份的
 * 那个浏览器。它自己的失败一律 404 且三种失败逐字节一致，不泄露开关有没有开
 * （见 routes/adminlogin.js）。
 *
 * 白名单写成"方法 + 完整路径正则"而不是前缀匹配：前缀匹配下
 * `/api/share/x/join/../../library/marks` 这类路径会顺着白名单溜过去。
 */
const WHITELIST = [
  { method: 'GET', pattern: /^\/api\/share\/[^/]+\/info\/?$/ },
  { method: 'POST', pattern: /^\/api\/share\/[^/]+\/join\/?$/ },
  { method: 'POST', pattern: /^\/api\/share\/[^/]+\/resume\/?$/ },
  // 第五项：`--admin-token` 的浏览器登录入口（routes/adminlogin.js）。
  // 走这条路的人正是**还没有管理员身份**的那个浏览器，挡在这里等于这条入口不存在。
  //
  // 老实说一句：它今天靠下面那条"非 /api 一律放行"就已经过得去了，这一项目前是
  // 冗余的，删掉不会有任何测试变红。写在这里是因为"哪些路径无身份可达"这个问题
  // 应该在这张表里有答案——"非 /api 一律放行"哪天被收紧时，一个进不去的登录入口
  // 不会响亮地失败，只会表现成摄影师突然打不开自己的界面。
  { method: 'GET', pattern: /^\/admin-login\/?$/ },
];

export function defaultDeny(req, res, next) {
  // baseUrl + path 兼顾两种挂法：挂在 app 上时 baseUrl 是空串，
  // 挂在带前缀的 router 上时 req.path 只剩相对部分，少了它就匹配不到 /api/。
  const fullPath = `${req.baseUrl ?? ''}${req.path ?? ''}`;

  /**
   * **匹配一律用小写化之后的路径。**
   *
   * Express 默认 `case sensitive routing = false`，也就是说 `/API/share/leave`
   * 和 `/api/share/leave` 会被路由到**同一个处理函数**。而这里以前是逐字节的
   * `startsWith('/api/')`，于是大写路径整个绕开了这道默认拒绝：实测匿名非回环
   * 的 `POST /API/share/leave` 拿到 **200**（绕过之后无人接管），
   * `GET /API/admin/shares` 拿到 403 而不是 401（落到路由自己的闸门上）。
   * 没有提权，但权限矩阵里 `none -> 401` 那一整列从此不再是权威答案——
   * 而那张表是本项目安全边界唯一可执行的表达。
   *
   * 白名单也一起按小写匹配，这样"大写路径和小写路径拿到**同一个**状态码"
   * 是一条无例外的性质，而不是"除了白名单那几条之外"。令牌的大小写不受影响：
   * 小写化只用于**匹配**，交给路由的仍然是原始路径，`[^/]+` 那一段本来也
   * 不关心大小写。
   */
  const lower = fullPath.toLowerCase();

  // 白名单排在下面那条 /api 前缀判断之前，这样它对**任何**路径都说得上话，
  // 而不只是 /api 下的。对现有五项来说行为完全不变（四项在 /api 下，
  // /admin-login 本来也会被下面那条放行）。
  for (const { method, pattern } of WHITELIST) {
    if (req.method === method && pattern.test(lower)) return next();
  }

  // 非 /api 一律放行：静态资源和 SPA 兜底（含 /s/<token> 首屏）不需要身份，
  // 页面本身不含任何照片数据，数据全部走 /api。
  if (!lower.startsWith('/api/')) return next();

  // `!req.actor` 也在这里拒绝：忘挂 attachActor 时整个 API 关门，
  // 而不是整个 API 敞开。这类接线错误必须响亮地失败。
  if (!req.actor || req.actor.kind === 'none') {
    return res.status(401).json({ error: 'no-actor' });
  }

  return next();
}
