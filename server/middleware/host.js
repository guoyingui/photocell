import { lanAddresses } from '../lib/netaddr.js';

/**
 * `Host` 头校验 —— 防 DNS 重绑定。
 *
 * 没有这一层时的攻击链，一步都不需要用户配合：
 *
 *   1. 摄影师在本机开着 PhotoCull（默认只绑 127.0.0.1，看起来是安全的）；
 *   2. 他在同一个浏览器里打开 `evil.example.com` 的任意一个页面；
 *   3. 那个域名的 DNS 记录 TTL 设成 1 秒，第二次解析时改答 `127.0.0.1`；
 *   4. 页面里的 `fetch('http://evil.example.com:5183/api/fs/roots')` —— 浏览器
 *      **真的**连到了 127.0.0.1，所以 `req.socket.remoteAddress` 就是回环、
 *      也没有任何转发头，`resolveActor` 如实判成 **admin**；
 *   5. 而在浏览器眼里这仍然是 `evil.example.com` 的同源请求，**响应读得到**。
 *
 * 于是那个页面拿到的是完整的管理员权限：遍历主目录与全部挂载卷、打开任意
 * 文件夹、逐张取原图，以及 `POST /api/export {mode:'move'}` —— 那一条会删掉
 * 不可再生的 RAW。失败方向是**开门**，与规格 §9.3 那条"同机反向代理"同构：
 * 判定式本身没错，错在"回环"这个前提被一条我们没有检查过的路径伪造了。
 *
 * 挡它的唯一可靠信号是 `Host` 头：浏览器发出的是**用户地址栏里那个名字**，
 * 不是它解析出来的 IP。攻击者可以让 `evil.example.com` 指向任何地址，
 * 但没有办法让浏览器把 `Host` 写成 `127.0.0.1`（`Host` 是 forbidden header，
 * 页面脚本改不了它）。所以：只接受我们自己知道的那几个名字，其余一律拒绝。
 *
 * 白名单只有五类，故意不留"看起来也挺像本机"的口子：
 *
 *   - `localhost`（不分大小写）
 *   - `127.0.0.0/8` 的任意地址（macOS 上给别名接口配 127.0.0.2 是常见做法）
 *   - `::1` / `[::1]` / `::ffff:127.0.0.1` 这几种 IPv6 回环写法
 *   - `lanAddresses()` 列出的本机各网卡地址 —— 也就是启动横幅印给客人的那些
 *   - `*.local`（Bonjour / mDNS 名）—— **唯一一条按后缀匹配的规则**
 *
 * 最后一条是这里唯一的例外，它不削弱上面那段推理，理由要说清楚：
 * `.local` 由 RFC 6762 保留给 mDNS，**不走 DNS 层级**，也不是根区里可委派的
 * TLD——没有人能注册一个 `.local` 名字。而上面整条攻击链的第 3 步
 * （"改 DNS 答案指回 127.0.0.1"）正是攻击者拿自己的权威 DNS 服务器做的，
 * 那个能力对 `.local` 根本使不上。残余风险只剩同一局域网内的 mDNS 抢名，
 * 而那种攻击者本来就能直接打 IP 绕开这个名字。
 *
 * 反过来，收紧它的代价是实打实的：客人用 `http://某某的-MacBook.local:5183`
 * 进来会撞 403，看不出为什么，也没有降级路径。
 */

/** 端口取自这条连接本身，不取自某个记着启动端口的变量——`listenWithFallback` 会换端口。 */
function localPortOf(req) {
  const port = req?.socket?.localPort;
  return typeof port === 'number' && Number.isFinite(port) ? String(port) : null;
}

/**
 * 把 `Host` 拆成主机名和端口。认不出的形状返回 null（= 拒绝）。
 *
 * IPv6 必须带方括号（RFC 3986）：`[::1]:5183`。裸的 `::1:5183` 无从判断
 * 最后那一段是端口还是地址的一部分，所以直接判否而不是猜——这一层的落点
 * 必须是拒绝。
 */
