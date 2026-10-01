import { serializeCookie } from '../lib/cookies.js';
import { ADMIN_COOKIE, getAdminToken, timingSafeEqualStr } from '../lib/actor.js';

/**
 * `GET /admin-login?token=<令牌>` —— `--admin-token` 唯一一条浏览器进得来的入口。
 *
 * 为什么必须有它：**浏览器没有办法给导航请求加自定义请求头**。地址栏里敲一个
 * URL、点一个链接、打开收藏的地址，发出去的都是导航请求，`X-PhotoCull-Admin`
 * 挂不上去。而设了 `--admin-token` 之后回环本身也不再授予管理员身份
 * （见 lib/actor.js 的两条否决），于是这个开关一开：
 *
 *   - 规格 §9.3 白纸黑字写的"给摄影师想从其他电脑管理的场景"——电脑浏览器用不了；
 *   - 摄影师自己本机打开 127.0.0.1——满屏 403。
 *
 * 一个文档写着"给人用"、却对所有浏览器都不工作的开关是坏的，不是保守的。
 * 这条路由把它变成能用的：拿令牌换一枚 Cookie，之后浏览器自动带上。
 *
 * 两条性质是不可协商的：
 *
 * 1. **失败一律 404，三种失败逐字节一致**（开关没开 / 没带 token / 带错了）。
 *    差一个字节，外面的人就能拿这条路由探测这台机器有没有开管理员令牌，
 *    而那正是"要不要花力气猜令牌"的第一个问题。所有失败共用下面那一个出口。
 * 2. **令牌进 Cookie，不进地址栏。** 校验通过后 302 回固定的 `/`：
 *    带令牌的那个 URL 不会留下一条可以后退回去的历史条目，也不会被下一跳的
 *    Referer 带走，更不会一直摆在地址栏里给旁边的人看。
 */

/** 挂载路径。导出出去，让接线处和测试用同一个字面量。 */
export const ADMIN_LOGIN_PATH = '/admin-login';

/**
 * 属性与访客 Cookie 完全一致（见 routes/share.js 的 COOKIE_OPTS）：
 *
 * - `HttpOnly`：这枚 Cookie 等同于管理员密码。少了它，任何一处 XSS 都能把它
 *   `document.cookie` 出来，攻击者就拿到了浏览整块硬盘、触发导出、
 *   移动模式下删 RAW 的权限。
 * - `SameSite=Lax`：跨站请求带不上它，CSRF 的第一道防线（第二道是所有写请求
 *   必须带 `X-PhotoCull-Session` 头）。
 * - `Path=/`：整站的 `/api` 请求都要带得上，写窄了等于没种。
 *
 * **刻意不设 Max-Age**：这是一枚会话 Cookie，浏览器关掉就没了。管理员令牌是
 * 进程级配置，进程重启换一个令牌之后旧 Cookie 自然失效——给它一个比会话更长的
 * 寿命，只是多一份躺在磁盘上的凭据。
 */
const COOKIE_OPTS = Object.freeze({ httpOnly: true, sameSite: 'lax', path: '/' });

/**
 * 唯一的失败响应。冻结是为了防止某处就地改一个字段，
 * 把"三种失败一致"悄悄改成两种一致。
 */
const NOT_FOUND = Object.freeze({ error: 'not-found', message: '没有这个页面' });

function notFound(res) {
  return res.status(404).json(NOT_FOUND);
}

export function adminLogin(req, res) {
  const expected = getAdminToken();
  const presented = req.query?.token;

  // 开关整个没开。**照样回 404**，不是"这条路由不注册"——不注册的话请求会掉进
  // SPA 兜底拿到 200 + index.html，那本身就是一个"这台机器没开管理员令牌"的判定器。
  if (expected === null) return notFound(res);

  // `?token=a&token=b` 时 Express 给的是数组，落到这里判否。
  if (typeof presented !== 'string' || presented === '') return notFound(res);

  // 定长比较，复用 lib/actor.js 那一份——登录这条路和 resolveActor 校验的是
  // 同一个令牌，各写各的迟早会分叉成一个 `===`。
  if (!timingSafeEqualStr(presented, expected)) return notFound(res);

  // 写进 Cookie 的是 `expected` 而不是 `presented`：两者已经定长相等，
  // 但从配置里取值能保证进响应头的一定是那个配置值，而不是一个来自请求的串。
  res.setHeader('Set-Cookie', serializeCookie(ADMIN_COOKIE, expected, COOKIE_OPTS));

  // 固定的 `/`，**绝不**读任何 `?next=` 之类的参数——那是开放重定向，
  // 而这条路由恰好是钓鱼最想要的那种：一个看起来属于本站的登录链接。
  return res.redirect(302, '/');
}
