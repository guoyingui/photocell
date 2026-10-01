import express from 'express';
import { assertWithin } from '../lib/safepath.js';
import {
  beginSession, getSession, browseRoots, closeSession, rescanSession, scanErrorMessage,
} from '../lib/session.js';
import { addListener, removeListener, endShare, onlineGuestCount } from '../lib/presence.js';
import { getShareById, shareStatus } from '../lib/shares.js';
import { requireAdmin, requirePerm, sessionIdOf } from '../middleware/auth.js';

export const libraryRouter = express.Router();

/**
 * SSE 心跳间隔。25 秒够短，穿得过多数浏览器/反向代理的空闲超时；又够长，
 * 不至于把一条长连接变成一台定时磁盘读取机。
 *
 * 做成变量而不是常量只有一个理由：过期踢人挂在这个心跳上（见 `/stream`），
 * 而那条端到端用例不可能真的等 25 秒。默认值本身一个字没改。
 */
const DEFAULT_HEARTBEAT_MS = 25_000;
let heartbeatMs = DEFAULT_HEARTBEAT_MS;

/**
 * 权限中间件排在 requireSession **之前**。
 *
 * 授权的答案不该取决于此刻有没有开着库：一个访客问 `POST /api/library/close`，
 * 得到的应该恒定是 403「这个操作只能在本机进行」，而不是随库开着没开着在
 * 403 和 409 之间摇摆——后者等于把"本机现在开着哪个库"这件事透给了没有权限知道的人。
 *
 * 这个顺序也是 requirePerm 自己文档里写的那一种：它只在请求确实带来一个
 * 还活着的会话时才做 wrong-library 校验，没带或者已失效时把判断留给后面的
 * requireSession（409 session-gone，前端据此重新 join）。
 * 因此每一条会话相关的路由都必须**同时**挂上两者，只挂 requirePerm 会被
 * 不带 sid 的访客直接穿过去。
 *
 * 会话门有两个版本，区别只在"等不等扫描"：默认用 requireSession，
 * `/stream` 和 `/close` 用 requireLiveSession，理由见各自的注释。
 */

/**
 * 会话 id 的解析**只有一份实现**，在 middleware/auth.js 里（这里 import 它）。
 *
 * 以前这个文件自己有一份 `req.get(…) || req.query.sid`，middleware/auth.js 的
 * requirePerm 另有一份。两份看起来一样，但它们回答的是同一个问题——"这个请求
 * 说的是哪个会话"——而其中一份收紧成"写请求不认 ?sid="之后，另一份不跟着改
 * 就意味着授权用的是一个会话、路由用的是另一个。这类分叉不会有任何测试变红，
 * 只会在某一天变成一个说不清的越权。
 *
 * 那条规矩本身（GET 两条通道都认，写请求只认请求头）写在 auth.js 的
 * sessionIdOf 上面，不在这里重复。
 */

function sessionGone(res) {
  return res.status(409).json({
    error: 'session-gone',
    message: '会话已失效或已被替换，请重新打开文件夹',
  });
}

/**
 * 要求带上一个还活着的会话 id，**并且它的资产表已经就绪**；
 * 没有或者已经失效返回 409。
 *
 * 以前这里只问"有没有会话"，不问"是哪一个"：第二个标签页打开另一个文件夹之后，
 * 第一个标签页的每一次标记都会落进第二个文件夹的 marks.json，缩略图也会串——
 * 两台同型号机身拍出来的 IMG_0002 在两个文件夹里就是同一个 id，两边都不会报错。
 *
 * 开库不再等扫描（I7），于是"会话存在"和"资产表已经有了"从此是两件事。
 * 扫描期间到达的资产类请求在这里排队等扫描落定，而不是拿着一份空的
 * `session.assets` 去回答——那会让 /assets 回一个空表、让 PUT /marks 把每一个
 * id 都当成未知资产拒掉，全都是"看起来成功了、其实全错"的那一类失败。
 * 正常前端不会走到这条等待：它拿到 `phase:'scanning'` 之后会等 SSE 的
 * `scan.done` 再来拉资产。这里兜的是抢跑的客户端和断线重连。
 *
 * 扫描失败时会话会被清理掉，所以等待结束后必须**重新查一次**：
 * 等待期间它可能已经不在注册表里了。
 */
export async function requireSession(req, res, next) {
  const sid = sessionIdOf(req);
  const session = getSession(sid);
  if (!session) return sessionGone(res);

  if (session.ready && !session.scan?.done) {
    await session.ready;
    if (getSession(sid) !== session) return sessionGone(res);
  }

  req.session = session;
  next();
}