function splitHostPort(value) {
  const raw = value.trim();
  if (raw === '') return null;

  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end === -1) return null;
    const rest = raw.slice(end + 1);
    if (rest === '') return { host: raw.slice(1, end), port: '' };
    if (!rest.startsWith(':')) return null;
    return { host: raw.slice(1, end), port: rest.slice(1) };
  }

  const cut = raw.lastIndexOf(':');
  if (cut === -1) return { host: raw, port: '' };
  // 冒号不止一个又没套方括号 = 一个不合法的裸 IPv6，判否。
  if (raw.indexOf(':') !== cut) return null;
  return { host: raw.slice(0, cut), port: raw.slice(cut + 1) };
}

const LOOPBACK_NAMES = new Set([
  'localhost',
  '::1',
  '[::1]',
  '0:0:0:0:0:0:0:1',
  '::ffff:127.0.0.1',
]);

/** 整个 127.0.0.0/8。四段十进制，每段最多三位——不做数值范围校验，多余。 */
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

const MDNS_SUFFIX = '.local';

/**
 * Bonjour / mDNS 名。**唯一一条按后缀放行的规则**，理由见文件头。
 *
 * 长度必须**大于**后缀本身：光一个 `.local` 是空标签，不是主机名。
 * 前面那一截长什么样一概不管——`evil.example.com.local` 也放行，因为
 * `.local` 只能经 mDNS 解析，攻击者的权威 DNS 服务器对它使不上力。
 * 在这里加一条"看起来像域名的就拒"的启发式规则只会误伤合法机器名。
 */
function isMdnsName(host) {
  return host.length > MDNS_SUFFIX.length && host.endsWith(MDNS_SUFFIX);
}

/**
 * 这个主机名是不是"本机"。
 *
 * `lanAddresses()` 每次现读网卡表，不缓存：Wi-Fi 重连、插拔网线、VPN 起落
 * 都会换地址，而缓存过期的那一刻恰好就是摄影师刚把新链接发出去的那一刻——
 * 一层为了省几十微秒的缓存，换来的是"链接明明是刚生成的却打不开"。
 */
function isOwnHostname(name) {
  const host = name.toLowerCase();
  if (host === '') return false;
  if (LOOPBACK_NAMES.has(host)) return true;
  if (IPV4_LOOPBACK.test(host)) return true;
  if (isMdnsName(host)) return true;
  return lanAddresses().some((entry) => entry.address.toLowerCase() === host);
}

/**
 * `Host` 与这条连接实际落在的端口一致吗。
 *
 * 没带端口按 80 算（HTTP 的默认端口）。取不到 `localPort`（非 TCP 的传输层、
 * 或者被测试替换过的 socket）时**不比端口**，只比主机名——主机名才是这一层
 * 真正的防线，为了一个拿不到的字段把整个服务关掉是过度反应。
 */
function portMatches(req, port) {
  const expected = localPortOf(req);
  if (expected === null) return true;
  return (port === '' ? '80' : port) === expected;
}

/**
 * 拒绝时的响应。403 而不是 421 `Misdirected Request`：421 会让某些浏览器
 * 换一条连接重试同一个请求（HTTP/2 的连接合并语义），而我们要的是"这条路
 * 走不通"，不是"换条路再试试"。
 */
const BAD_HOST = Object.freeze({
  error: 'bad-host',
  message: '请求的 Host 不是本机地址。请用启动时打印的那几个地址访问。',
});

/**
 * 必须**最早**挂：它要挡住的东西对每一条路径都成立（`/api`、静态资源、SPA
 * 兜底都一样），而且挡在 `express.json()` 前面还顺带省掉了给恶意请求解析
 * 请求体这一步。
 */
export function requireKnownHost(req, res, next) {
  const raw = req.headers?.host;

  // **没有 Host 头的请求放行。** HTTP/1.0 允许不带，而这一层要防的是浏览器：
  // 浏览器发出的每一个请求都必然带 Host（HTTP/1.1 强制，HTTP/2 用 :authority
  // 伪头，Node 会把它填进 headers.host）。一个不带 Host 的请求不可能来自
  // 被重绑定的页面，挡它只会误伤 curl 和某些健康检查。
  if (raw === undefined) return next();
  if (typeof raw !== 'string') return res.status(403).json(BAD_HOST);

  const parts = splitHostPort(raw);
  if (parts === null) return res.status(403).json(BAD_HOST);
  if (!isOwnHostname(parts.host)) return res.status(403).json(BAD_HOST);
  if (!portMatches(req, parts.port)) return res.status(403).json(BAD_HOST);

  return next();
}
