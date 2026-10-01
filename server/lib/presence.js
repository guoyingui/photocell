import { listSessions } from './session.js';

/**
 * 在线状态 = SSE 连接本身。
 *
 * 没有心跳、没有"最后活跃时间"、没有超时判定。连接建立即上线，`req.on('close')`
 * 即下线。少一套超时判定，少一类幽灵在线——心跳方案里那个"人早就关了标签页，
 * 成员条上还挂着他两分钟"的窗口在这里根本不存在。
 *
 * 名单直接从 `session.listeners` 派生（每个 listener 带着自己的 actor），
 * 不另存一份状态：不存就不会不一致。
 */

/** 管理员在成员条上的显示名。管理员没有用户记录，id 固定为 'admin'。 */
const ADMIN_ENTRY = { id: 'admin', nickname: '摄影师', role: 'admin' };

/**
 * 把一个 actor 变成名单条目。
 *
 * **字段是白名单，不是 `...actor.user`。** 这条流对 viewer 也是开放的（Task 7），
 * 名单里出现的任何东西都等于直接发给了每一个拿到链接的人：
 * `user.token` 是密码本身，`share.root` 是摄影师磁盘上的绝对路径。
 * 一次不小心的展开就够了，所以这里只挑三个字段，多一个都得过这行代码。
 */
function entryOf(actor) {
  if (!actor) return null;                       // 测试里的假订阅者，没有身份
  if (actor.kind === 'admin') return { ...ADMIN_ENTRY };
  if (actor.kind === 'user' && actor.user) {
    return { id: actor.user.id, nickname: actor.user.nickname, role: actor.user.role };
  }
  return null;                                   // 认不出的 kind 一律不进名单
}

/**
 * `viewer` 看得见 `subject` 这条连接吗。**名单按分享隔离。**
 *
 * 为什么必须隔离：同一个文件夹上完全可以挂着两条链接——摄影师给新人发一条、
 * 给父母发一条，正是这个功能被设计出来的用法。名单不过滤的话，父母那条链接的
 * 访客能在 `presence` 事件里读到新人那条链接的访客的昵称和 userId。他们彼此
 * 之间没有任何关系，摄影师也从来没有把他们介绍给对方。
 *
 * 这跟 routes/marks.js 的 `auditTargets` 特意拒绝做的是同一件事，那里的注释
 * 把它称作"一次跨分享的信息泄露"。同一份代码此前对同一件事持两种相反意见，
 * 这里跟 auditTargets 对齐。
 *
 * 三条规则：
 *
 * - **管理员全见。** 摄影师需要知道此刻一共有谁在看他的照片，不管从哪条链接进来。
 * - **管理员对每个人都可见。** 访客看到"摄影师"在线是这个功能的一部分——
 *   他不属于任何一条分享，隔离对他无从谈起。
 * - **访客之间按 shareId 同条才可见。** 认不出 viewer 的分享（缺字段、
 *   测试里的假监听者）时落到"只看得见管理员"，不确定的一律少给。
 *
 * 与此**刻意不同**的是标记广播（routes/marks.js 的 `marks` 事件）：那条保持
 * 全局。标记是单一共享集合（规格 §4.1），收到别人的改动是功能本身，不是泄露；
 * 而且不发的话两条链接的人会看到两份互相矛盾的结果。代价是归属角标里的 `by`
 * 可能指向一个不在你名单上的人——前端已有"已离开的成员"那条兜底，它会显示成
 * 一个叫不出名字的色块，行为可接受。
 */
function visibleTo(viewer, subject) {
  if (viewer?.kind === 'admin') return true;
  if (subject?.kind === 'admin') return true;
  const mine = viewer?.share?.id;
  if (typeof mine !== 'string' || mine === '') return false;
  return subject?.kind === 'user' && subject.share?.id === mine;
}

/**
 * `viewer` 这个身份看到的在线名单。同一个用户开多个标签页只出现一次
 * （按 userId 去重），否则一个人开三个标签页就会在成员条上显示成三个人。
 * 顺序是连接建立的先后（Set 保序），不额外排序。
 *
 * `viewer` 是**必填**的：这份名单是发给谁的，决定了里面该有谁。
 * 没有一个安全的缺省值——给它一个"不传就全见"的默认，等于让每一处忘记传参
 * 的调用点都悄悄变成一次泄露。
 */
