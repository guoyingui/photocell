import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { assertWithin } from '../lib/safepath.js';
import { browseRoots, emitPerListener, getSession, getSessionByRoot } from '../lib/session.js';
import {
  createShare, getShareById, listShares, revokeShare, updateShare,
} from '../lib/shares.js';
import { countUsers, deleteUser, listUsers, updateUser } from '../lib/users.js';
import { eventsToCsv, readEvents } from '../lib/audit.js';
import { endShare, kickUser, notifyPeerMarks, notifyRoleChanged } from '../lib/presence.js';
import { logShareEvent } from './share.js';

/**
 * `/api/admin/*` —— 分享、用户、审计日志的管理面。
 *
 * 三条性质是这个文件存在的理由，别的都是围着它们的边角：
 *
 * 1. **任何返回用户列表的响应都不得含令牌。** 兑现方式是 `publicUser()`：
 *    **逐字段挑出来**，不是 spread 之后再 delete。后者在 users.js 将来多一个
 *    敏感字段时会默默漏出去，而这类泄露没有任何征兆——响应看起来完全正常。
 * 2. **建分享时 root 必须过 `assertWithin` + `realpathDeep`。** 两个理由：
 *    不做的话管理接口本身就是一条绕过路径边界的通道（`POST {root:'/etc'}`
 *    就能把任意目录变成一条公开链接）；而 `requirePerm` 判 wrong-library 用的是
 *    `session.root === share.root` 这个**裸串比较**，没归一化的 root 在 macOS 上
 *    （`/var/...` vs `/private/var/...`）恒不相等，合法访客会一律被挡在门外。
 * 3. **撤销是软删。** `revoked = true`，用户表和审计日志一个字节都不动——
 *    「谁在什么时候进来过」正是撤销之后才更需要的信息。
 * 4. **落库之后必须同时收口实时通道**（`presence.js` 的三个函数）。
 *    `resolveActor` 只管得住**新的** HTTP 请求；一条已经建立的 SSE 连接不受它管辖。
 *    少了这一步，撤销一条分享之后那位客人屏幕上的图还在、还在跟着别人的标记
 *    实时变化，直到他自己关掉标签页——「链接就是授权本身、撤销即刻生效」
 *    就只兑现了一半。三个调用点都紧跟在各自的存储写入之后，见下面的注释。
 */
export const adminRouter = express.Router();

/**
 * 整个路由器一律 requireAdmin，写在这里而不是逐条挂。
 *
 * 逐条挂的问题是它依赖每一个后来者都记得写上那一个参数，而漏掉一条的代价是
 * 一个拿到分享链接的客户能改自己的角色、能看全部审计日志。挂在路由器上，
 * 「忘记」这件事就不可能发生。**新增路由务必写在这一行之后。**
 */
adminRouter.use(requireAdmin);

// ─────────────────────────────────────────────────────────────────────────────
// 响应投影
// ─────────────────────────────────────────────────────────────────────────────

const ROLES = new Set(['viewer', 'editor']);

/** 一次 events 查询最多返回多少条。管理台的日志表一页远用不到这么多。 */
const MAX_EVENT_LIMIT = 1000;
const DEFAULT_EVENT_LIMIT = 100;

/** label 的长度上限。存储层不管这个，这里挡一下，免得一次误粘贴写进一整篇文章。 */
const MAX_LABEL_CODEPOINTS = 100;

/**
 * 分享的对外形状。
 *
 * **带着 `token`，这是有意的**：分享面板（Task 18）要靠它拼出 `/s/<token>`，
 * 服务端没有第二条通道把链接交回摄影师手里。这条路由本身只有管理员进得来
 * （回环地址或 `--admin-token`），令牌回到它的主人手里不是泄露。
 * 与之相对，**用户令牌永不出现在任何响应里**——见 publicUser()。
 */
