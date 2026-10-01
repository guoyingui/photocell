import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createApp, parseArgs, bindHost, setShareMode, listenWithFallback, startupBanner,
  LOOPBACK_HOST, ANY_HOST, shouldOpenBrowser, notifyDesktopReady,
} from './index.js';
import os from 'node:os';
import { setAdminToken, getAdminToken } from './lib/actor.js';

/**
 * 网络暴露层。
 *
 * 这一层守的是整个程序里代价最高的那条边界：服务端能读本机任意路径、能在 move 模式下
 * 删除不可再生的 RAW。把它从"只有坐在这台电脑前的人能碰"变成"局域网里任何人都能连"，
 * 必须是摄影师**显式**做出的决定，不能是一个默认值替他做的。
 *
 * 所以下面四组用例其实是同一件事的四个面：
 *   1. 默认绑回环——不打 --share 就绝不上网。
 *   2. --share 时终端必须把风险说清楚——开了却不知道开了什么，等于没开这个开关。
 *   3. SPA 兜底不能吞掉 /api——吞掉的话所有鉴权失败都会变成一个 200 的 HTML 页面。
 *   4. netaddr 只给真能用的地址——回环地址写进链接发出去，客人打开的是他自己的电脑。
 */

let server;
let base;

/**
 * `server/public/` 是构建产物，`.gitignore` 里排掉了。
 *
 * 兜底那几条要有一个 index.html 才谈得上"返回 index.html"，但在一份刚 clone
 * 出来、还没跑过 `npm run build` 的仓库里它并不存在——照着已有产物写断言的话，
 * 这些用例会在别人的机器上红，而红的原因跟被测的路由行为毫无关系。
 *
 * 所以：没有就自己造一个最小的占位页，跑完删掉；**已经有真的产物就原样用**，
 * 绝不覆盖（那会把开发者刚构建出来的前端换成一张白纸）。
 */
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const indexHtml = path.join(publicDir, 'index.html');
const PLACEHOLDER = '<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>\n';
let placeholderWritten = false;

