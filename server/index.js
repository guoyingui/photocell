// 必须排在所有其他 import 之前——见该文件顶部注释：ESM 里"谁在 import 图里
// 排第几个被引入"才决定执行顺序，跟这行 import 语句本身写在源码里哪一行无关。
import './bootstrap-threadpool.js';
import express from 'express';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import open from 'open';
import { SafePathError } from './lib/safepath.js';
import { fsRouter } from './routes/fs.js';
import { libraryRouter } from './routes/library.js';
import { marksRouter } from './routes/marks.js';
import { imageRouter } from './routes/image.js';
import { exportRouter } from './routes/export.js';
import { shareRouter } from './routes/share.js';
import { adminRouter } from './routes/admin.js';
import { adminLogin, ADMIN_LOGIN_PATH } from './routes/adminlogin.js';
import {
  attachActor, defaultDeny, requireAdmin, rejectQuerySessionOnWrites,
} from './middleware/auth.js';
import { requireKnownHost } from './middleware/host.js';
import { closeAllSessions } from './lib/session.js';
import { setAdminToken } from './lib/actor.js';
import { lanAddresses } from './lib/netaddr.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');

// ─────────────────────────────────────────────────────────────────────────────
// 网络暴露：这个进程绑在哪个地址上
// ─────────────────────────────────────────────────────────────────────────────

export const LOOPBACK_HOST = '127.0.0.1';
export const ANY_HOST = '0.0.0.0';

/**
 * 是否以 `--share` 启动。
 *
 * 默认 false，也就是**默认只监听回环**。这条默认值是整个程序里代价最高的一条：
 * 服务端能读本机任意路径、能在 move 模式下删除不可再生的 RAW，把它挂上局域网
 * 必须是摄影师显式做出的决定，而不是一个"开箱即用"的默认值替他做的。
 * 便利性在这里一律让路（规格 §9）。
 *
 * 写成模块级状态而不是 createApp 的参数，是因为读它的有两处：启动时决定绑哪个
 * 地址，以及 `/api/admin/netaddr` 告诉分享面板"现在到底能不能分享"。
 * 两处必须是同一个答案——面板显示着链接、服务端其实只绑了回环，
 * 是最难被发现的一种不一致（本机点开一切正常）。
 */
let shareMode = false;

export function setShareMode(on) {
  shareMode = on === true;
}

export function isShareMode() {
  return shareMode;
}

/** 监听地址由 shareMode 唯一决定，不另留一个可以和它对不上的变量。 */
export function bindHost() {
  return shareMode ? ANY_HOST : LOOPBACK_HOST;
}

const ADMIN_TOKEN_FLAG = '--admin-token';

/**
 * 命令行开关。只认两个：`--share` 和 `--admin-token=<串>`（也接受空格形式）。
 *
 * 认不出的一律忽略，落点是**不分享、不开管理员令牌**。这个方向是刻意的：
 * `--shar` 打错一个字母的代价是"没开成分享"（看横幅就知道），
 * 反过来把认不出的当成开启，代价是一台能删 RAW 的机器悄悄挂上了局域网。
 */
export function parseArgs(argv = []) {
  const out = { share: false, adminToken: null };
  const args = Array.isArray(argv) ? argv : [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string') continue;

    if (arg === '--share') {
      out.share = true;
    } else if (arg.startsWith(`${ADMIN_TOKEN_FLAG}=`)) {
      // 空值（`--admin-token=`）得到 null 而不是 ''：null 的语义是"这条通道整个关闭"，
      // 与 actor.js 的 setAdminToken 对齐——带着空的 X-PhotoCull-Admin 头拿不到管理员身份。
      out.adminToken = arg.slice(ADMIN_TOKEN_FLAG.length + 1) || null;
    } else if (arg === ADMIN_TOKEN_FLAG) {
      const next = args[i + 1];
      // 后面跟的是下一个开关（或者根本没有下一个）时不吞它：`--admin-token --share`
      // 不该把 '--share' 当成令牌值，那会同时丢掉分享开关又配上一个荒谬的令牌。
      if (typeof next === 'string' && !next.startsWith('--')) {
        out.adminToken = next || null;
        i++;
      }
    }
  }

  return out;
}