/**
 * 同上，但**不等扫描**：只问"这个会话还在不在"。
 *
 * 两条路由必须用它：
 * - `/stream`：进度事件就是从这条流上发出去的，它自己去等扫描的话，
 *   客户端要到扫描结束才连得上，进度条永远不会动。
 * - `/close`：扫到一半想换文件夹是完全正常的操作，没有理由让"取消"
 *   先等完它想取消的那件事。
 */
export function requireLiveSession(req, res, next) {
  const session = getSession(sessionIdOf(req));
  if (!session) return sessionGone(res);
  req.session = session;
  next();
}

/**
 * move 模式的导出正在删源文件的时候换文件夹，是最不该允许发生的事：
 * 摄影师会以为自己只是切了个视图，实际上后台还在一个一个删掉他的 RAW，
 * 而界面已经回到选择器，连取消按钮都找不到了。
 */
async function assertNoLiveMoveJob(res) {
  // 动态 import 打破 export.js ↔ library.js 的循环依赖（export.js 要用 requireSession）。
  const { hasRunningMoveJob } = await import('./export.js');
  if (!hasRunningMoveJob()) return true;
  res.status(409).json({
    error: '正在移动文件（会删除源文件），请等待任务结束或先取消，再切换文件夹',
    code: 'move-in-progress',
  });
  return false;
}

libraryRouter.post('/open', requireAdmin, async (req, res, next) => {
  try {
    if (!await assertNoLiveMoveJob(res)) return;
    const root = await assertWithin(await browseRoots(), String(req.body?.root ?? ''));
    // beginSession 而不是 openSession：路径校验、写探测、marks 读取都同步做完，
    // 只有**扫描**留在后台。读卡器上 3000 对照片要扫几十秒，阻塞到扫完再回应的话，
    // 界面上只有一个静止的"正在扫描…"，跟卡死无法区分。
    const session = await beginSession(root);
    res.json({
      sessionId: session.id,
      root: session.root,
      // 'scanning'：资产表还没有，等 SSE 的 scan.done 再来拉 /assets。
      // 'ready'：同一个文件夹已经开着（第二个标签页），资产表当场就能用。
      phase: session.scan.done ? 'ready' : 'scanning',
      // 下面这三个在扫描期间必然是空的（0 / []）——它们要等扫完才知道。
      // 客户端应当按 phase 判断，而不是按这几个值判断。
      assetCount: session.assets.length,
      warnings: session.warnings,
      skippedFiles: session.skippedFiles,
      settings: session.markStore.data.settings,
      marksRecovered: session.markStore.data.recovered === true,
    });
  } catch (err) {
    // 不可写是一个用户必须去处理的阻断状态（只读 SD 卡、只读网络挂载、磁盘写满），
    // 不是一次可以重试的偶发失败——给它一个可判别的 error 码和一句人话，
    // 而不是让顶层中间件把它变成一条泛泛的 400。
    // no-such-folder 同理：粘错一个路径是很常见的操作，它值得一句明确的话，
    // 而不是顶层中间件那条泛泛的 400。
    if (err?.code === 'not-writable' || err?.code === 'no-such-folder') {
      return res.status(400).json({ error: err.code, message: err.message, detail: err.detail });
    }
    next(err);
  }
});

/**
 * 关库之前先看一眼这个会话上还有没有访客在线（规格 §5.4）。
 *
 * closeSession() 会逐条 `end()` 掉这个会话上的**每一条** SSE 连接，访客的也在内。
 * 摄影师按"换文件夹"时想的是"我换个视图"，而实际发生的是"正在浏览器中看图的
 * 客户当场掉线"——这两件事必须由他自己分清楚，不能由一个按钮替他决定。
 *
 * 所以在线人数不为零时先回 409，把人数和一句明确的话给出去，由前端弹确认；
 * 确认之后带 `force: true` 再来一次。**`force` 只接受布尔 true**，不认
 * `'true'` / `1`：这个参数的作用是踢人，落点必须是"没说清楚就不踢"。
 *
 * 这里刻意**不做**规格 §5.4 那条完整的"一条活着的分享把库会话钉住"语义——
 * 那要动会话生命周期（访客的会话得脱离摄影师的开关而独立存在），
 * 不是一个安全修复该带上的改动。这条拦截解决的是其中最要命的那一半：
 * 摄影师至少知道自己按下去会发生什么。
 */
function assertNoGuestsOnline(req, res) {
  if (req.body?.force === true) return true;

  const online = onlineGuestCount(req.session);
  if (online === 0) return true;

  res.status(409).json({
    error: 'guests-online',
    message: `还有 ${online} 位访客在线，链接仍然有效。关闭文件夹只是你这一侧脱离，`
      + '他们会当场掉线，但手里的链接不会失效——要真正结束访问，请到分享面板撤销这条链接。',
    online,
  });
  return false;
}

