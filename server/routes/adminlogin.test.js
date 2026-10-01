import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.js';
import { setAdminToken, ADMIN_COOKIE } from '../lib/actor.js';
import { ADMIN_LOGIN_PATH } from './adminlogin.js';

/**
 * `GET /admin-login?token=…` —— `--admin-token` 唯一一条浏览器进得来的入口。
 *
 * 这条路由存在的理由：浏览器**没有办法**给导航请求加自定义请求头，所以
 * `X-PhotoCull-Admin` 这条通道对任何浏览器（包括规格 §9.3 点名的电脑浏览器）
 * 都是不可用的。而设了 `--admin-token` 之后回环本身不再授予管理员身份，
 * 于是这个开关一开，摄影师连自己本机的界面都是满屏 403。
 * 一个文档写着"给摄影师从其他电脑管理用"、却对所有浏览器都不工作的开关是坏的。
 *
 * 这个文件里有两条性质是不可协商的：
 *
 *   1. **失败一律 404，且三种失败逐字节一致**（开关没开 / 没带 token / 带错了）。
 *      任何差异都会变成一个"这台机器开没开管理员令牌"的探测器。
 *   2. **令牌进 Cookie，不进地址栏**：302 回固定的 `/`，Cookie 是
 *      httpOnly + SameSite=Lax + Path=/。
 */

/** 伪造的源地址。刻意不是回环——这条入口的全部意义就是"从别的设备进来"。 */
const GUEST_IP = '192.168.1.50';

/** 43 字符，长度和形状都跟真实的 base64url 令牌一致。 */
const TOKEN = 'Zm9vYmFyLWFkbWluLXRva2VuLTMyYnl0ZXMtcmFuZG9t';

let server;
let base;
let home;
let savedHome;
let remoteOverride = GUEST_IP;

