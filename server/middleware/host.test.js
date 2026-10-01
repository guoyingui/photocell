import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.js';
import { lanAddresses } from '../lib/netaddr.js';
import { closeAllSessions } from '../lib/session.js';

/**
 * DNS 重绑定：`Host` 头校验。
 *
 * 这一组必须走**真实的 TCP 连接**，而且必须自己拼 `Host` 头——`fetch()` 不让设
 * （`Host` 是 forbidden header），而这条防线要防的恰恰是"源地址真的是回环、
 * `Host` 却是别人的域名"这一种组合。用 `http.request` 显式传 `headers.host`
 * 能精确造出它：TCP 上是本机连本机，头里写着 evil.example.com——
 * 和浏览器在重绑定之后发出来的东西逐字节一致。
 *
 * 每一条用例的靶子都挑 `/api/fs/roots`：它是 admin-only 的，而且回答的是
 * "这台机器上有哪些可浏览的根"。攻击页面读到它，下一步就是遍历整块硬盘。
 */

let server;
let port;
let home;
let savedHome;

beforeAll(async () => {
  savedHome = process.env.PHOTOCULL_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-host-home-'));
  process.env.PHOTOCULL_HOME = home;

  // 真的绑在 127.0.0.1 上，不伪造 remoteAddress：这一组的前提正是
  // "源地址货真价实是回环"，伪造它反而测不到要测的东西。
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;
});

afterAll(async () => {
  await closeAllSessions();
  await new Promise((r) => server.close(r));
  if (savedHome === undefined) delete process.env.PHOTOCULL_HOME;
  else process.env.PHOTOCULL_HOME = savedHome;
  await fs.rm(home, { recursive: true, force: true });
});

