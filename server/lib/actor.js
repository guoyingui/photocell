import crypto from 'node:crypto';
import { parseCookies } from './cookies.js';
import { findUserByToken } from './users.js';
import { getShareById, shareStatus } from './shares.js';

/** 用户令牌所在的 Cookie 名。计划里写死为 pc_user，join/resume/leave 都用这一个。 */
export const USER_COOKIE = 'pc_user';

/** 可选的 `--admin-token` 走这个头。Node 把请求头名全部小写化。 */
export const ADMIN_TOKEN_HEADER = 'x-photocull-admin';

/**
 * 管理员令牌所在的 Cookie 名。由 `GET /admin-login?token=…` 种下
 * （见 routes/adminlogin.js），值就是 `--admin-token` 本身。
 *
 * 为什么非要有这条通道：**浏览器没有办法给导航请求加自定义请求头**。
 * 地址栏里敲一个 URL、点一个链接、打开收藏的地址，发出去的都是导航请求，
 * 上面挂不上 `X-PhotoCull-Admin`。只认那个头的话，这个开关对任何浏览器
 * 都不可用——包括规格 §9.3 白纸黑字写着的"摄影师想从其他电脑管理"那个场景，
 * 也包括摄影师自己本机的浏览器（设了令牌之后回环也不再算管理员，满屏 403）。
 */
export const ADMIN_COOKIE = 'pc_admin';

/**
 * `--admin-token` 的进程内配置。
 *
 * 计划把命令行解析放在 Task 13 的 server/index.js 里，本模块只提供落点：
 * 启动时调一次 setAdminToken(value)，没配置就一直是 null。
 * null 表示"这条通道整个关闭"——不是"空令牌"，所以带着空的
 * X-PhotoCull-Admin 头也拿不到管理员身份。
 */
let adminToken = null;

export function setAdminToken(value) {
  adminToken = (typeof value === 'string' && value !== '') ? value : null;
}

export function getAdminToken() {
  return adminToken;
}

