import express from 'express';
import { getShareById, resolveToken, shareStatus } from '../lib/shares.js';
import {
  countUsers, createUser, findUserByNicknameKey, findUserByToken,
  listUsers, normalizeNickname, touchUser,
} from '../lib/users.js';
import { logEvent } from '../lib/audit.js';
import { openSession, getSessionByRoot } from '../lib/session.js';
import { parseCookies, serializeCookie } from '../lib/cookies.js';
import { USER_COOKIE, clientAddress } from '../lib/actor.js';
import { createRateLimiter } from '../middleware/ratelimit.js';

/**
 * 访客接入。三条无身份可达的端点（info / join / resume，见 middleware/auth.js
 * 的 WHITELIST）加一条要身份的 leave。
 *
 * 这个文件里只有一条性质是不可协商的：
 * **过期、撤销、不存在三种情况的响应必须完全一致**——状态码、响应体、响应头
 * 一个字节都不能差。任何差异都会变成一个"这个 token 曾经有效"的判定器，
 * 而 43 字符随机令牌的全部意义就是让人猜不出哪些 token 存在过。
 * 真实原因只允许写进审计日志（管理员看得到，猜 token 的人看不到）。
 *
 * 兑现这条性质的做法是：所有拒绝都走同一个 denyLink()，回同一个冻结的
 * INVALID_LINK 常量，且**这条路径上永远不设任何响应头**（尤其是 Set-Cookie）。
 */
export const shareRouter = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// 固定响应体。冻结是为了防止某处不小心就地改一个字段，把"三者一致"改成两者一致。
// ─────────────────────────────────────────────────────────────────────────────

const INVALID_LINK = Object.freeze({ error: 'invalid-link', message: '链接不存在或已失效' });
const RATE_LIMITED = Object.freeze({ error: 'rate-limited', message: '尝试过于频繁，请稍后再试' });
const NEED_JOIN = Object.freeze({ error: 'need-join' });

/** 按 reason 给具体文案。三条必须互不相同，否则等于没按 reason 分。 */
const BAD_NICKNAME_MESSAGES = Object.freeze({
  empty: '请先输入一个昵称',
  'too-long': '昵称最多 24 个字符',
  'bad-chars': '昵称里有不能使用的字符',
});

// ─────────────────────────────────────────────────────────────────────────────
// 限流
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 按 IP 的失败闸门：60 秒窗口内 20 次失败之后 429（规格 §9.1）。
 *
 * 三条无身份端点**共用**一个计数器。只限 join 是不够的：猜 token 最省事的
 * 入口是 GET info（无体、无 Cookie、一个 GET 就够），只把 join 关上等于
 * 把大门锁了、窗户开着。
 */
const failures = createRateLimiter({ windowMs: 60_000, max: 20 });

/**
 * 失败路径的唯一出口。
 *
 * `hit(key)` 的语义是"这一次放行吗"（true = 还在额度内），所以它**只在失败时
 * 被调用**——成功的 join 不该消耗额度。超额时把本来要发的错误整个**换成**
 * 429，而不是附加：换掉才能保证猜 token 的人从响应里拿不到比"你被限流了"
 * 更有信息量的东西。
 *
 * key 用 clientAddress(req)（TCP 源地址），**不是** req.ip——后者在有人打开
 * trust proxy 之后会去读 X-Forwarded-For，于是限流的 key 变成攻击者自己写的
 * 字符串，换一个值就能重置计数。
 */