export function onlineUsers(session, viewer) {
  const byId = new Map();
  for (const listener of session.listeners) {
    if (!visibleTo(viewer, listener.actor)) continue;
    const entry = entryOf(listener.actor);
    if (!entry) continue;
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

/**
 * 这个会话上此刻在线的**访客**人数（不含管理员）。
 *
 * 口径和 onlineUsers 完全一致：在线 = 一条活着的 SSE 连接，同一个用户开多个
 * 标签页只算一个人。两处差别只有一个——这里不数管理员：摄影师自己在本机
 * 开着的界面不是"访客"，把它算进去的话，他每次点"换文件夹"都会被自己拦下来。
 *
 * 不按 shareId 过滤（admin.js 的 onlineCount 按 shareId 过滤，因为它回答的是
 * "该不该撤销**这条**链接"）。这里回答的是"关掉这个库会踢掉几个人"，而关库
 * 会断掉这个会话上的每一条连接，不管它来自哪条分享。
 */
export function onlineGuestCount(session) {
  const ids = new Set();
  for (const listener of session.listeners) {
    const actor = listener.actor;
    if (actor?.kind !== 'user') continue;
    const id = actor.user?.id;
    if (typeof id === 'string' && id !== '') ids.add(id);
  }
  return ids.size;
}

export function presenceEvent(session, viewer) {
  return { type: 'presence', users: onlineUsers(session, viewer) };
}

/**
 * 广播名单。**每条连接收到的是自己那一份**，不是同一个事件的副本——
 * 这也是为什么这里不能走 `emit()`：那个函数的语义是"同一个事件发给所有人"，
 * 而名单恰恰是每个人都不一样的那一种。
 *
 * 代价是每条连接各算一次名单（O(连接数²)）。这个规模下无所谓：在线的是一场
 * 婚礼的宾客，不是一个公开广场；而且只在有人上下线、被踢、改角色时算一次。
 *
 * 一条如实记下的残留：另一条分享有人上下线时，这一条分享的人也会收到一帧
 * **内容完全没变**的名单。看不出是谁，只看得出"某个时刻发生了什么"。
 * 这条时间侧信道不在防御范围内（规格 §9.2 的口径），修它要给每条连接记住
 * 上一次发过什么，代价大于收益。
 */
export function broadcastPresence(session) {
  for (const listener of session.listeners) {
    try { listener.send(presenceEvent(session, listener.actor)); } catch { /* 订阅者已断开 */ }
  }
}

/**
 * 注册一条 SSE 连接并广播新名单。
 *
 * 新连接自己也在广播范围内——它拿到的第一份 presence 就是完整快照，
 * 不需要另开一个"先补发一次"的分支。
 */
export function addListener(session, listener) {
  session.listeners.add(listener);
  broadcastPresence(session);
}

/** 摘掉一条连接并广播新名单。已经被摘过（踢人路径）就什么都不做，不重复广播。 */
export function removeListener(session, listener) {
  if (!session.listeners.delete(listener)) return false;
  broadcastPresence(session);
  return true;
}

/**
 * 发一个事件给这条连接，然后**真的把它断掉**。
 *
 * 顺序是要求：先 send 再 end，客户端才收得到理由。
 * 先从名单里摘掉再 end()，是为了让紧随其后的 presence 广播不会再往一条
 * 正在关闭的连接上写。
 */
function evict(session, listener, event) {
  try { listener.send(event); } catch { /* 对端已经断了 */ }
  session.listeners.delete(listener);
  try { listener.end(); } catch { /* 同上 */ }
}

/** 遍历全部会话，对匹配 `match` 的连接执行 evict，最后每个受影响的会话广播一次名单。 */
function evictWhere(match, event) {
  let evicted = 0;
  for (const session of listSessions()) {
    const targets = [...session.listeners].filter((l) => match(l.actor));
    if (targets.length === 0) continue;
    for (const listener of targets) {
      evict(session, listener, event);
      evicted++;
    }
    broadcastPresence(session);
  }
  return evicted;
}

const isUser = (actor, userId) => actor?.kind === 'user' && actor.user?.id === userId;

/**
 * 这条连接是不是「某条分享下的访客」。管理员连接一律不算——他不属于任何
 * 一条分享，凡是按分享做的事（撤销、开关客户可见性）都不该动到他那一屏。
 */
const isShareGuest = (actor, shareId) => actor?.kind === 'user' && actor.share?.id === shareId;

/**
 * 用户被禁用/删除：推 `kicked` 并断开他的每一条连接（多标签页一起）。
 *
 * **断开是这个函数的全部意义。** 只发事件不断开的话，客户端可以忽略这条事件
 * 继续用这条流——那不叫踢人。返回被断掉的连接数。
 */
export function kickUser(userId, reason = 'disabled') {
  if (typeof userId !== 'string' || userId === '') return 0;
  return evictWhere((actor) => isUser(actor, userId), { type: 'kicked', reason });
}

/**
 * 分享被撤销/过期：推 `share-ended` 并断开**该分享**的全部访客连接。
 *
 * 只动这条分享的访客：
 * - 管理员连接绝不受影响——摄影师撤销一条链接正是为了继续在本机干活，
 *   把他自己的界面也打断是荒谬的；
 * - 指向同一个文件夹的**另一条**分享的访客同样不受影响——被撤销的是链接，
 *   不是这个文件夹。
 */
export function endShare(shareId, reason = 'revoked') {
  if (typeof shareId !== 'string' || shareId === '') return 0;
  return evictWhere((actor) => isShareGuest(actor, shareId), { type: 'share-ended', reason });
}

/**
 * 这条分享的「让客户看到彼此的标记」开关被改了：推 `peer-marks` 给该分享
 * **在线的访客**，让他们按新口径重拉一份标记。
 *
 * 两个方向都要推：true → false 要把别人的标记从她屏幕上撤掉——那是这个开关
 * 存在的全部意义，晚一步（等她下次刷新）就等于没关；false → true 要把它们
 * 放出来，否则摄影师在管理台上明明打开了，客户那边还是空的。
 *
 * 管理员的连接不推：他看到的从来就是全部，这个开关对他没有任何影响。
 * 和 endShare 不同，这里**不断开**任何连接，也不重播 presence——名单没变。
 *
 * ── 为什么要就地换掉 listener.actor ─────────────────────────────────────────
 * `listener.actor` 是**连接建立那一刻**的快照（见 routes/library.js 的
 * `{ send, end, actor: req.actor }`），里面那份 share 是当时从磁盘读出来的。
 * HTTP 请求每次都会重新 resolveActor，所以 GET /marks 拿到的开关永远是新的；
 * 但广播的过滤判据读的是这份快照——不换掉的话，摄影师把开关关上之后，
 * 她的界面确实会重拉一份过滤过的标记，可**别人后续每一次写入仍然会把完整的
 * 那一帧推给她**，刚过滤掉的东西又顺着 SSE 流回去了。
 *
 * 换掉整个对象而不是就地改 `actor.share.showPeerMarks`，理由和
 * notifyRoleChanged 一样：actor 引用的 share 对象可能被别处共享，
 * 原地改会顺手改到别的地方去。
 */
export function notifyPeerMarks(shareId, showPeerMarks) {
  if (typeof shareId !== 'string' || shareId === '') return 0;
  let notified = 0;
  for (const session of listSessions()) {
    for (const listener of session.listeners) {
      if (!isShareGuest(listener.actor, shareId)) continue;
      listener.actor = {
        ...listener.actor,
        share: { ...listener.actor.share, showPeerMarks },
      };
      try { listener.send({ type: 'peer-marks', showPeerMarks }); } catch { /* 对端已经断了 */ }
      notified++;
    }
  }
  return notified;
}

/**
 * 角色被改：推 `role` 给该用户自己的连接（客户端据此立即置灰），
 * 并把新角色同步进名单再广播一次，否则成员条上会一直显示旧权限。
 *
 * 改权限**不是**踢人，连接必须留着——被改成只读的人应该继续看得见照片。
 *
 * 这里换掉整个 actor 对象而不是就地改 `actor.user.role`：actor 是
 * resolveActor 那一刻的快照，不改动它引用的任何对象，就不会有"改了这条连接
 * 顺手改到别处"这种问题。
 */
export function notifyRoleChanged(userId, role) {
  if (typeof userId !== 'string' || userId === '') return 0;
  let updated = 0;
  for (const session of listSessions()) {
    let touched = false;
    for (const listener of session.listeners) {
      if (!isUser(listener.actor, userId)) continue;
      listener.actor = { ...listener.actor, user: { ...listener.actor.user, role } };
      try { listener.send({ type: 'role', userId, role }); } catch { /* 对端已经断了 */ }
      touched = true;
      updated++;
    }
    if (touched) broadcastPresence(session);
  }
  return updated;
}
