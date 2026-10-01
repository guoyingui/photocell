/**
 * 极小的 Cookie 解析与 Set-Cookie 构造。
 *
 * 不引入 cookie-parser：整个协同层只需要一个名字（pc_user）、一个值、四个属性。
 * 多一个运行时依赖就多一份要跟着升级的攻击面，而这一百来行是能一眼读完的。
 */

// RFC 6265 的 cookie-name 是一个 HTTP token。这里用白名单而不是黑名单：
// 只要放进 Set-Cookie 头的名字里带上 CR/LF，就能凭空插出一整条响应头
// （比如再设一个 Path=/ 的同名 Cookie）。白名单让"想不到的字符"默认是拒绝。
const COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

// Path 同理：必须以 / 开头，且不含空白（含 CR/LF）、分号、逗号、引号、反斜杠。
const COOKIE_PATH = /^\/[^\s;,"\\]*$/;

const SAME_SITE = new Map([['lax', 'Lax'], ['strict', 'Strict'], ['none', 'None']]);

function decodeValue(raw) {
  if (!raw.includes('%')) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    // 编码坏掉（比如一个孤立的 %）不该让整个请求 500——原样返回，
    // 反正接下来的令牌查表会把它判成无效身份。
    return raw;
  }
}

/**
 * 解析 Cookie 请求头。没有 header、或者 header 不是字符串时返回空表。
 *
 * 返回的对象故意是无原型的（Object.create(null)）：一个名叫 `__proto__` 的
 * Cookie 在普通对象字面量上做赋值会触发原型 setter，等于让远端请求改写
 * Object.prototype。无原型对象连这个 setter 都没有。
 */
export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || header === '') return out;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;                     // 没有 '=' 的段不是一对键值
    const name = part.slice(0, eq).trim();
    if (name === '') continue;
    // 重名取第一个：影子 Cookie 是真实手法——攻击者在更宽的 Domain/Path 上再设
    // 一个同名 Cookie，指望服务端读到后面那个。取第一个与浏览器的优先顺序一致。
    if (name in out) continue;
    out[name] = decodeValue(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * 构造一条 Set-Cookie 的值。
 *
 * 属性顺序照计划里写死的字面形状：`pc_user=<token>; HttpOnly; SameSite=Lax; Path=/`。
 * 值一律 encodeURIComponent：分号、逗号、空白和全部控制字符都会被编码掉，
 * 所以调用方无论传进来什么都不可能撕开这一行响应头。名字和各属性则是校验后
 * 直接拼接（编码它们没有意义），非法输入直接抛错——静默降级成一条"看起来
 * 没问题但少了 HttpOnly"的 Cookie 是这层最不该有的行为。
 */
export function serializeCookie(name, value, opts = {}) {
  if (typeof name !== 'string' || !COOKIE_NAME.test(name)) {
    throw new TypeError(`非法的 Cookie 名：${JSON.stringify(name)}`);
  }
  if (typeof value !== 'string') {
    throw new TypeError('Cookie 值必须是字符串');
  }

  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (opts.httpOnly) parts.push('HttpOnly');

  if (opts.sameSite !== undefined && opts.sameSite !== null) {
    const canonical = typeof opts.sameSite === 'string'
      ? SAME_SITE.get(opts.sameSite.toLowerCase())
      : undefined;
    if (!canonical) throw new TypeError(`非法的 SameSite：${JSON.stringify(opts.sameSite)}`);
    parts.push(`SameSite=${canonical}`);
  }

  if (opts.path !== undefined && opts.path !== null) {
    if (typeof opts.path !== 'string' || !COOKIE_PATH.test(opts.path)) {
      throw new TypeError(`非法的 Cookie Path：${JSON.stringify(opts.path)}`);
    }
    parts.push(`Path=${opts.path}`);
  }

  // maxAge 必须用 != null 判断：清 Cookie 靠的正是 Max-Age=0，
  // 写成 `if (opts.maxAge)` 会把这唯一有用的取值当成假值丢掉。
  if (opts.maxAge !== undefined && opts.maxAge !== null) {
    if (!Number.isInteger(opts.maxAge)) {
      throw new TypeError(`非法的 Max-Age：${JSON.stringify(opts.maxAge)}`);
    }
    parts.push(`Max-Age=${opts.maxAge}`);
  }

  return parts.join('; ');
}