/** 一次真实请求，`host` 为 undefined 时用 Node 自己生成的那一个。 */
function request({ method = 'GET', reqPath = '/api/fs/roots', host, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host !== undefined) headers.host = host;
    if (body !== null) headers['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/**
 * 手写一条 HTTP/1.0 请求，`Host` 头**逐字节由调用方决定**（包括一个都不发）。
 *
 * `http.request` 做不到这两件事：不给 `headers.host` 它就自己补一个，
 * 给一个空串它认为是"没给"、照样自己补。而"没有 Host"和"Host 是空的"
 * 恰好是这条防线两端的边界——一端必须放行（HTTP/1.0 的正常请求），
 * 另一端必须拒绝（一个我们无法确认的名字）。
 */
function rawRequest({ reqPath = '/api/fs/roots', headerLines = [] } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${reqPath} HTTP/1.0\r\n${headerLines.map((l) => `${l}\r\n`).join('')}\r\n`);
    });
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (c) => { buf += c; });
    socket.on('error', reject);
    socket.on('end', () => {
      const status = Number.parseInt(buf.slice('HTTP/1.1 '.length, 'HTTP/1.1 '.length + 3), 10);
      resolve({ status, body: buf.slice(buf.indexOf('\r\n\r\n') + 4) });
    });
  });
}

const json = (res) => { try { return JSON.parse(res.body); } catch { return {}; } };

describe('Host 头校验：DNS 重绑定', () => {
  /**
   * 这条用例是整组的前提，也是"为什么非挡不可"的证据：同一条 TCP 连接、
   * 同一个源地址、没有任何转发头，服务端如实判成 admin 并交出管理员数据。
   * 攻击者要做的只是让浏览器**替他**发出这样一条请求——重绑定就是干这个的。
   */
  it('前提：真回环 + 正确的 Host -> 管理员数据照常给', async () => {
    const res = await request({ host: `127.0.0.1:${port}` });
    expect(res.status).toBe(200);
    expect(Array.isArray(json(res).roots)).toBe(true);
  });

  it('Host 是攻击者的域名 -> 403 bad-host（源地址仍然是货真价实的回环）', async () => {
    const res = await request({ host: `evil.example.com:${port}` });
    expect(res.status).toBe(403);
    expect(json(res).error).toBe('bad-host');
  });

  it.each([
    ['不带端口的域名', 'attacker.test'],
    ['子域名', `a.b.evil.example.com:PORT`],
    ['长得像回环的域名', `127.0.0.1.evil.example.com:PORT`],
    ['把回环拼在域名里', `evil.example.com.127.0.0.1:PORT`],
    ['裸 IPv6（没套方括号，无从判断端口）', '::1:PORT'],
  ])('%s -> 403', async (_label, host) => {
    const res = await request({ host: host.replace('PORT', String(port)) });
    expect(res.status).toBe(403);
    expect(json(res).error).toBe('bad-host');
  });

  /**
   * 空的 `Host:` 和**没有** `Host:` 必须分开处理，这是两件事：
   * 后者是 HTTP/1.0 的正常请求（放行，见下一组），前者是一个我们无法
   * 确认的名字——"不确定的一律拒绝"。
   */
  it('Host 头存在但是空的 -> 403', async () => {
    const res = await rawRequest({ headerLines: ['Host:'] });
    expect(res.status).toBe(403);
    expect(json(res).error).toBe('bad-host');
  });

  /**
   * **不只挡 /api。** 挡住 HTML 本身，被重绑定的那个页面连启动都启动不了；
   * 只挡 /api 的话攻击页面照样能把首页当成同源资源读走。
   */
  it.each([['/'], ['/index.html'], ['/s/some-token'], ['/admin-login?token=x']])(
    '静态 / SPA 路径 %s 同样挡',
    async (reqPath) => {
      const res = await request({ reqPath, host: 'evil.example.com' });
      expect(res.status).toBe(403);
    },
  );

  /**
   * 写请求也一样，而且这一条是代价最高的：`POST /api/export {mode:'move'}`
   * 会在校验通过后删掉源 RAW。它挂在 Host 这一层，`express.json()` 都还没跑到。
   */
  it('POST /api/export 在解析请求体之前就被挡下', async () => {
    const res = await request({
      method: 'POST', reqPath: '/api/export', host: 'evil.example.com',
      body: JSON.stringify({ destRoot: os.tmpdir(), mode: 'move', confirmCount: 0 }),
    });
    expect(res.status).toBe(403);
    expect(json(res).error).toBe('bad-host');
  });
});

describe('Host 头校验：放行哪些', () => {
  it.each([
    ['127.0.0.1'],
    ['localhost'],
    // 主机名不分大小写（RFC 4343）。浏览器不会这么发，但代理和脚本会。
    ['LocalHost'],
    // macOS 上给别名接口配 127.0.0.2 是常见做法，整个 127.0.0.0/8 都算回环。
    ['127.0.0.2'],
    ['[::1]'],
    // IPv4 映射地址。带方括号才谈得上端口——裸写 `::ffff:127.0.0.1:5183`
    // 无从判断最后一段是端口还是地址的一部分，那种形状在上面被判否。
    ['[::ffff:127.0.0.1]'],
  ])('Host: %s:<本连接的端口> 放行', async (host) => {
    const res = await request({ host: `${host}:${port}` });
    expect(res.status).toBe(200);
  });

  /**
   * `--share` 之后客人用的正是这些地址（启动横幅逐条印出来的那几行）。
   * 少了这一条，开了分享等于谁都进不来——这一层就从安全措施变成了故障。
   */
  it('本机各网卡地址放行', async () => {
    const addresses = lanAddresses();
    if (addresses.length === 0) return;   // 没连网的机器上无从验证，跳过
    for (const entry of addresses) {
      const host = entry.family === 'IPv6' ? `[${entry.address}]` : entry.address;
      const res = await request({ host: `${host}:${port}` });
      expect(res.status, `Host: ${host}:${port}`).toBe(200);
    }
  });

  it('端口对不上 -> 403（同一台机器上的另一个服务不算数）', async () => {
    const res = await request({ host: `127.0.0.1:${port + 1}` });
    expect(res.status).toBe(403);
    expect(json(res).error).toBe('bad-host');
  });

  it('主机名对、但完全不带端口 -> 403（默认端口 80 不是我们这一个）', async () => {
    const res = await request({ host: '127.0.0.1' });
    expect(res.status).toBe(403);
  });

  /**
   * 没有 `Host` 头的请求**放行**，这是一条有意留的口子。
   *
   * HTTP/1.0 允许不带，而这一层要防的是浏览器：浏览器发出的每一个请求都必然
   * 带 Host（HTTP/1.1 强制，HTTP/2 的 :authority 伪头被 Node 填进 headers.host）。
   * 一条不带 Host 的请求不可能来自被重绑定的页面，挡它只会误伤 curl 和健康检查。
   */
  it('HTTP/1.0 不带 Host 的请求放行', async () => {
    const res = await rawRequest();
    expect(res.status).toBe(200);
  });
});

/**
 * `*.local`（Bonjour / mDNS 名）。
 *
 * 为什么放行它不削弱这一层：`.local` 由 RFC 6762 保留给 mDNS，**不走 DNS 层级**，
 * 也不是根区里可委派的 TLD——没有人能去注册一个 `.local` 名字。而 DNS 重绑定
 * 的整条攻击链恰恰建立在"攻击者拿自己的权威 DNS 服务器改答案"上，那个能力
 * 对 `.local` **根本使不上**。
 *
 * 残余风险只剩同一个局域网内的 mDNS 抢名，可那种攻击者本来就能直接打 IP，
 * 绕开这个名字。换句话说：这条口子没有给攻击者任何他原本没有的东西。
 *
 * 而收紧它的代价是实打实的：客人用 `http://某某的-MacBook.local:5183` 进来会
 * 撞 403，且**看不出为什么**，也没有降级路径。
 */
describe('Host 头校验：*.local（mDNS 名）', () => {
  it('放行 macbook.local', async () => {
    const res = await request({ host: `macbook.local:${port}` });
    expect(res.status).toBe(200);
  });

  it('放行时不分大小写（主机名本来就不分）', async () => {
    const res = await request({ host: `MacBook.LOCAL:${port}` });
    expect(res.status).toBe(200);
  });

  it('放行带连字符的真实 Bonjour 名', async () => {
    const res = await request({ host: `guo-de-MacBook-Pro.local:${port}` });
    expect(res.status).toBe(200);
  });

  it('端口照样要对得上（放行的是名字，不是这一整类请求）', async () => {
    const res = await request({ host: `macbook.local:${port + 1}` });
    expect(res.status).toBe(403);
    expect(json(res).error).toBe('bad-host');
  });

  it('光一个 .local 不放行（空标签不是主机名）', async () => {
    const res = await request({ host: `.local:${port}` });
    expect(res.status).toBe(403);
  });

  it('叫 local 但不是 .local 后缀的不放行', async () => {
    for (const host of ['local', 'notlocal', 'local.evil.com', 'evil.com']) {
      const res = await request({ host: `${host}:${port}` });
      expect(res.status, `Host: ${host}`).toBe(403);
    }
  });

  /**
   * **`.local` 出现在中间不算数，必须是后缀。**
   *
   * 这条是这一组里唯一真正防攻击的用例，其余几条防的都是误伤。
   * 上面那条列表挡不住它：`local.evil.com` 里根本没有 `.local` 这个子串
   * （"local"前面没有点），所以把 endsWith 写成 includes 时它照样绿。
   * 而 `x.local.evil.com` 是攻击者**注册得到**的真域名，权威 DNS 在他手里，
   * 重绑定的第 3 步对它完全成立——放行它等于这一整层白挡。
   *
   * 这条用例是突变测试逼出来的：endsWith -> includes 原本一条红都没有。
   */
  it('.local 在中间不算数（x.local.evil.com 是攻击者注册得到的真域名）', async () => {
    for (const host of ['my.local.evil.com', 'a.local.attacker.net', '.local.evil.com']) {
      const res = await request({ host: `${host}:${port}` });
      expect(res.status, `Host: ${host}`).toBe(403);
    }
  });

  /**
   * `evil.example.com.local` 看着吓人，但它**只能**经 mDNS 解析，
   * 攻击者的权威 DNS 对它无能为力——放行它和放行 macbook.local 是同一件事。
   * 这条用例把这个判断钉下来，免得后来人看见它就慌，回头加一条
   * "看起来像域名的就拒"的启发式规则，把一整类合法机器名误伤掉。
   */
  it('后缀是 .local 就够了，前面长得像域名也放行', async () => {
    const res = await request({ host: `evil.example.com.local:${port}` });
    expect(res.status).toBe(200);
  });
});