export function isLoopback(req) {
  const ip = req.socket.remoteAddress;
  // 只看 TCP 源地址。**绝不读 X-Forwarded-For** —— 那是客户端可以随便写的请求头，
  // 读它等于把管理员权限开放给任何知道加一行 header 的人。
  //
  // 这个函数只回答"TCP 源地址是不是回环"，**不回答"这是不是管理员"**。
  // 反向代理的两个方向后果完全相反，判定在 resolveActor 里（见那里的注释）：
  //   - 代理在**另一台机器**上：所有请求都不是回环，回环判定失效（关门）。
  //   - 代理和本进程在**同一台机器**上：所有请求都是回环（开门）——
  //     必须由 resolveActor 的否决条件挡住，靠这个函数是挡不住的。
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * 一旦出现就说明"这个请求是被人转发过来的"的那几个头。
 *
 * 只用来**否决**回环管理员身份，绝不用来判定来源地址——后者才是那条
 * "绝不读 X-Forwarded-For"的禁令要防的事（读它就等于让任何人自称回环）。
 * 用它来否决的方向正好相反：攻击者加上这些头只能把自己**降级**。
 */
const FORWARDING_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded'];

/**
 * 请求带没带任何转发头。
 *
 * **按"这个头在不在"判断，不看它的值。** 空串 `X-Forwarded-For:` 也算带了：
 * 代理有没有填上值，改变不了"前面有一层代理"这个事实，而这里的落点必须是
 * 更保守的那一边。同名头出现多次时 Node 会给一个数组，那也算带了。
 */
function hasForwardingHeader(req) {
  const headers = req?.headers;
  if (!headers || typeof headers !== 'object') return false;
  return FORWARDING_HEADERS.some((name) => headers[name] !== undefined);
}

/**
 * 请求的来源地址。**不要用 Express 的 `req.ip`**：一旦有人打开了
 * `trust proxy`，`req.ip` 就会去读 X-Forwarded-For，于是限流的 key
 * 变成了攻击者自己写的字符串，换一个值就能重置计数。
 */
export function clientAddress(req) {
  return req?.socket?.remoteAddress ?? null;
}

function headerOf(req, name) {
  const value = req?.headers?.[name];
  return typeof value === 'string' ? value : null;
}

/**
 * 定长比较。长度不等直接判否——这一步会泄露"长度对不对"，
 * 但 timingSafeEqual 本身就要求两个 Buffer 等长，别无选择；
 * 令牌是 32 字节随机，知道长度对猜测毫无帮助。
 *
 * 导出是给 routes/adminlogin.js 用的：那条登录路由校验的是同一个令牌，
 * 必须用同一份比较实现。各写各的迟早会分叉成一个 `===`。
 */
export function timingSafeEqualStr(presented, expected) {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 出示的这个串是不是管理员令牌。
 *
 * `adminToken === null` 时永远是 false——null 的语义是"这条通道整个关闭"，
 * 不是"空令牌"。两条通道（请求头和 Cookie）都走这一个函数，
 * 保证它们的判定性质**逐字相同**：定长比较、空串不通过、开关没开时一律不通过。
 */
function matchesAdminToken(presented) {
  if (adminToken === null) return false;
  if (typeof presented !== 'string' || presented === '') return false;
  return timingSafeEqualStr(presented, adminToken);
}

/**
 * 从请求解析 actor。
 *
 * 判定顺序本身就是要求（计划 Task 6）：
 *   1. 配置了 --admin-token，且 X-PhotoCull-Admin 头**或** pc_admin Cookie
 *      与之定长相等 -> admin
 *   2. 回环地址 **且两条否决都不成立** -> admin
 *   3. Cookie 里的用户令牌查得到、用户没被禁用、且其分享 active -> user
 *   4. 其余 -> none
 *
 * 返回 { kind:'admin' } | { kind:'user', user, share } | { kind:'none' }。
 * 本函数只回答"你是谁"，不回答"你能做什么"——后者是 middleware/auth.js 的事。
 */
export async function resolveActor(req) {
  // 一次解析，两处用（管理员令牌和用户令牌都在 Cookie 里）。解析两次的风险不在性能，
  // 而在于两份结果哪天会因为解析实现被改动而对不上。
  const cookies = parseCookies(headerOf(req, 'cookie'));

  // ── 管理员令牌的两条通道 ──────────────────────────────────────────────
  //
  // 头：curl / Postman / 脚本，凡是能自己拼请求的客户端。
  // Cookie：**浏览器唯一走得通的那条**——导航请求加不了自定义头，
  //   所以 pc_admin 由 `GET /admin-login?token=…` 种下（routes/adminlogin.js）。
  //
  // 两条走同一个 matchesAdminToken，定长比较，性质完全一致。
  // 令牌是显式凭据，所以这一段排在回环判定**之前**，也不受转发头否决影响：
  // 带对令牌的人本来就该是管理员，无论他从哪来、前面有没有代理。
  if (adminToken !== null) {
    if (matchesAdminToken(headerOf(req, ADMIN_TOKEN_HEADER))) return { kind: 'admin' };
    if (matchesAdminToken(cookies[ADMIN_COOKIE])) return { kind: 'admin' };
  }

  // ── 回环即管理员，外加两条否决 ─────────────────────────────────────────
  //
  // 光看源地址是危险的，而且危险的方向是**开门**：nginx / Caddy 反代
  // localhost 是最常见的部署形态，那种情况下每一个转发过来的请求源地址都是
  // 127.0.0.1 —— 于是每个访客都成了管理员，能浏览整块硬盘、能触发导出、
  // move 模式下能删掉不可再生的 RAW。两条否决都是为这件事加的：
  //
  // 1. **配了 --admin-token 就只认令牌。** 语义是"我告诉你我前面有东西了，
  //    从现在起回环本身不算数"。它以前排在回环判定前面，是一条**额外**通道
  //    而不是替代，也就是说它挡不住上面那种情形。
  //
  // 2. **带任何转发头的请求一律不给回环管理员身份。** 这个方向是安全的：
  //    攻击者只能用它把自己降级，没法用它提权（直连过来的攻击者本来就不是
  //    回环，加不加头都不是管理员）。注意否决写在这里而不是塞进 isLoopback：
  //    那个函数必须保持"只看 TCP 源地址、绝不读转发头来判定来源"。
  //
  // 两条否决都不成立时，单机流程（npm start、浏览器直连 127.0.0.1）一切照旧。
  if (adminToken === null && !hasForwardingHeader(req) && isLoopback(req)) {
    return { kind: 'admin' };
  }

  const token = cookies[USER_COOKIE];
  if (typeof token !== 'string' || token === '') return { kind: 'none' };

  try {
    const user = await findUserByToken(token);
    // `disabled === false` 而不是 `!user.disabled`：一条缺了这个字段的记录
    // （旧版本写的、或者被手工改坏的）应该解析不出身份，而不是默认可用。
    if (!user || user.disabled !== false) return { kind: 'none' };

    const share = await getShareById(user.shareId);
    // 撤销/过期/分享记录整个消失，三种情况都不是 active，一律没有身份。
    // 这一条是"链接就是授权本身"的兑现处：撤销之后手里的 Cookie 立刻作废。
    if (shareStatus(share, Date.now()) !== 'active') return { kind: 'none' };

    return { kind: 'user', user, share };
  } catch (err) {
    // 读存储失败（文件损坏、权限不对）时按"没有身份"处理。
    // 这一层的规矩是不确定的一律拒绝：把异常抛上去会变成 500，
    // 而 500 在某些接线顺序下反而绕过了后面的授权检查。
    console.error('[actor] 解析用户令牌失败，按无身份处理', err);
    return { kind: 'none' };
  }
}