function publicShare(share, extra = {}) {
  return {
    id: share.id,
    token: share.token,
    root: share.root,
    label: share.label,
    createdAt: share.createdAt,
    createdBy: share.createdBy,
    expiresAt: share.expiresAt ?? null,
    revoked: share.revoked === true,
    allowUserCreation: share.allowUserCreation === true,
    defaultRole: share.defaultRole,
    maxUsers: share.maxUsers ?? null,
    // 写成 `!== false` 而不是 `?? true`：老的 shares.json 里这个字段可能整个
    // 不存在，也可能被手工改成别的假值。这一条口径必须和服务端过滤那一处
    // （Task 20）**完全一致**，否则会出现「管理台显示公开、访客实际看不到」
    // 这种查都没法查的分歧——和 publicUser 的 disabled 是同一条理由。
    showPeerMarks: share.showPeerMarks !== false,
    selectionLimit: share.selectionLimit ?? null,
    ...extra,
  };
}

/**
 * 用户的对外形状。**逐字段挑出来**，`token` 和 `nicknameKey` 都不在列。
 *
 * `disabled` 用 `!== false` 归一，跟 `resolveActor` 的判定式保持同一个口径：
 * 缺了这个字段的记录（旧版本写的、被手工改坏的）在鉴权那边是进不来的，
 * 管理台就不能把它显示成"正常"——两处对同一条记录给出相反的答案，
 * 是管理员最没法排查的一类问题。
 */
function publicUser(user) {
  return {
    id: user.id,
    shareId: user.shareId,
    nickname: user.nickname,
    role: user.role,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt,
    disabled: user.disabled !== false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 入参校验
// ─────────────────────────────────────────────────────────────────────────────

class BadField extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

function badRequest(res, err) {
  return res.status(400).json({ error: 'bad-field', field: err.field, message: err.message });
}

function checkLabel(value) {
  if (typeof value !== 'string') throw new BadField('label', '标签必须是字符串');
  const label = value.trim();
  if ([...label].length > MAX_LABEL_CODEPOINTS) {
    throw new BadField('label', `标签最多 ${MAX_LABEL_CODEPOINTS} 个字符`);
  }
  return label;
}

function checkExpiresAt(value) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadField('expiresAt', '有效期必须是毫秒时间戳或 null');
  }
  return value;
}

function checkRole(field, value) {
  if (!ROLES.has(value)) {
    throw new BadField(field, '角色只能是 viewer 或 editor');
  }
  return value;
}

function checkBoolean(field, value) {
  if (typeof value !== 'boolean') throw new BadField(field, '必须是 true 或 false');
  return value;
}

function checkMaxUsers(value) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new BadField('maxUsers', '人数上限必须是不小于 1 的整数，或 null');
  }
  return value;
}

/** 只认这六个字段，与 shares.js 的 PATCHABLE_FIELDS 对齐（root / token 永不可改）。 */
const SHARE_FIELD_CHECKS = {
  label: (v) => checkLabel(v),
  expiresAt: (v) => checkExpiresAt(v),
  defaultRole: (v) => checkRole('defaultRole', v),
  allowUserCreation: (v) => checkBoolean('allowUserCreation', v),
  maxUsers: (v) => checkMaxUsers(v),
  showPeerMarks: (v) => checkBoolean('showPeerMarks', v),
  selectionLimit: (v) => {
    if (v !== null && (!Number.isInteger(v) || v < 1 || v > 10000)) {
      throw new BadField('selectionLimit', '选片上限必须是 1–10000 的整数，或 null 表示不限');
    }
    return v;
  },
};