/**
 * 桌面壳（Tauri）启动协议。
 *
 * 壳进程会设 `PHOTOCULL_TAURI=1`，自己用 WebView 加载服务地址，所以这里
 * 不能再调 `open()`——否则会再弹一个系统浏览器，变成两个窗口。
 *
 * `PHOTOCULL_READY_FILE` 是给壳的就绪信号：stdout 在非 TTY 下会块缓冲，
 * 壳等不到 `PHOTOCULL_READY` 那一行。写文件是同步的、不依赖缓冲。
 */
export function shouldOpenBrowser(env = process.env) {
  return env.PHOTOCULL_TAURI !== '1';
}

export function notifyDesktopReady(url, env = process.env) {
  const dest = env.PHOTOCULL_READY_FILE;
  if (typeof dest === 'string' && dest.length > 0) {
    writeFileSync(dest, url);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/netaddr
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 局域网地址查询。挂在 `/api/admin` 下，**admin-only**。
 *
 * 单独一个 Router 而不是写进 routes/admin.js，是因为它答的是"这个**进程**
 * 怎么被访问到"——`shareMode` 和监听端口都是启动参数的一部分，只有这里知道。
 * 但它必须和 adminRouter 一样进 API_MOUNTS：那张表是权限矩阵自检的数据源，
 * 绕开它挂上来的路由就是矩阵的盲区。
 *
 * 为什么是 admin-only：网卡地址是内网拓扑信息，而且这条接口的用途是给摄影师
 * 拼分享链接——访客手里已经有链接了，没有任何理由问这个。
 */
export const netaddrRouter = express.Router();

netaddrRouter.use(requireAdmin);

netaddrRouter.get('/netaddr', (req, res) => {
  res.json({
    // 面板据此决定是给出可分享的链接，还是提示"需要用 --share 重启"。
    // 没开分享时给客户发一条 http://127.0.0.1:5183/s/xxx 是纯粹的挫败。
    share: isShareMode(),
    // 端口取自这条连接本身，不取自某个记着启动端口的变量——
    // listenWithFallback 会在端口被占用时换一个，记着的那份会过时。
    port: req.socket?.localPort ?? null,
    // 多网卡时全部列出，服务端不挑（见 netaddr.js 顶部注释）。
    addresses: lanAddresses(),
  });
});

/**
 * 全部 `/api` 路由的挂载表：`[挂载前缀, Router]`。
 *
 * 写成数据而不是一串 `app.use(...)` 调用，是为了让权限矩阵测试能够**枚举**出
 * 服务端实际注册的每一条路径（Express 5 的 Layer 不保存挂载前缀，从 app.router.stack
 * 反查不出来），再跟矩阵求差集。少了这张表，"新加了端点却忘了配权限" 就只能靠人记得住；
 * 有了它，忘记的那一刻测试就红。
 *
 * 新增路由请加进这张表，不要直接 `app.use('/api/...', router)`——
 * permissions.test.js 会检查 app 上没有游离在本表之外的 Router。
 */
export const API_MOUNTS = [
  ['/api/fs', fsRouter],
  ['/api/library', libraryRouter],
  ['/api/library', marksRouter],
  ['/api', imageRouter],
  ['/api/export', exportRouter],
  ['/api/share', shareRouter],
  ['/api/admin', adminRouter],
  ['/api/admin', netaddrRouter],
];

export function createApp() {
  const app = express();

  // **第一层，排在所有东西前面：Host 头校验（见 middleware/host.js）。**
  //
  // 它挡的是 DNS 重绑定：攻击者页面把自己的域名指向 127.0.0.1，浏览器**真的**
  // 连到回环，于是 resolveActor 如实判成 admin，而那个页面与本服务同源、读得到
  // 每一个响应——整块硬盘、每一张原图，以及 move 模式下删掉 RAW 的那条导出。
  // `remoteAddress` 这个前提在那种情形下不是被绕过的，是被**伪造**的，
  // 所以只能在更外面一层挡。
  //
  // 挂在最前面的两个理由：它对每一条路径都成立（/api、静态资源、SPA 兜底
  // 一视同仁——挡住 HTML 本身，那个页面连启动都启动不了）；而且排在
  // express.json() 之前，恶意请求的请求体连解析都不会解析。
  app.use(requireKnownHost);

  app.use(express.json({ limit: '4mb' }));

  // 挂载顺序本身就是安全要求（计划 Task 6/7）：
  //   attachActor -> 白名单 + defaultDeny -> 各路由自己的 requireAdmin / requirePerm
  //
  // 1) attachActor 永不拒绝，只回答"你是谁"，必须排在所有 /api 路由之前，
  //    否则后面的 requireAdmin/requirePerm 读到的是 undefined。
  // 2) defaultDeny 是"解析不出身份一律 401"这条默认拒绝，白名单写在它内部。
  //    它必须**全局早挂**：矩阵里"无身份"那一列的 401 全部来自这里，
  //    而不是来自 requireAdmin（后者对无身份返回的是 403）。少了这一步，
  //    一个无身份请求打到 admin-only 路由上会拿到 403，打到 read 路由上会拿到 401，
  //    同一件事两种答案。
  // 3) 它同时是接线错误的兜底：忘挂 attachActor 时整个 API 关门而不是敞开。
  app.use(attachActor);
  app.use(defaultDeny);
  // 4) CSRF 的第二道防线（第一道是 Cookie 的 SameSite=Lax）：写请求的会话 id
  //    只能来自 X-PhotoCull-Session 请求头，`?sid=` 是 GET 专用通道
  //    （它存在的唯一理由是 <img src> 和 EventSource 设不了请求头，而那两者都是 GET）。
  //    排在 defaultDeny 之后：先回答"你是谁"，再挑请求的形状。
  app.use(rejectQuerySessionOnWrites);

  for (const [prefix, router] of API_MOUNTS) app.use(prefix, router);

  // `--admin-token` 唯一一条浏览器进得来的入口（见 routes/adminlogin.js）。
  //
  // 三条接线约束，每一条都是行为性的：
  //   1. **必须排在 static / SPA 兜底之前。** 兜底会把它变成 200 + index.html，
  //      于是"开关没开"和"令牌带错了"表现不一样，成了一个探测器。
  //   2. **必须排在 defaultDeny 之后。** 走这条路的人还没有任何身份，
  //      它得先被那道默认拒绝放行（白名单里有这一项）。
  //   3. **不进 API_MOUNTS。** 那张表是 /api 权限矩阵的数据源，
  //      这条不是 /api 路由，塞进去只会让矩阵多一行对不上的东西。
  app.get(ADMIN_LOGIN_PATH, adminLogin);

  app.use(express.static(publicDir, { index: 'index.html' }));
  // Express 5 的通配语法是 '/*splat'；写成 '*' 会在启动时抛 PathError
  //
  // `startsWith('/api/')` 这一行是安全相关的：少了它，每一条打错的、或者还没实现的
  // 接口路径都会拿到 200 + 一整页 index.html。前端 fetch 会在 JSON.parse 上炸，
  // 报错指向前端，而问题其实在服务端路由表里——排查方向被带偏一整轮。
  app.get('/*splat', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(publicDir, 'index.html'), (err) => { if (err) next(err); });
  });

  // 上一行放行的 /api 请求落到这里：不存在的接口回 404 JSON，而不是 Express 默认的
  // 那页 "Cannot GET /api/…" HTML。挂在 SPA 兜底**之后**是有意的——挂在前面的话，
  // 上面那条 startsWith 判断就算被删掉也没人看得出来（这里会先把 /api 全部接走），
  // 一条守着边界的判断从此没有任何测试能证明它还活着。
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not-found', message: '没有这个接口' });
  });

  app.use((err, req, res, _next) => {
    const status = err instanceof SafePathError ? 403 : (err.status ?? 500);
    if (status >= 500) console.error('[api]', err);
    res.status(status).json({ error: err.message });
  });

  return app;
}