libraryRouter.post('/close', requireAdmin, requireLiveSession, async (req, res) => {
  try {
    if (!await assertNoLiveMoveJob(res)) return;
    if (!assertNoGuestsOnline(req, res)) return;
    await closeSession(req.session.id);
    res.json({ ok: true });
  } catch (err) {
    // closeSession() 已经把会话从注册表里摘掉了（否则"换文件夹"会永远卡住），
    // 但落盘确实失败了，必须如实说出来，不能回 {ok:true}。
    res.status(500).json({
      error: `关闭时未能把标记写入磁盘：${err.message}。这一场的部分标记可能没有保存`,
      code: 'close-failed',
    });
  }
});

/**
 * 原地重扫当前文件夹（规格 §4.2）。
 *
 * **admin-only。** 刷新会替换所有人正在看的那份资产表，一个客户的手滑
 * 不该有这个权力——和导出、开关库同一档。
 */
libraryRouter.post('/refresh', requireAdmin, requireLiveSession, async (req, res) => {
  try {
    const { removed, added } = await rescanSession(req.session);
    res.json({ ok: true, removed, added });
  } catch (err) {
    // 扫描失败对客户端是一条要显示的提示，不是一个 500。旧资产表还在，
    // 界面留在原处即可——脱敏后的原因已经通过 SSE 的 rescan 事件发过一遍了。
    //
    // 这里**不区分**扫描失败和编程错误（TypeError 也会被吞成 503）。和 runScan
    // 既有的 catch-all 是同一个取舍：这条路径失败时最要紧的是别把旧资产表连坐
    // 弄丢，而"到底是哪种错"对摄影师来说都一样——他能做的只有重试。真实原因
    // 由下面这行完整落进 stderr，排查时看那里。
    console.error('[refresh] 重扫失败', err);
    res.status(503).json({ error: 'rescan-failed', message: scanErrorMessage(err) });
  }
});

libraryRouter.get('/assets', requirePerm('read'), requireSession, (req, res) => {
  // warnings / skippedFiles 也从这里出去：扫描不再阻塞开库之后，开库响应发出的
  // 那一刻它们必然还是空的，这里是它们**唯一**说得准的时机。
  // （两者都只含相对路径，见 scan.js，给 viewer 也是安全的。）
  res.json({
    assets: req.session.assets,
    warnings: req.session.warnings,
    skippedFiles: req.session.skippedFiles,
  });
});

libraryRouter.get('/meta', requirePerm('read'), requireSession, (req, res) => {
  res.json({ metas: [...req.session.metas.values()], done: req.session.metaDone });
});

/**
 * 这条连接所属的分享是不是已经不该继续看了；是的话把该分享的访客全部断掉。
 *
 * 为什么需要它：撤销是即时的（`DELETE /api/admin/shares/:id` 当场 endShare），
 * **过期不是**——没有任何东西去看一条分享是不是到期了。到期的访客手上那一屏
 * 还能继续看，还在跟着别人的标记实时变化，一直到他下一次发 HTTP 请求
 * （可能是几分钟以后，也可能永远不会：他只是在滚动已经缓存好的图）。
 *
 * 三个判断都是有意写成这样的：
 *
 * - **重新读盘，不用 `actor.share` 那份快照。** 快照永远停在连上来的那一刻，
 *   而 `expiresAt` 可以被 `PATCH /api/admin/shares/:id` 改（提前或延后）。
 * - **管理员一律跳过。** 他不属于任何一条分享，"过期"对他无从谈起；
 *   摄影师的界面不该因为一条发出去的链接到期而中断。
 * - **`missing` 不踢人。** `shareStatus(null, …)` 是 `missing`，而 `null` 既可能
 *   是"记录真的没了"，也可能是 `shares.json` 连同 `.bak` 一起读失败时
 *   `readJson` 返回的那份空存储（见 jsonstore.js）。把一次磁盘抖动变成
 *   "所有人当场掉线"是把可用性押在读盘上，代价远大于多留一条连接。
 *   `revoked` / `expired` 是记录里**写着**的状态，不存在这种歧义。
 *
 * 读盘失败一律当作"没事发生"：审计和踢人都不该由一次 IO 错误来触发。
 */
async function endIfShareIsOver(actor) {
  if (actor?.kind !== 'user') return false;
  const shareId = actor.share?.id;
  if (typeof shareId !== 'string' || shareId === '') return false;

  const status = shareStatus(await getShareById(shareId), Date.now());
  if (status !== 'expired' && status !== 'revoked') return false;

  // endShare 只动这条分享的访客：管理员的连接、以及指向同一个文件夹的
  // **另一条**分享的访客都不受影响（到期的是链接，不是这个文件夹）。
  endShare(shareId, status);
  return true;
}