function fail(req, res, status, body) {
  if (!failures.hit(clientAddress(req))) return res.status(429).json(RATE_LIMITED);
  return res.status(status).json(body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cookie
// ─────────────────────────────────────────────────────────────────────────────

const COOKIE_OPTS = Object.freeze({ httpOnly: true, sameSite: 'lax', path: '/' });

function setUserCookie(res, token) {
  res.setHeader('Set-Cookie', serializeCookie(USER_COOKIE, token, COOKIE_OPTS));
}

/** 清 Cookie 靠 Max-Age=0；属性必须和下发时一致，否则浏览器认为是另一枚。 */
function clearUserCookie(res) {
  res.setHeader('Set-Cookie', serializeCookie(USER_COOKIE, '', { ...COOKIE_OPTS, maxAge: 0 }));
}

function presentedToken(req) {
  const value = parseCookies(req.headers?.cookie ?? '')[USER_COOKIE];
  return typeof value === 'string' && value !== '' ? value : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 审计
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 这条分享名下需要脱敏的全部令牌：share.token + 其下每个 user.token。
 * redactTokens 做的是**全等替换**，所以必须把令牌本身逐个交给它——
 * 顺带一条：**绝不能把请求路径写进事件**，`/api/share/<token>/info` 里的令牌
 * 是子串而不是整个字段值，脱敏这一关根本挡不住它。
 */
async function tokensOf(share) {
  const users = await listUsers(share.id);
  return [share.token, ...users.map((u) => u.token)];
}

/**
 * 记一条事件。**这是一个契约**：不管调用方往 event 里塞了什么，这条分享名下的
 * 令牌都不会落进 events.jsonl。路由今天没往事件里放令牌，明天加一个字段就可能
 * 放进去，所以脱敏这一步必须由这里无条件兜住，而不是靠每个调用方自己记得。
 *
 * 写日志失败只打印、不抛：审计写不进去是运维问题，不该把它变成一个能让
 * "这个 token 曾经有效"暴露出来的响应差异（无效链接一律 404，不管日志写没写成）。
 */
export async function logShareEvent(share, event) {
  try {
    await logEvent(share.id, event, await tokensOf(share));
  } catch (err) {
    console.error('[share] 写审计日志失败', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 共用的拒绝路径
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 链接不可用（过期 / 撤销 / 不存在）。三者在这里汇合成同一个响应。
 *
 * share 为 null（token 根本不存在）时无从得知 shareId，只能不记日志——这正是
 * 三者必须在响应上完全一致的原因：响应里任何一点差异都能把"这个 token 对应过
 * 一条真实分享"这件事读出来。顺带也挡住了"拿随机 token 刷出一堆日志目录"。
 *
 * 日志是 await 的，不是 fire-and-forget：审计必须在响应发出之前落盘，否则
 * "管理员看得到真实原因"这条保证就带着一个丢事件的窗口。代价是失效链接比
 * 不存在的链接多一次磁盘写的耗时——一条时间侧信道，本设计不防（规格 §9.2
 * 的取舍口径：能被 shareId 记录下来的攻击不靠响应时间去防）。
 */
async function denyLink(req, res, share, reason) {
  if (share) {
    await logShareEvent(share, { actor: 'anonymous', action: 'user.denied', reason });
  }
  return fail(req, res, 404, INVALID_LINK);
}

/**
 * 回访者的身份不成立。
 *
 * `clear` 决定要不要把那枚 Cookie 清掉，这个区分是有代价考量的：
 * 令牌查不到 / 用户被禁用时必须清（否则浏览器会一直带着一枚死 Cookie 重试，
 * 用户卡在一个没有出口的循环里）；但 Cookie 属于**另一条仍然有效的分享**时
 * 绝不能清——清掉之后这个人回到自己那条链接会被弹回昵称表单，而他的昵称
 * 正被自己占着，409 nickname-taken，从此再也进不去。
 */
async function needJoin(req, res, share, reason, { clear, actor = 'anonymous' }) {
  if (clear) clearUserCookie(res);
  await logShareEvent(share, { actor, action: 'user.denied', reason });
  return fail(req, res, 401, NEED_JOIN);
}

// ─────────────────────────────────────────────────────────────────────────────
// 访客拿到的会话信息
// ─────────────────────────────────────────────────────────────────────────────

/**
 * join / resume 成功后的响应体。
 *
 * 规格 §5.2 写的是 `{ sessionId, user, share, ...openResult }`，而 openResult
 * （`POST /api/library/open` 的响应）里有 `root`——摄影师磁盘上的绝对路径。
 * 访客既不需要它，也不该知道它：info 明确不返回 root，join 返回了等于从后门
 * 把同一件事说了出去。所以这里是 openResult 的**访客版本**，逐字段挑出来，
 * 不是 spread 之后再 delete（后者在 openResult 将来多一个敏感字段时会默默漏出去）。
 *
 * warnings / skippedFiles 里只有相对路径（见 scan.js），可以给访客。
 */
function guestPayload(session, user, share) {
  return {
    sessionId: session.id,
    user: { id: user.id, nickname: user.nickname, role: user.role },
    share: { label: share.label },
    assetCount: session.assets.length,
    warnings: session.warnings,
    skippedFiles: session.skippedFiles,
    settings: session.markStore.data.settings,
    marksRecovered: session.markStore.data.recovered === true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 路由
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `/leave` 必须注册在 `/:token/*` 之前吗？——不必，两者的段数不同，
 * `/leave` 只有一段，匹配不到 `/:token/info`。放在最前面纯粹是为了读起来
 * 先看到那条不带令牌的。
 */
shareRouter.post('/leave', async (req, res, next) => {
  try {
    // 先清 Cookie 再查用户：leave 必须是幂等的、且不管查得到查不到都成功。
    // 它唯一的副作用是"这个浏览器不再带着令牌"，那件事不该取决于存储读得通。
    clearUserCookie(res);

    // 这里读 Cookie 而不是 req.actor：本机（回环）请求会被 resolveActor 直接
    // 判成 admin，即使它同时带着一枚 pc_user——摄影师在自己机器上开着访客
    // 标签页调试就是这种情况，那时 req.actor.kind 是 'admin'，拿不到用户。
    const token = presentedToken(req);
    if (token) {
      const user = await findUserByToken(token);
      const share = user ? await getShareById(user.shareId) : null;
      if (user && share) {
        await logShareEvent(share, {
          actor: user.id, nickname: user.nickname, action: 'session.disconnect',
        });
      }
    }
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

/**
 * 「约 N 张照片」那行字。知道就给数字，不知道就给 null——**永远不给 0 当占位**。
 *
 *   没开库 -> null   扫完了 -> 张数   正在扫 -> null（assets 此时是空壳）
 */
function assetCountHint(share) {
  const session = getSessionByRoot(share.root);
  if (!session || !session.scan.done) return null;
  return session.assets.length;
}

shareRouter.get('/:token/info', async (req, res, next) => {
  try {
    const share = await resolveToken(req.params.token);
    const status = shareStatus(share, Date.now());
    if (status !== 'active') return denyLink(req, res, share, status);

    // 成功的 info 不记日志：它是无身份可达的，记了等于给任何拿到链接的人
    // 一个往摄影师磁盘上写文件的按钮。被拒的那条记，因为管理员需要看见
    // "有人在拿失效链接敲门"，而那条路径受限流约束（20 次/60 秒）。
    return res.json({
      label: share.label,
      // 会话没开着时服务端没有任何**免代价**的途径知道有多少张照片：
      // 为了回答一个无身份请求去扫一遍文件夹，等于把 info 变成一个
      // 谁都能按的磁盘压力按钮。字段名本身就是 Hint——不知道就是 null。
      // getSessionByRoot 是纯查表（不 realpath、不扫描、不开库），
      // 而 share.root 建分享时就 realpath 过，正是注册表用的那个键。
      //
      // scan.done 这道闸不能省：assets 在扫完之前一直是空数组，
      // 少了它这里会返回 0，而前端只判 `!= null`，客人就会看到
      // 「约 0 张照片」——一句读起来像"这个库是空的"的假话。
      assetCountHint: assetCountHint(share),
      allowUserCreation: share.allowUserCreation === true,
      // 本设计没有第二种进入方式：进来就要有个名字，否则审计日志记不下"谁做的"。
      requiresNickname: true,
      expiresAt: share.expiresAt ?? null,
    });
  } catch (err) { return next(err); }
});

shareRouter.post('/:token/join', async (req, res, next) => {
  try {
    const share = await resolveToken(req.params.token);
    const status = shareStatus(share, Date.now());
    if (status !== 'active') return denyLink(req, res, share, status);

    const normalized = normalizeNickname(req.body?.nickname);
    if (!normalized.ok) {
      await logShareEvent(share, {
        actor: 'anonymous', action: 'user.denied',
        reason: 'bad-nickname', detail: normalized.reason,
      });
      return fail(req, res, 400, {
        error: 'bad-nickname',
        reason: normalized.reason,
        message: BAD_NICKNAME_MESSAGES[normalized.reason] ?? '这个昵称不能用，换一个吧',
      });
    }

    /**
     * 昵称唯一性先于 allowUserCreation 判定，顺序是有意的（规格 §5.2 的两句话
     * 合起来只有这一种读法）：
     *   - "同一分享内昵称唯一，已被占用时返回 409" 是**无条件**的；
     *   - creation-off 的触发条件写的是"allowUserCreation === false **且昵称不存在**"。
     *
     * 反过来（占用的昵称在 creation 关掉时放行成"拿回身份"）看着像是给
     * 丢了 Cookie 的老客户留的后门，实际上是一个身份顶替漏洞：任何拿到链接的人
     * 只要打出"新娘小林"就能继承她的全部操作记录，审计日志的价值一次清零。
     * 丢了 Cookie 的老客户走的是 resume；resume 不成立就只能换个昵称重新建号。
     */
    const existing = await findUserByNicknameKey(share.id, normalized.key);
    if (existing) {
      await logShareEvent(share, {
        actor: 'anonymous', nickname: normalized.nickname,
        action: 'user.denied', reason: 'nickname-taken',
      });
      return fail(req, res, 409, {
        error: 'nickname-taken', message: '这个昵称已经有人在用了，换一个吧',
      });
    }

    if (share.allowUserCreation !== true) {
      await logShareEvent(share, {
        actor: 'anonymous', nickname: normalized.nickname,
        action: 'user.denied', reason: 'creation-off',
      });
      return fail(req, res, 403, {
        error: 'creation-off', message: '这条链接已停止接纳新成员',
      });
    }

    // maxUsers 是软上限：两个人同时点开链接时这个"读计数 -> 建号"不是原子的，
    // 可能短暂超出一个人。做成原子的代价是把整张用户表的锁提到路由层，
    // 而超一个人的后果是"多进来一位客户"，与死锁风险不成比例。
    if (typeof share.maxUsers === 'number' && await countUsers(share.id) >= share.maxUsers) {
      await logShareEvent(share, {
        actor: 'anonymous', nickname: normalized.nickname,
        action: 'user.denied', reason: 'full',
      });
      return fail(req, res, 403, { error: 'full', message: '参与人数已达上限' });
    }

    // 开库排在建号**之前**：openSession 会因为文件夹被拔掉/不可写而抛错，
    // 排在后面的话磁盘上会留下一条谁也用不上的用户记录，而这个人手里没有
    // Cookie，重试 join 只会撞上自己刚刚占掉的昵称——一个进不去的死结。
    const session = await openSession(share.root);

    let user;
    try {
      user = await createUser(share.id, normalized.nickname, share.defaultRole);
    } catch (err) {
      // 上面那次查重和这里之间还有一个窗口（两个人同时提交同一个昵称）。
      // createUser 内部的唯一性检查是在文件锁里做的，是权威的那一次。
      if (err?.code === 'nickname-taken') {
        await logShareEvent(share, {
          actor: 'anonymous', nickname: normalized.nickname,
          action: 'user.denied', reason: 'nickname-taken',
        });
        return fail(req, res, 409, {
          error: 'nickname-taken', message: '这个昵称已经有人在用了，换一个吧',
        });
      }
      throw err;
    }

    setUserCookie(res, user.token);
    await logShareEvent(share, {
      actor: user.id, nickname: user.nickname, action: 'user.join', role: user.role,
    });
    return res.json(guestPayload(session, user, share));
  } catch (err) { return next(err); }
});

shareRouter.post('/:token/resume', async (req, res, next) => {
  try {
    const share = await resolveToken(req.params.token);
    const status = shareStatus(share, Date.now());
    // 链接本身失效时回的是和 info/join 一模一样的 404，**不**清 Cookie：
    // 那枚 Cookie 可能是另一条仍然有效的分享的，而且这条路径上多一个
    // Set-Cookie 就足以把三种无效原因区分开。
    if (status !== 'active') return denyLink(req, res, share, status);

    const token = presentedToken(req);
    if (!token) return needJoin(req, res, share, 'no-cookie', { clear: true });

    const user = await findUserByToken(token);
    if (!user) return needJoin(req, res, share, 'unknown-token', { clear: true });
    // 归属检查排在禁用检查之前：别条分享的用户在这里就该止步，
    // 不该让这条链接的处理函数去评价（更不该去清掉）另一条分享的凭据。
    if (user.shareId !== share.id) {
      return needJoin(req, res, share, 'wrong-share', { clear: false });
    }
    // `!== false` 而不是 `!user.disabled`：缺了这个字段的记录（旧版本写的、
    // 或者被手工改坏的）应该进不来，而不是默认可用。
    if (user.disabled !== false) {
      return needJoin(req, res, share, 'disabled', { clear: true, actor: user.id });
    }

    const session = await openSession(share.root);
    await touchUser(share.id, user.id);
    // 重新下发同一枚令牌：Cookie 没有 Max-Age，是会话 Cookie，重发一次
    // 只是让它跟着这次回访续上，不改变令牌本身。
    setUserCookie(res, user.token);
    await logShareEvent(share, {
      actor: user.id, nickname: user.nickname, action: 'user.resume', role: user.role,
    });
    return res.json(guestPayload(session, user, share));
  } catch (err) { return next(err); }
});

/** 测试钩子：限流器是模块级状态，用例之间必须能清干净。 */
export const _test = { failures, logShareEvent, guestPayload };