/**
 * 监听地址的默认值来自 `bindHost()`，也就是**默认 127.0.0.1**。
 * 只有 `--share` 把 shareMode 打开之后，这里才会是 0.0.0.0。
 */
export async function listenWithFallback(app, start = 5183, tries = 17, host = bindHost()) {
  for (let port = start; port < start + tries; port++) {
    try {
      return await new Promise((resolve, reject) => {
        const server = app.listen(port, host);
        server.once('listening', () => resolve(server));
        server.once('error', reject);
      });
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`端口 ${start}–${start + tries - 1} 全部被占用`);
}

/** IPv6 地址在 URL 里必须套方括号，否则冒号会被当成端口分隔符。 */
function urlFor(entry, port) {
  const host = entry.family === 'IPv6' ? `[${entry.address}]` : entry.address;
  return port === '' ? `http://${host}` : `http://${host}:${port}`;
}

function portOf(url) {
  try {
    return new URL(url).port;
  } catch {
    return '';
  }
}

/**
 * 一次性的管理员登录 URL。
 *
 * 令牌一律 `encodeURIComponent`：里面只要有一个 `&` 或 `#`，
 * 不编码的话浏览器就会把后半截当成另一个参数（或者当成锚点）丢掉，
 * 摄影师看到的是一条"看起来完全正常、就是登不进去"的链接。
 */
function adminLoginUrl(origin, token) {
  return `${origin}${ADMIN_LOGIN_PATH}?token=${encodeURIComponent(token)}`;
}

/**
 * 启动时打印的那段话。做成纯函数是为了能对"告警到底在不在"下断言——
 * 这段文字是 `--share` 这个开关唯一的知情同意环节，它消失了没有任何别的东西会报错。
 *
 * 三条内容缺一不可（规格 §8.1 / §9.2）：
 *   1. **局域网内任何人只要拿到链接就能看这些照片**——链接就是授权本身，没有密码。
 *   2. **HTTP 明文**，同网段可以被抓包——照片和 Cookie 都在里面。这一条是我们
 *      明确"不防"的威胁，不写出来就等于给了用户一个虚假的安全感。
 *   3. 检测到的各网卡地址，让人自己挑（服务端分不出哪个通）。
 *
 * 令牌与终端输出：Global Constraints 那条"令牌绝不出现在终端输出里"现在带一条
 * 例外——**那条一次性登录 URL**，且**只有它**。理由是不打印它这个开关就没法用：
 * 浏览器给导航请求设不了自定义请求头，`X-PhotoCull-Admin` 对任何浏览器都不可用，
 * 而设了 `--admin-token` 之后回环也不再算管理员。不给出这条 URL，
 * 摄影师（含规格 §9.3 点名的"从其他电脑管理"）根本没有进得来的路。
 *
 * 例外只到这里为止：横幅里除这条 URL 之外的每一个字、审计日志、错误响应，
 * 仍然一律不含令牌。index.test.js 里那条用例钉的正是这个边界——
 * 不是"令牌不出现"，而是"令牌每一次出现都紧跟在 /admin-login?token= 后面"。
 */
export function startupBanner({ share, url, addresses = [], adminToken = null } = {}) {
  const lines = [`PhotoCull 已启动：${url}`];

  if (share) {
    const port = portOf(url);
    lines.push(
      '',
      '⚠ 已开启局域网分享（监听 0.0.0.0）',
      '  局域网内任何人只要拿到链接就能看这些照片——链接本身就是密码，没有第二道验证。',
      '  传输是 HTTP 明文，同一网段可以被抓包，照片和会话 Cookie 都在里面。',
      '  只在可信网络（影棚、家里）里开，用完请关掉这个进程。',
      '',
    );
    if (addresses.length === 0) {
      // 绑了 0.0.0.0 就是绑了：探测不到地址不代表没暴露，所以上面的告警照旧。
      lines.push('  没有检测到可用的局域网地址（网线和 Wi-Fi 都没连上？）。');
    } else {
      lines.push('  客人可以试这些地址（哪个通只有你知道，服务端不替你挑）：');
      for (const entry of addresses) {
        lines.push(`    ${urlFor(entry, port)}    ${entry.interface}`);
      }
    }
    // 同机反向代理的坑，只在它还成立的时候说：配了 --admin-token 之后回环本身
    // 就不再授予管理员身份（见 lib/actor.js 的两条否决），这条警告也就没有了对象。
    // 转发头否决已经挡住了绝大多数代理，但一个**不加任何转发头**转发过来的请求
    // 仍然看起来就是本机自己发的——那种配置下每个访客都会变成管理员，
    // 而这行字是它唯一的知情同意环节。
    //
    // 这里刻意**不写出那个开关的字面名字**：横幅里一旦出现它，就跟"已启用"
    // 那一段长得一模一样，而这两件事必须一眼能分清（`没配管理员令牌时不提它`
    // 这条既有用例守的正是这个边界）。开关怎么写在 README 那一节里。
    if (!adminToken) {
      lines.push(
        '',
        '  另：不要把这个服务放在**同一台机器上的**反向代理（nginx / Caddy 等）后面。',
        '  经代理转发进来的请求，源地址就是本机，管理员判定会把访客当成你自己——',
        '  他就能浏览你的整块硬盘、触发导出，移动模式下还会删掉你的 RAW。',
        '  非用代理不可的话，请先按 README「管理员身份怎么判定」一节配一个管理员令牌',
        '  再启动：设了它之后回环本身不再算管理员，只有带对令牌的请求才算。',
      );
    }
  } else {
    lines.push(
      '只监听本机 127.0.0.1，局域网里连不上，别人拿到这个地址也打不开。',
      '要让别人一起选片，请用 npm start -- --share 重新启动。',
    );
  }

  if (adminToken) {
    lines.push(
      '',
      '已启用 --admin-token。浏览器给导航请求设不了自定义请求头，所以另开了一条登录入口：',
      '',
      `    ${adminLoginUrl(url, adminToken)}`,
    );
    // 从其他电脑连接时要换的只有主机名那一段，所以这里给**路径**而不是把整条 URL
    // 按网卡逐个印一遍。真机上 lanAddresses() 能探出十来个地址（多网卡 + 轮换的
    // 临时 IPv6），逐个印等于把一个密码在屏幕上重复十几次——更容易被整屏截进图里，
    // 也把"这东西等同于密码"这句话淹掉了。客人地址就列在上面，接上这一段即可。
    //
    // 只在真的开了分享时说：没开分享时那些地址一个都连不上，
    // 讲"怎么从其他电脑连接"只是在教一条注定打不开的路。
    if (share) {
      lines.push(
        '',
        '  要从其他电脑管理：把上面客人地址里能连通的那一条，后面接上同样的这一段——',
        `    ${ADMIN_LOGIN_PATH}?token=${encodeURIComponent(adminToken)}`,
      );
    }
    lines.push(
      '',
      '  这条 URL 等同于管理员密码，用完就丢。打开它，服务端会种一枚 httpOnly 的 Cookie',
      '  再跳回首页，令牌不会留在地址栏里；但这条 URL 本身别截图、别贴进聊天窗口、',
      '  别存成书签——拿到它的人就是管理员。',
      '  这也是终端里唯一会出现令牌值的地方：不打印它，这个开关没有任何浏览器用得了。',
      '  能自己拼请求的客户端（curl / Postman）仍然可以直接带 X-PhotoCull-Admin 头。',
      '',
      '注意：设了它之后回环本身不再授予管理员身份——本机浏览器直接打开上面那个首页地址',
      '也不再是管理员，得先走一次上面这条登录 URL。这是刻意的：这个开关的语义是',
      '"我前面有东西了，从现在起只认令牌"，否则同机反向代理下每个访客都会变成管理员。',
    );
  }

  return lines.join('\n');
}

// 只在直接运行时启动；被测试 import 时不启动。
//
// 必须用 pathToFileURL 而不是拼 `file://${process.argv[1]}`：
// import.meta.url 会把路径里的非 ASCII 字符百分号编码，而 process.argv[1] 是原始路径。
// 项目目录一旦含中文（本仓库就叫「选图程序」），两者永不相等，于是
// `node server/index.js` 静默退出 0——不监听、不报错、不打印任何东西。
// 1268 个测试没有一个发现它，因为它们全都直接 import { createApp }，绕开了这条路径。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { share, adminToken } = parseArgs(process.argv.slice(2));
  // 两个开关都必须在 listen / createApp 之前生效：前者决定绑哪个地址，
  // 后者决定 resolveActor 里那条"带对头就是管理员"的分支开不开。
  setShareMode(share);
  setAdminToken(adminToken);

  const server = await listenWithFallback(createApp());
  // 打开的始终是回环地址：摄影师自己这台机器上，回环即管理员（规格 §9.3）。
  const url = `http://${LOOPBACK_HOST}:${server.address().port}`;
  console.log(startupBanner({
    share, url, addresses: share ? lanAddresses() : [], adminToken,
  }));
  notifyDesktopReady(url);
  if (shouldOpenBrowser()) {
    await open(url).catch(() => {});
  }
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await closeAllSessions();
      server.close(() => process.exit(0));
    });
  }
}