beforeAll(async () => {
  const app = createApp();
  // 只换掉 req.socket.remoteAddress 这一个字段——它正是 isLoopback() 唯一读的东西。
  // 做法与 share.test.js / permissions.test.js 一致，请求仍然走真实 TCP。
  server = http.createServer((req, res) => {
    delete req.socket.remoteAddress;
    Object.defineProperty(req.socket, 'remoteAddress', {
      value: remoteOverride, configurable: true,
    });
    app(req, res);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  savedHome = process.env.PHOTOCULL_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-adminlogin-'));
  process.env.PHOTOCULL_HOME = home;
  remoteOverride = GUEST_IP;
});

afterEach(async () => {
  setAdminToken(null);          // 模块级状态，逐例还原
  if (savedHome === undefined) delete process.env.PHOTOCULL_HOME;
  else process.env.PHOTOCULL_HOME = savedHome;
  await fs.rm(home, { recursive: true, force: true });
});

/** 永远不跟随重定向：跟随了就看不到 302 本身，也看不到那一枚 Set-Cookie。 */
function login(query) {
  const suffix = query === undefined ? '' : `?${query}`;
  return fetch(`${base}${ADMIN_LOGIN_PATH}${suffix}`, { redirect: 'manual' });
}

const setCookieOf = (res) => res.headers.get('set-cookie');

// ─────────────────────────────────────────────────────────────────────────────
// 正确令牌
// ─────────────────────────────────────────────────────────────────────────────

describe(`GET ${ADMIN_LOGIN_PATH}：正确令牌`, () => {
  beforeEach(() => setAdminToken(TOKEN));

  it('302 重定向到 /，令牌不留在地址栏里', async () => {
    const res = await login(`token=${TOKEN}`);
    expect(res.status).toBe(302);
    // 固定的 '/'，不是任何来自请求的值：读 ?next= 之类的参数就是开放重定向。
    expect(res.headers.get('location')).toBe('/');
    // 令牌不留在地址栏 = 不留在浏览器历史、不被下一跳的 Referer 带走。
    expect(res.headers.get('location')).not.toContain(TOKEN);
  });

  it('下发 pc_admin Cookie，值就是那个令牌', async () => {
    const cookie = setCookieOf(await login(`token=${TOKEN}`));
    expect(cookie).toContain(`${ADMIN_COOKIE}=${TOKEN}`);
  });

  it('Cookie 是 HttpOnly——XSS 拿不到管理员令牌', async () => {
    // 这枚 Cookie 等同于管理员密码。少了 HttpOnly，任何一处 XSS 都能把它
    // document.cookie 出来，攻击者就拿到了浏览整块硬盘、触发导出的权限。
    expect(setCookieOf(await login(`token=${TOKEN}`))).toContain('HttpOnly');
  });

  it('Cookie 是 SameSite=Lax——跨站请求带不上它（CSRF 第一道防线）', async () => {
    expect(setCookieOf(await login(`token=${TOKEN}`))).toContain('SameSite=Lax');
  });

  it('Cookie 是 Path=/——整站的 /api 请求都带得上', async () => {
    expect(setCookieOf(await login(`token=${TOKEN}`))).toContain('Path=/');
  });

  it('不设 Max-Age：这是一枚会话 Cookie，浏览器关掉就没了', async () => {
    const cookie = setCookieOf(await login(`token=${TOKEN}`));
    expect(cookie).not.toContain('Max-Age');
    expect(cookie).not.toContain('Expires');
  });

  it('从回环进来同样管用——设了令牌之后本机浏览器也得走这条路', async () => {
    // 这是这次修复要解决的那个具体症状：设了 --admin-token 之后，
    // 摄影师自己本机打开 127.0.0.1 会满屏 403，因为回环不再算管理员。
    remoteOverride = '127.0.0.1';
    const res = await login(`token=${TOKEN}`);
    expect(res.status).toBe(302);
    expect(setCookieOf(res)).toContain(ADMIN_COOKIE);
  });

  it('带尾斜杠的 /admin-login/ 同样管用', async () => {
    // defaultDeny 的白名单正则写的是 /^\/admin-login\/?$/，Express 的非严格路由
    // 也认这个尾斜杠。两边必须一致：一边认一边不认，就是一条"有时候登不进去"的路。
    const res = await fetch(`${base}${ADMIN_LOGIN_PATH}/?token=${TOKEN}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(setCookieOf(res)).toContain(ADMIN_COOKIE);
  });

  it('响应体里没有令牌', async () => {
    expect(await (await login(`token=${TOKEN}`)).text()).not.toContain(TOKEN);
  });

  it('拿着这枚 Cookie 就是管理员（端到端）', async () => {
    const cookie = setCookieOf(await login(`token=${TOKEN}`)).split(';')[0];

    // 对照：不带 Cookie 时，这个非回环来源没有任何身份 -> defaultDeny 的 401。
    const anon = await fetch(`${base}/api/admin/netaddr`);
    expect(anon.status).toBe(401);

    const asAdmin = await fetch(`${base}/api/admin/netaddr`, { headers: { cookie } });
    expect(asAdmin.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 开放重定向：重定向目标写死为 '/'
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 规格 §9.3 点名过这条风险，源码注释也写着"**绝不**读任何 `?next=` 之类的参数"，
 * 但在补上这一组之前**没有任何测试守着它**：把 `res.redirect(302, '/')` 改成
 * `res.redirect(302, req.query.next ?? '/')`，全量 1175 条一条不红。
 *
 * 为什么这条路由格外值得钓鱼：它是一个**看起来完全属于本站**的登录链接，
 * 而且摄影师本来就被教育成"点这条链接就能登进管理界面"。一条
 * `http://127.0.0.1:5183/admin-login?token=<真令牌>&next=https://evil.example.com/`
 * 会真的登录成功、真的种下管理员 Cookie，然后把人送到攻击者的页面上——
 * 用户看到的全过程是"我登录了，然后跳转了"，没有任何一步看起来不对。
 *
 * 所以断言的不是"某几个参数名不被读"，而是**重定向目标恒等于 `/`**：
 * 参数名可以有无穷多个，落点只有一个。
 */
describe(`GET ${ADMIN_LOGIN_PATH}：永远重定向到 /`, () => {
  beforeEach(() => setAdminToken(TOKEN));

  it.each([
    ['next 绝对 URL', `next=${encodeURIComponent('https://evil.example.com/')}`],
    ['next 协议相对 URL', `next=${encodeURIComponent('//evil.example.com/')}`],
    ['next 反斜杠变体', `next=${encodeURIComponent('/\\evil.example.com')}`],
    ['next 站内路径', 'next=%2Fadmin'],
    ['next 空值', 'next='],
    ['redirect', `redirect=${encodeURIComponent('https://evil.example.com/')}`],
    ['returnTo', `returnTo=${encodeURIComponent('https://evil.example.com/')}`],
    ['url', `url=${encodeURIComponent('https://evil.example.com/')}`],
    ['next 排在 token 前面', `next=${encodeURIComponent('https://evil.example.com/')}`],
  ])('带 %s 时仍然只跳 /', async (_label, extra) => {
    const res = await login(`${extra}&token=${TOKEN}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  it('同一个参数出现多次（Express 给的是数组）也不影响落点', async () => {
    const res = await login(`next=%2Fa&next=%2Fb&token=${TOKEN}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  /** 兜底断言：无论查询串长什么样，Location 里都不会出现请求里的任何一段。 */
  it('Location 里不含请求带来的任何一段字符串', async () => {
    const marker = 'evil-marker-9f3a';
    const res = await login(`next=${marker}&from=${marker}&token=${TOKEN}`);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('location')).not.toContain(marker);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 失败：一律 404，且互相之间逐字节一致
// ─────────────────────────────────────────────────────────────────────────────

describe(`GET ${ADMIN_LOGIN_PATH}：失败一律 404`, () => {
  it('令牌不对 -> 404，且不下发任何 Cookie', async () => {
    setAdminToken(TOKEN);
    const res = await login(`token=${TOKEN.slice(0, -1)}X`);   // 等长但不相等
    expect(res.status).toBe(404);
    expect(setCookieOf(res)).toBe(null);
  });

  it.each([
    ['少一位', TOKEN.slice(0, -1)],
    ['多一位', `${TOKEN}x`],
    ['空串', ''],
    ['一个字符', 'x'],
  ])('长度不等的令牌（%s）-> 404', async (_name, presented) => {
    setAdminToken(TOKEN);
    expect((await login(`token=${presented}`)).status).toBe(404);
  });

  it('根本没配 --admin-token 时 -> 404', async () => {
    // 开关没开，这条路由就该像不存在一样。注意它**仍然是注册着的**：
    // 不注册的话请求会掉进 SPA 兜底拿到 200 + index.html，那本身就是一个
    // "这台机器没开管理员令牌"的判定器。
    expect((await login(`token=${TOKEN}`)).status).toBe(404);
  });

  it('完全没带 token 参数 -> 404', async () => {
    setAdminToken(TOKEN);
    expect((await login()).status).toBe(404);
  });

  it('token 出现多次（Express 给的是数组）-> 404', async () => {
    setAdminToken(TOKEN);
    expect((await login(`token=${TOKEN}&token=${TOKEN}`)).status).toBe(404);
  });

  /**
   * 这一条是这个文件里最要紧的：**"开关没开"和"令牌带错了"的响应必须一致**。
   * 差一个字节，外面的人就能拿这条路由去探测这台机器有没有开管理员令牌——
   * 而那正是"要不要花力气猜令牌"的第一个问题。
   */
  it('"开关没开"和"令牌带错了"的 404 逐字节一致', async () => {
    setAdminToken(null);
    const off = await login(`token=${TOKEN}`);
    const offBody = await off.text();

    setAdminToken(TOKEN);
    const wrong = await login(`token=${TOKEN.slice(0, -1)}X`);
    const wrongBody = await wrong.text();

    expect(wrong.status).toBe(off.status);
    expect(wrongBody).toBe(offBody);
    expect(wrong.headers.get('content-type')).toBe(off.headers.get('content-type'));
    expect(setCookieOf(wrong)).toBe(setCookieOf(off));
  });

  it('404 响应体里没有令牌', async () => {
    setAdminToken(TOKEN);
    const body = await (await login(`token=${TOKEN.slice(0, -1)}X`)).text();
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain(TOKEN.slice(0, -1));
  });

  it('404 不是 SPA 兜底那一页 HTML', async () => {
    // 兜底会回 200 + index.html。那是"这个路径不存在"之外的第三种表现，
    // 一眼就能看出这条路由是真的存在的。
    setAdminToken(TOKEN);
    const res = await login('token=nope');
    expect(res.status).toBe(404);
    expect((await res.text()).toLowerCase()).not.toContain('<!doctype');
  });

  it('POST 到这条路径不下发 Cookie——登录只走 GET', async () => {
    setAdminToken(TOKEN);
    const res = await fetch(`${base}${ADMIN_LOGIN_PATH}?token=${TOKEN}`, {
      method: 'POST', redirect: 'manual',
    });
    expect(setCookieOf(res)).toBe(null);
    expect(res.status).not.toBe(302);
  });
});