/**
 * SSE：扫描进度 + 元数据批次 + 烘焙进度。
 *
 * 用 requireLiveSession（不等扫描）：进度事件就是从这条流上发出去的，
 * 它自己去等扫描结束的话，进度条永远等不到第一帧。
 */
libraryRouter.get('/stream', requirePerm('read'), requireLiveSession, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const session = req.session;

  // 补发快照，订阅者不会漏掉已发生的批次
  send({ type: 'meta', metas: [...session.metas.values()] });
  if (session.metaDone) send({ type: 'metaDone' });
  send({ type: 'bake', ...session.bake });
  // 扫描进度也要进这套补发逻辑：一个文件夹只有一个会话、可以被多个客户端共享，
  // 扫描中途连上来的人必须当场拿到当前进度，而不是干等到下一批（默认 500 个文件
  // 才一批，在慢速读卡器上那是好几秒的静止）。
  // 只报数量，不带任何路径——这条流对 viewer 也是开放的。
  send({ type: 'scan', found: session.scan.found, done: session.scan.done });

  // 除了广播用的 send 闭包，还留一个能结束底层响应的钩子——
  // 库被关闭时 closeSession()、用户被禁用时 kickUser() 都要靠它把这条连接真正断掉，
  // 而不是留着一条看似活着、实际再也不会收到消息的连接。
  //
  // actor 是第三个字段：**在线名单就是这个集合派生出来的**，不做心跳。
  // 走 addListener/removeListener 而不是直接 add/delete，是因为上线和下线
  // 都必须广播新名单——直接改 Set 的话，别人的成员条永远停在他自己进来的那一刻。
  const listener = { send, end: () => res.end(), actor: req.actor };
  addListener(session, listener);

  /**
   * 心跳顺带做过期检查，**不新增常驻定时器**。
   *
   * 好处不只是省一个 interval：没有人连着的时候本来就没有人需要被踢，
   * 一个空转的扫描进程是纯粹的浪费；而只要有人连着，检查就一定会跑。
   *
   * `inFlight` 这道闸不是洁癖：检查要读一次 `shares.json`，慢盘上一次读
   * 超过一个心跳周期时，setInterval 会把第二次检查叠在第一次上面。
   * 读的是 `listener.actor` 而不是 `req.actor`：改角色时 presence.js 会
   * 整个换掉 listener 上那个对象，闭包里捏着旧的那份就会越查越旧。
   */
  let inFlight = false;
  const beat = async () => {
    // 心跳本身先发：过期检查失败也好、慢也好，都不该让这条流看起来死掉。
    try { res.write(': ping\n\n'); } catch { /* 对端已经断了，close 事件马上就到 */ }
    if (inFlight) return;
    inFlight = true;
    try {
      await endIfShareIsOver(listener.actor);
    } catch (err) {
      // 读盘失败不踢人，只留一行。把一次 IO 错误变成"所有人当场掉线"，
      // 是把可用性押在读盘上。
      console.error('[library] 心跳检查分享状态失败', err);
    } finally {
      inFlight = false;
    }
  };

  const ping = setInterval(beat, heartbeatMs);
  req.on('close', () => { clearInterval(ping); removeListener(session, listener); });
});

/**
 * 烘焙优先级：把"我正在看的这一屏"插到烤图队列前面。
 *
 * 权限是 `read` 而不是 admin-only，这一点是有意的。这条接口不读也不写任何
 * 用户数据，它唯一的效果是**重排一个内存队列**——而访客本来就能对
 * `/api/thumb` 发任意多次请求，让他重排自己那条队列不增加任何实质风险。
 * 反过来定成 admin-only 的代价是实打实的：访客滚动时前端这条信号发不出去，
 * 客户那一侧的出图会明显变慢，而"客户流畅地看图"正是这个功能存在的理由。
 *
 * `requirePerm('read')` 顺带把 wrong-library 也带上了：一个访客拿别条链接的
 * sessionId 来重排别的文件夹的队列，会在中间件那一层就被 403 掉。
 */
libraryRouter.post('/prioritize', requirePerm('read'), requireSession, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 400).map(String) : [];
    const { prioritizeBake } = await import('../lib/bake.js');
    prioritizeBake(req.session, ids);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * 测试钩子：把心跳间隔调快。
 *
 * 返回换掉之前的值，调用方（测试）必须还原——这是模块级状态，
 * 漏还原会让后面每一条建 SSE 连接的用例都跟着跑一个毫秒级定时器。
 */
export const _test = {
  setHeartbeatMs(ms) {
    const prev = heartbeatMs;
    heartbeatMs = typeof ms === 'number' && ms > 0 ? ms : DEFAULT_HEARTBEAT_MS;
    return prev;
  },
};