/** 从请求体里挑出**显式给了的**分享字段并逐个校验，其余一概忽略。 */
function pickShareFields(body) {
  const out = {};
  for (const [field, check] of Object.entries(SHARE_FIELD_CHECKS)) {
    if (Object.prototype.hasOwnProperty.call(body, field)) out[field] = check(body[field]);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 共用查找
// ─────────────────────────────────────────────────────────────────────────────

const SHARE_NOT_FOUND = Object.freeze({ error: 'share-not-found', message: '这条分享不存在' });
const USER_NOT_FOUND = Object.freeze({ error: 'user-not-found', message: '这个用户不存在' });

/**
 * 取出 `:id` 对应的分享，不存在就直接回 404 并返回 null。
 *
 * **撤销和过期的分享一样返回**：管理台要能查一条已撤销分享的用户表和日志，
 * 那正是软删的意义所在。这里唯一拦下的是"不存在"。
 * 顺带它也是 `:id` 的唯一入口——只有存在于 shares.json 里的 id 才会被拿去拼
 * `~/.photocull/shares/<id>/` 这条路径，URL 里的任意字符串到不了文件系统。
 */
async function loadShare(req, res) {
  const share = await getShareById(req.params.id);
  if (!share) {
    res.status(404).json(SHARE_NOT_FOUND);
    return null;
  }
  return share;
}

async function loadUser(res, shareId, userId) {
  const user = (await listUsers(shareId)).find((u) => u.id === userId);
  if (!user) {
    res.status(404).json(USER_NOT_FOUND);
    return null;
  }
  return user;
}

/**
 * 这条分享此刻的在线人数。
 *
 * 在线 = 一条活着的 SSE 连接，与 presence.js 同一个口径（不做心跳，
 * 连接建立即上线、断开即下线）。三条边界都是有意的：
 *
 * - **按 userId 去重**：一个人开三个标签页是一个人，不是三个。
 * - **只数这条分享的访客**：同一个文件夹上可能挂着两条分享，它们共用同一个会话；
 *   数整个会话会把另一条链接的客人算到这条头上，而管理员正是要靠这个数字
 *   决定该不该撤销这条链接。
 * - **不数管理员**：摄影师自己在本机开着的界面不属于"这条链接的在线人数"。
 *
 * 没有会话时返回 0 —— 这不是"不知道"的占位：没有会话就不可能存在任何一条
 * 指向它的 SSE 连接，0 是确定的答案。
 */
function onlineCount(share) {
  const session = getSessionByRoot(share.root);
  if (!session) return 0;
  const ids = new Set();
  for (const { actor } of session.listeners) {
    if (actor?.kind !== 'user') continue;
    if (actor.share?.id !== share.id) continue;
    if (typeof actor.user?.id === 'string') ids.add(actor.user.id);
  }
  return ids.size;
}

/** 分享列表 / 单条分享共用的两个派生字段。 */
async function shareStats(share) {
  return { userCount: await countUsers(share.id), online: onlineCount(share) };
}

/** 会话 id 的两条通道，与 library.js 的 requireSession 一致。 */
function currentSessionRoot(req) {
  const sid = req.get('X-PhotoCull-Session') || String(req.query.sid ?? '');
  const session = getSession(sid);
  return session ? session.root : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 分享
// ─────────────────────────────────────────────────────────────────────────────

adminRouter.get('/shares', async (req, res, next) => {
  try {
    const shares = await listShares();
    const out = [];
    for (const share of shares) {
      out.push(publicShare(share, await shareStats(share)));
    }
    res.json({ shares: out });
  } catch (err) { next(err); }
});

adminRouter.post('/shares', async (req, res, next) => {
  try {
    const body = req.body ?? {};

    // root 取自显式入参或当前会话。两条来源都走同一次 assertWithin——
    // 会话的 root 早就是真实路径了，但"边界检查只对某些来源生效"是一条
    // 迟早会被绕过的规则，不给它留例外。
    const raw = typeof body.root === 'string' && body.root.trim() !== ''
      ? body.root
      : currentSessionRoot(req);
    if (raw === null) {
      return res.status(400).json({
        error: 'no-root',
        message: '没有指定要分享的文件夹，当前也没有打开着的库',
      });
    }

    let fields;
    try {
      fields = pickShareFields(body);
    } catch (err) {
      if (err instanceof BadField) return badRequest(res, err);
      throw err;
    }

    // assertWithin 越界时抛 SafePathError（status 403），由顶层错误中间件转成
    // 403 —— 与 /api/fs/* 和 /api/library/open 走的是同一条出口，不另造一套。
    const root = await assertWithin(await browseRoots(), raw);

    const share = await createShare({ root, ...fields });
    await logShareEvent(share, {
      actor: 'admin',
      action: 'share.create',
      root: share.root,
      label: share.label,
      expiresAt: share.expiresAt,
      defaultRole: share.defaultRole,
      allowUserCreation: share.allowUserCreation,
      maxUsers: share.maxUsers,
      // 这是条影响客户之间能看见什么的设置，建分享时就该在日志里留下口径，
      // 否则日后只能看到它被 PATCH 改成了什么，看不出它一开始是什么。
      showPeerMarks: share.showPeerMarks,
      selectionLimit: share.selectionLimit,
    });
    return res.json({ share: publicShare(share, await shareStats(share)) });
  } catch (err) { return next(err); }
});

adminRouter.patch('/shares/:id', async (req, res, next) => {
  try {
    const share = await loadShare(req, res);
    if (!share) return undefined;

    let fields;
    try {
      fields = pickShareFields(req.body ?? {});
    } catch (err) {
      if (err instanceof BadField) return badRequest(res, err);
      throw err;
    }

    // 只把**真的变了**的字段记进 from/to。一条 `{}` 的变更记录读起来像是
    // 发生过什么，实际什么也没发生，是审计日志里最容易误导人的一种噪音。
    const from = {};
    const to = {};
    for (const [field, value] of Object.entries(fields)) {
      if (share[field] === value) continue;
      from[field] = share[field] ?? null;
      to[field] = value;
    }

    const updated = await updateShare(share.id, fields);
    if (Object.keys(to).length > 0) {
      await logShareEvent(updated, { actor: 'admin', action: 'share.update', from, to });
    }

    // 判据用 `to` 而不是"请求体里带了这个字段"：`to` 是上面那段算出来的
    // **真的变了**的字段。把已经是 false 的再设一次 false 也推一帧的话，
    // 该分享每个在线访客都会白重拉一次标记，而屏幕上什么都不会变。
    if (Object.prototype.hasOwnProperty.call(to, 'showPeerMarks')) {
      notifyPeerMarks(updated.id, updated.showPeerMarks !== false);
    }
    if (Object.prototype.hasOwnProperty.call(to, 'selectionLimit')) {
      const session = getSessionByRoot(updated.root);
      if (session) emitPerListener(session, (listener) => listener.actor.kind === 'user'
        && listener.actor.share.id === updated.id ? { type: 'selection-policy' } : null);
    }
    return res.json({ share: publicShare(updated, await shareStats(updated)) });
  } catch (err) {
    if (err?.code === 'share-not-found') return res.status(404).json(SHARE_NOT_FOUND);
    return next(err);
  }
});

adminRouter.delete('/shares/:id', async (req, res, next) => {
  try {
    const share = await loadShare(req, res);
    if (!share) return undefined;

    // **软删**：只把 revoked 置 true。用户表和 events.jsonl 一个字节都不动。
    // 硬删会把"谁在什么时候进来过、都干了什么"一起抹掉——而那恰恰是撤销
    // 之后最需要回答的问题（"我为什么要撤销这条链接"）。
    const revoked = await revokeShare(share.id);

    // 断流排在写审计日志**之前**：撤销的语义是立刻生效，不该先等一次磁盘写。
    // 只断这条分享的访客——管理员自己的连接、以及指向同一个文件夹的**另一条**
    // 分享的访客都不受影响（被撤销的是链接，不是这个文件夹），由 endShare 保证。
    endShare(share.id, 'revoked');

    await logShareEvent(revoked, { actor: 'admin', action: 'share.revoke' });
    return res.json({ ok: true, share: publicShare(revoked, await shareStats(revoked)) });
  } catch (err) {
    if (err?.code === 'share-not-found') return res.status(404).json(SHARE_NOT_FOUND);
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 名册
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 当前文件夹下所有分享的用户目录（规格 §7.2）。
 *
 * 客户维度的筛选下拉要列出**所有贡献过的人**，包括早就离线的、以及
 * 走另一条链接进来的。客户端手里只有一份在线名单（SSE 推的 presence），
 * 解析不出他们的昵称（README《当前行为里几条必须先知道的事》第 6 条）。
 *
 * `adminRouter.use(requireAdmin)` 已经把整个路由器保护起来了，
 * 管理员本来就读得到这些文件（审计日志页面已经在读），不新增任何权限。
 *
 * **令牌不进这个响应**，只有 id 和 nickname。
 */
adminRouter.get('/library-users', async (req, res, next) => {
  try {
    const root = currentSessionRoot(req);
    if (root === null) {
      return res.status(400).json({ error: 'no-session', message: '还没有打开任何文件夹' });
    }
    // 已撤销 / 已过期的分享**照常算进来**：他们的贡献还留在 contrib 里，
    // 筛得出记录却叫不出名字才是问题。
    const shares = (await listShares()).filter((s) => s.root === root);
    const seen = new Map();
    for (const share of shares) {
      for (const user of await listUsers(share.id)) {
        // 同一个人不可能跨分享共享 id，所以这里的去重只防同一条分享被
        // 重复列出；用 Map 而不是数组是为了让"第一条赢"这件事显式。
        if (!seen.has(user.id)) seen.set(user.id, { id: user.id, nickname: user.nickname });
      }
    }
    res.json({ users: [...seen.values()] });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 用户
// ─────────────────────────────────────────────────────────────────────────────

adminRouter.get('/shares/:id/users', async (req, res, next) => {
  try {
    const share = await loadShare(req, res);
    if (!share) return undefined;
    const users = await listUsers(share.id);
    return res.json({ users: users.map(publicUser) });
  } catch (err) { return next(err); }
});

adminRouter.patch('/shares/:id/users/:uid', async (req, res, next) => {
  try {
    const share = await loadShare(req, res);
    if (!share) return undefined;
    const user = await loadUser(res, share.id, req.params.uid);
    if (!user) return undefined;

    const body = req.body ?? {};
    const patch = {};
    try {
      if (Object.prototype.hasOwnProperty.call(body, 'role')) {
        patch.role = checkRole('role', body.role);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'disabled')) {
        patch.disabled = checkBoolean('disabled', body.disabled);
      }
    } catch (err) {
      if (err instanceof BadField) return badRequest(res, err);
      throw err;
    }
    if (Object.keys(patch).length === 0) {
      // 明确拒绝而不是当成空操作：字段名打错时静默返回 200 会让管理员以为
      // 自己已经把人改成只读了，而那个人还在写。
      return res.status(400).json({
        error: 'empty-patch', message: '没有可修改的字段（只能改 role 和 disabled）',
      });
    }

    const wasDisabled = user.disabled !== false;
    const updated = await updateUser(share.id, user.id, patch);

    // 落库之后立刻收口他的实时通道，同样排在写审计日志之前。
    //
    // 改角色**不断连接**，只推一条 role 事件：被改成只读的人应该继续看得见照片，
    // 把他踢下线是另一回事。只在角色真的变了时才推——一条 from === to 的通知
    // 会让客户端白闪一次权限变更提示。
    if (patch.role !== undefined && patch.role !== user.role) {
      notifyRoleChanged(user.id, patch.role);
    }
    // 禁用**必须断连接**，而且不看它之前是不是已经被禁用过：这里要的是
    // 「这个人此刻不能再连着」这个结果，不是「这次请求改变了什么」。
    // 一条因为任何原因残留下来的连接，都该在管理员按下禁用时被收掉。
    // 一次 PATCH 同时改角色又禁用时，他会先收到 role 再收到 kicked——
    // 断开压过一切，最终结果与只禁用没有区别。
    if (patch.disabled === true) kickUser(user.id, 'disabled');

    // actor 恒为 'admin'（这两件事只有管理员做得了），nickname 记的是**被改的那个人**——
    // CSV 里一行读作「admin | 新娘小林 | user.role-change | {from,to}」，
    // 正好是管理员回头要查的那句话。真正稳定的定位靠 targetUserId。
    const trail = { actor: 'admin', nickname: user.nickname, targetUserId: user.id };
    if (patch.role !== undefined && patch.role !== user.role) {
      await logShareEvent(share, {
        ...trail, action: 'user.role-change', from: user.role, to: patch.role,
      });
    }
    if (patch.disabled !== undefined && patch.disabled !== wasDisabled) {
      await logShareEvent(share, {
        ...trail, action: patch.disabled ? 'user.disable' : 'user.enable',
      });
    }
    return res.json({ user: publicUser(updated) });
  } catch (err) { return next(err); }
});

adminRouter.delete('/shares/:id/users/:uid', async (req, res, next) => {
  try {
    const share = await loadShare(req, res);
    if (!share) return undefined;
    const user = await loadUser(res, share.id, req.params.uid);
    if (!user) return undefined;

    await deleteUser(share.id, user.id);

    // 令牌这一刻就不存在了，那条还开着的连接更不能留着。
    // reason 用 'disabled' 而不是另造一个 'deleted'：规格 §6.3 里 kicked 只有
    // 这一个 reason，而前端对两者是同一个阻断层（"你已被移出这次选片"）。
    // 需要区分禁用和删除的是**管理员的审计日志**（见下面的 user.delete），
    // 不是被踢的那个人的界面。
    kickUser(user.id, 'disabled');

    // 删除是这组管理操作里**唯一不可撤销**的那一个，恰恰最需要留痕。
    // 记成 user.disable 会把可恢复的禁用和不可恢复的删除混成一件事，
    // 所以用一个自己的动作名 user.delete（已收进 audit.js 的 ACTIONS 和规格 3.4）。
    await logShareEvent(share, {
      actor: 'admin',
      nickname: user.nickname,
      action: 'user.delete',
      targetUserId: user.id,
      role: user.role,
    });
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 审计日志
// ─────────────────────────────────────────────────────────────────────────────

function intParam(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 空串一律当"没给这个过滤条件"：`?actor=` 该是不过滤，不是筛出 actor === ''。 */
function stringParam(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function eventQuery(req) {
  const before = intParam(req.query.before, undefined);
  return {
    before: Number.isFinite(before) ? before : undefined,
    actor: stringParam(req.query.actor),
    action: stringParam(req.query.action),
  };
}

/**
 * 分页按**序号**切，不按时间戳切。
 *
 * `readEvents` 的 `before` 是 `ts <` 的严格过滤，而同一毫秒里写进来好几条事件
 * 是常态（一次批量标记、一次撤销带出的连锁事件）。用"下一页从最后一条的 ts
 * 往前取"做游标，页边界上同 ts 的兄弟会被整批跳过——审计日志丢行是这里最不能
 * 接受的一种 bug，而且它悄无声息。事件记录没有稳定 id，去重也无从做起。
 *
 * 代价为零：`readEvents` 本来就要把整份日志读进内存再过滤，limit 只是最后一刀。
 * 所以在这里 slice 不比让它 slice 多读任何东西，还顺带能给出准确的 total。
 */
adminRouter.get('/shares/:id/events', async (req, res, next) => {
  try {
    const share = await loadShare(req, res);
    if (!share) return undefined;

    const limit = Math.min(Math.max(intParam(req.query.limit, DEFAULT_EVENT_LIMIT), 1), MAX_EVENT_LIMIT);
    const offset = Math.max(intParam(req.query.offset, 0), 0);

    const all = await readEvents(share.id, eventQuery(req));
    return res.json({
      events: all.slice(offset, offset + limit),
      total: all.length,
      offset,
      limit,
    });
  } catch (err) { return next(err); }
});

adminRouter.get('/shares/:id/events.csv', async (req, res, next) => {
  try {
    const share = await loadShare(req, res);
    if (!share) return undefined;

    // 导出默认不设 limit：这份文件的用途就是"把全部记录拿走"。
    const limit = req.query.limit === undefined ? undefined
      : Math.min(Math.max(intParam(req.query.limit, DEFAULT_EVENT_LIMIT), 1), MAX_EVENT_LIMIT);
    const events = await readEvents(share.id, { ...eventQuery(req), limit });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    // 文件名里的 share.id 来自 shares.json（loadShare 已经确认过它存在），
    // 不是 URL 里的原样字符串，所以头里不会被塞进换行之类的东西。
    res.setHeader('Content-Disposition', `attachment; filename="photocull-events-${share.id}.csv"`);
    return res.send(eventsToCsv(events));
  } catch (err) { return next(err); }
});