beforeAll(async () => {
  try {
    await fs.access(indexHtml);
  } catch {
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(indexHtml, PLACEHOLDER);
    placeholderWritten = true;
  }

  server = await new Promise((resolve, reject) => {
    const s = createApp().listen(0, '127.0.0.1');
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  if (placeholderWritten) await fs.rm(indexHtml, { force: true });
});

// 两个都是模块级状态，逐例还原，否则一条用例开了分享会让后面所有用例都以为自己在分享模式。
afterEach(() => {
  setShareMode(false);
  setAdminToken(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 命令行
// ─────────────────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('什么都不给时不分享、不开管理员令牌', () => {
    expect(parseArgs([])).toEqual({ share: false, adminToken: null });
  });

  it('--share 才开分享', () => {
    expect(parseArgs(['--share']).share).toBe(true);
  });

  it.each([
    ['--shar'],
    ['--share=true'],
    ['-share'],
    ['share'],
  ])('拼错的 %s 不算开分享', (arg) => {
    // 落点必须是"不分享"。认不出的开关一律当没给，是这一层唯一可以接受的失败方向：
    // 猜错方向的代价是把一台能删 RAW 的机器挂上局域网。
    expect(parseArgs([arg]).share).toBe(false);
  });

  it.each([
    ['等号形式', ['--admin-token=s3cret'], 's3cret'],
    ['空格形式', ['--admin-token', 's3cret'], 's3cret'],
    ['值里带等号', ['--admin-token=a=b=c'], 'a=b=c'],
  ])('%s 解析出令牌', (_name, argv, want) => {
    expect(parseArgs(argv).adminToken).toBe(want);
  });

  it.each([
    ['空值', ['--admin-token=']],
    ['空格形式后面没有值', ['--admin-token']],
    ['空格形式后面跟的是下一个开关', ['--admin-token', '--share']],
  ])('%s 时令牌为 null（通道整个关闭，不是"空令牌"）', (_name, argv) => {
    expect(parseArgs(argv).adminToken).toBe(null);
  });

  it('--admin-token 后面跟 --share 时，--share 仍然被识别', () => {
    // 前一条确认了这种写法不会把 '--share' 当成令牌值；这一条确认它也没被吃掉。
    expect(parseArgs(['--admin-token', '--share'])).toEqual({ share: true, adminToken: null });
  });

  it('两个开关可以一起给，顺序无关', () => {
    expect(parseArgs(['--admin-token=abc', '--share'])).toEqual({ share: true, adminToken: 'abc' });
    expect(parseArgs(['--share', '--admin-token=abc'])).toEqual({ share: true, adminToken: 'abc' });
  });

  it('认不出的参数被忽略，不影响其它开关', () => {
    expect(parseArgs(['--color=always', '--share', 'extra'])).toEqual({
      share: true, adminToken: null,
    });
  });
});

describe('桌面壳启动协议', () => {
  it('PHOTOCULL_TAURI=1 时不打开系统浏览器', () => {
    expect(shouldOpenBrowser({ PHOTOCULL_TAURI: '1' })).toBe(false);
    expect(shouldOpenBrowser({})).toBe(true);
    expect(shouldOpenBrowser({ PHOTOCULL_TAURI: '0' })).toBe(true);
  });

  it('PHOTOCULL_READY_FILE 有值时把 url 写进去', async () => {
    const dest = path.join(os.tmpdir(), `photocull-ready-test-${process.pid}`);
    try {
      notifyDesktopReady('http://127.0.0.1:5183', { PHOTOCULL_READY_FILE: dest });
      expect(await fs.readFile(dest, 'utf8')).toBe('http://127.0.0.1:5183');
    } finally {
      await fs.rm(dest, { force: true });
    }
  });

  it('没配 PHOTOCULL_READY_FILE 时什么都不写', () => {
    expect(() => notifyDesktopReady('http://127.0.0.1:5183', {})).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 绑哪个地址
// ─────────────────────────────────────────────────────────────────────────────

describe('监听地址', () => {
  it('默认绑回环', () => {
    expect(bindHost()).toBe(LOOPBACK_HOST);
    expect(LOOPBACK_HOST).toBe('127.0.0.1');
  });

  it('只有 --share 才绑 0.0.0.0', () => {
    setShareMode(true);
    expect(bindHost()).toBe(ANY_HOST);
    expect(ANY_HOST).toBe('0.0.0.0');
  });

  it('不带 --share 时真的只监听回环', async () => {
    // 断言的是**真实 socket 绑在哪**，不是某个变量的值：这条边界一旦只由变量
    // 来表达，listen 那行少传一个参数就会悄悄敞开，而所有断言变量的用例照样绿。
    const s = await listenWithFallback(createApp(), 0, 1);
    try {
      expect(s.address().address).toBe('127.0.0.1');
    } finally {
      await new Promise((r) => s.close(r));
    }
  });

  it('带 --share 时监听 0.0.0.0', async () => {
    setShareMode(true);
    const s = await listenWithFallback(createApp(), 0, 1);
    try {
      expect(s.address().address).toBe('0.0.0.0');
    } finally {
      await new Promise((r) => s.close(r));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 启动横幅
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL_URL = 'http://127.0.0.1:5183';
const ADDRS = [
  { address: '192.168.1.23', family: 'IPv4', interface: 'en0' },
  { address: '10.0.0.5', family: 'IPv4', interface: 'en1' },
];

describe('startupBanner', () => {
  it('总是给出本机地址', () => {
    expect(startupBanner({ share: false, url: LOCAL_URL })).toContain(LOCAL_URL);
    expect(startupBanner({ share: true, url: LOCAL_URL, addresses: ADDRS })).toContain(LOCAL_URL);
  });

  it('没开分享时说明当前不可分享，并给出开启命令', () => {
    const text = startupBanner({ share: false, url: LOCAL_URL, addresses: ADDRS });
    expect(text).toContain('--share');
    // 没开分享就绝不列出局域网地址：列了等于邀请人去试，而那些地址此刻一个都连不上。
    expect(text).not.toContain('192.168.1.23');
  });

  it('没开分享时不出现任何局域网风险告警', () => {
    // 告警要留在它真正成立的那一刻。天天喊狼来了的横幅，--share 那天没人会读。
    const text = startupBanner({ share: false, url: LOCAL_URL, addresses: ADDRS });
    expect(text).not.toContain('局域网内任何人');
  });

  it('--share 时打印醒目告警：拿到链接就能看这些照片', () => {
    const text = startupBanner({ share: true, url: LOCAL_URL, addresses: ADDRS });
    expect(text).toContain('局域网内任何人');
    expect(text).toContain('链接');
    expect(text).toContain('照片');
  });

  it('--share 时同时说明是 HTTP 明文、同网段可被抓包', () => {
    const text = startupBanner({ share: true, url: LOCAL_URL, addresses: ADDRS });
    expect(text).toContain('明文');
    expect(text).toContain('抓包');
  });

  it('--share 时列出检测到的每一个网卡地址', () => {
    const text = startupBanner({ share: true, url: LOCAL_URL, addresses: ADDRS });
    expect(text).toContain('192.168.1.23');
    expect(text).toContain('10.0.0.5');
    expect(text).toContain('en0');
  });

  it('--share 但一个局域网地址都没检测到时，明说没检测到', () => {
    const text = startupBanner({ share: true, url: LOCAL_URL, addresses: [] });
    expect(text).toContain('没有检测到');
    // 这种情况下告警依然要在：绑了 0.0.0.0 就是绑了，探测不到地址不代表没暴露。
    expect(text).toContain('局域网内任何人');
  });

  it('--share 且没配 --admin-token 时，警告不要放在同机反向代理后面', () => {
    // 同机反代（nginx / Caddy 反代 localhost）会让每个转发请求的源地址都是回环。
    // 转发头否决挡住了绝大多数情况，但一个**不加任何转发头**的代理仍然能把访客
    // 变成管理员——这条横幅是那种配置唯一的知情同意环节。
    const text = startupBanner({ share: true, url: LOCAL_URL, addresses: ADDRS });
    expect(text).toContain('反向代理');
    // 出路也要说，否则这条警告只能让人放弃部署。刻意不写出开关的字面名字：
    // 那会和"已启用"那一段混成一样，见 startupBanner 里的注释。
    expect(text).toContain('管理员令牌');
    expect(text).not.toContain('--admin-token');
  });

  it('--share 且已配 --admin-token 时不再重复那条反向代理警告', () => {
    // 配了令牌之后回环本身就不再授予管理员身份，这个坑已经被堵上了；
    // 继续喊一遍只会稀释真正还成立的那几条告警。
    // 断言的是那条**劝阻**本身不在（"不要这么部署"），不是"反向代理"这四个字不在：
    // 启用令牌那一段会顺带解释这个开关为什么存在，那里提到反向代理是应该的。
    const text = startupBanner({ share: true, url: LOCAL_URL, addresses: ADDRS, adminToken: 'super-secret-token' });
    expect(text).not.toContain('不要把这个服务放在');
  });

  it('没开分享时不出现反向代理警告', () => {
    const text = startupBanner({ share: false, url: LOCAL_URL, addresses: ADDRS });
    expect(text).not.toContain('反向代理');
    expect(text).not.toContain('不要把这个服务放在');
  });

  it('启用管理员令牌时，明说本机浏览器从此也不再自动是管理员', () => {
    // 这是设了这个开关之后最容易把人卡死的一件事：回环不再算管理员，
    // 而本机浏览器设不了自定义请求头。不写出来的话，摄影师看到的是
    // "刚才还好好的，加了个参数整个界面就全是 403"。
    const text = startupBanner({ share: true, url: LOCAL_URL, addresses: ADDRS, adminToken: 'x' });
    expect(text).toContain('本机浏览器');
    expect(text).toContain('不再');
  });

  /**
   * 令牌在终端里的唯一一处出场：那条一次性登录 URL。
   *
   * Global Constraints 原文是"令牌绝不出现在终端输出里"，这次改成了
   * "除了这条一次性登录 URL"。理由是这条例外**不开就等于这个开关不存在**：
   * 浏览器没有办法给导航请求加自定义请求头，`X-PhotoCull-Admin` 对任何浏览器
   * 都不可用；而设了 --admin-token 之后回环也不再算管理员。不打印这条 URL，
   * 摄影师（包括规格 §9.3 点名的"从其他电脑管理"）就没有任何进得来的路。
   *
   * 例外只到这里为止：审计日志、错误响应、以及横幅里除这条 URL 之外的每一个字，
   * 仍然一律不含令牌。下面这条用例钉的正是这个边界——不是"令牌不出现"，
   * 而是"令牌每一次出现都紧跟在 /admin-login?token= 后面"。
   */
  it('令牌只出现在那条登录 URL 里，别处一个字都不出现', () => {
    const token = 'super-secret-token';
    const text = startupBanner({ share: true, url: LOCAL_URL, addresses: ADDRS, adminToken: token });

    expect(text).toContain('--admin-token');
    expect(text).toContain(`/admin-login?token=${token}`);

    // 逐处检查：每一个出现位置的前面都必须正好是那段前缀。
    const prefix = '/admin-login?token=';
    let at = text.indexOf(token);
    let occurrences = 0;
    while (at !== -1) {
      occurrences += 1;
      expect(text.slice(at - prefix.length, at)).toBe(prefix);
      at = text.indexOf(token, at + 1);
    }
    expect(occurrences).toBeGreaterThan(0);
  });

  it('登录 URL 用的是本机地址和真实端口', () => {
    const text = startupBanner({ share: true, url: LOCAL_URL, addresses: ADDRS, adminToken: 'tok' });
    expect(text).toContain(`${LOCAL_URL}/admin-login?token=tok`);
  });

  it('--share 时说明怎么从其他电脑连接（"从其他电脑管理"就是这个开关的用途）', () => {
    const text = startupBanner({ share: true, url: LOCAL_URL, addresses: ADDRS, adminToken: 'tok' });
    expect(text).toContain('其他电脑');
    // 换的只有主机名那一段，所以给的是路径，接在上面列出的客人地址后面。
    expect(text).toContain('/admin-login?token=tok');
  });

  /**
   * 令牌是一个密码，它在屏幕上出现的次数必须与网卡数量无关。
   *
   * 真机上 lanAddresses() 能探出十来个地址（多网卡 + 轮换的临时 IPv6，
   * 见 Task 13 报告里的实测）。按网卡逐条印完整登录 URL 的话，一个密码会在
   * 终端里重复十几次——更容易被整屏截进图里，也把"这东西等同于管理员密码"
   * 那句话彻底淹掉。所以断言的是次数**不随地址数量增长**。
   */
  it('令牌出现的次数与网卡数量无关：两个地址和十个地址一样多', () => {
    const count = (text) => text.split('tok-xyz').length - 1;
    const many = Array.from({ length: 10 }, (_, i) => ({
      address: `10.0.0.${i}`, family: 'IPv4', interface: `en${i}`,
    }));

    const few = count(startupBanner({ share: true, url: LOCAL_URL, addresses: ADDRS, adminToken: 'tok-xyz' }));
    const lots = count(startupBanner({ share: true, url: LOCAL_URL, addresses: many, adminToken: 'tok-xyz' }));

    expect(few).toBeGreaterThan(0);
    expect(lots).toBe(few);
  });

  it('没开分享时不讲怎么从其他电脑连接——那些地址此刻一个都连不上', () => {
    const text = startupBanner({ share: false, url: LOCAL_URL, addresses: ADDRS, adminToken: 'tok' });
    expect(text).toContain(`${LOCAL_URL}/admin-login?token=tok`);
    expect(text).not.toContain('192.168.1.23');
    expect(text).not.toContain('其他电脑');
  });

  it('登录 URL 里的令牌是 URL 编码过的，否则 & 之后的部分会被吃掉', () => {
    const text = startupBanner({ share: false, url: LOCAL_URL, adminToken: 'a&b c' });
    expect(text).toContain('/admin-login?token=a%26b%20c');
  });

  it('明说这条 URL 等同于管理员密码、用完就丢', () => {
    // 这条 URL 是终端里唯一的令牌出场处，那它必须自带说明书：
    // 不说清楚的话它会被截图、被贴进聊天窗口、被存成书签，
    // 而它跟管理员密码是同一个东西。
    const text = startupBanner({ share: true, url: LOCAL_URL, addresses: ADDRS, adminToken: 'tok' });
    expect(text).toContain('等同于管理员密码');
    expect(text).toContain('用完就丢');
  });

  it('说明打开之后令牌进 Cookie、不留在地址栏', () => {
    const text = startupBanner({ share: false, url: LOCAL_URL, adminToken: 'tok' });
    expect(text).toContain('Cookie');
    expect(text).toContain('地址栏');
  });

  it('没配管理员令牌时不提它，也不提登录入口', () => {
    const text = startupBanner({ share: true, url: LOCAL_URL, addresses: ADDRS, adminToken: null });
    expect(text).not.toContain('--admin-token');
    expect(text).not.toContain('admin-login');
  });

  it('横幅里没有裸控制字符（终端转义会污染日志和管道输出）', () => {
    const text = startupBanner({ share: true, url: LOCAL_URL, addresses: ADDRS, adminToken: 'x' });
    const NEWLINE = 10;
    const TAB = 9;
    const DEL = 127;
    const offenders = [...text].filter((ch) => {
      const code = ch.codePointAt(0);
      if (code === NEWLINE || code === TAB) return false;
      return code < 32 || code === DEL;
    });
    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPA 兜底
// ─────────────────────────────────────────────────────────────────────────────

describe('SPA 兜底', () => {
  it('根路径返回 index.html', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  });

  it.each(['/s/abc123', '/admin', '/deep/unknown/path'])('%s 返回 index.html（前端自己分发路由）', async (p) => {
    const res = await fetch(`${base}${p}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  });

  it('不吞掉 /api：不存在的接口是 404 JSON，不是 index.html', async () => {
    // 吞掉的话每一个打错的接口路径都会拿到 200 + 一整页 HTML。前端 fetch 拿到它
    // 会在 JSON.parse 上炸，报错指向前端；而真正的问题在服务端路由表里。
    const res = await fetch(`${base}/api/definitely-not-a-route`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('%s 到不存在的 /api 路径同样是 404 JSON', async (method) => {
    // SPA 兜底只挂在 GET 上，非 GET 方法走的是另一条路径，要单独钉住。
    const res = await fetch(`${base}/api/definitely-not-a-route`, { method });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('/api 前缀下的 404 响应体里没有 HTML', async () => {
    const res = await fetch(`${base}/api/nope/nested/deeper`);
    const text = await res.text();
    expect(text.toLowerCase()).not.toContain('<html');
    expect(text.toLowerCase()).not.toContain('<!doctype');
  });

  it('/admin-login 不被兜底吞掉：没配令牌时是 404，不是 index.html', async () => {
    // 兜底一旦接走它，"开关没开"就会表现成 200 + 一整页 HTML，
    // 而"令牌带错了"是 404——两者一对比就成了"这台机器开没开令牌"的探测器。
    const res = await fetch(`${base}/admin-login?token=whatever`, { redirect: 'manual' });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('<div id="root">');
  });

  it('真实存在的 /api 路由不受兜底影响', async () => {
    // 对照组。上面几条在整个 /api 都挂掉的情况下也会绿。
    const res = await fetch(`${base}/api/fs/roots`);
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).roots)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/netaddr
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/netaddr', () => {
  const get = () => fetch(`${base}/api/admin/netaddr`).then((r) => r.json());

  it('返回地址列表、当前端口和分享状态', async () => {
    const body = await get();
    expect(Array.isArray(body.addresses)).toBe(true);
    expect(body.port).toBe(server.address().port);
    expect(body.share).toBe(false);
  });

  it('share 字段跟着 --share 走（分享面板据此决定是给链接还是给重启提示）', async () => {
    setShareMode(true);
    expect((await get()).share).toBe(true);
  });

  it('不返回回环地址和 IPv6 链路本地地址', async () => {
    for (const entry of (await get()).addresses) {
      expect(entry.address).not.toBe('127.0.0.1');
      expect(entry.address).not.toBe('::1');
      expect(entry.address.toLowerCase().startsWith('fe8')).toBe(false);
    }
  });

  it('每一项都带 address / family / interface', async () => {
    for (const entry of (await get()).addresses) {
      expect(typeof entry.address).toBe('string');
      expect(['IPv4', 'IPv6']).toContain(entry.family);
      expect(typeof entry.interface).toBe('string');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// --admin-token 接线
// ─────────────────────────────────────────────────────────────────────────────

describe('--admin-token 接到 actor.js', () => {
  it('解析出来的令牌会被装进 actor 模块', () => {
    // Task 6 给 setAdminToken 留了口子，在此之前没有任何生产调用方——
    // 也就是说 resolveActor 里那条"带对头就是管理员"的分支一直是死的。
    // 这条用例钉住的是"启动路径确实把它接上了"。
    const { adminToken } = parseArgs(['--admin-token=from-cli']);
    setAdminToken(adminToken);
    expect(getAdminToken()).toBe('from-cli');
  });

  it('没给这个开关时通道保持关闭', () => {
    setAdminToken(parseArgs([]).adminToken);
    expect(getAdminToken()).toBe(null);
  });
});
