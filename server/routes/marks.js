import express from 'express';
import { requireSession } from './library.js';
import { requireAdmin, requirePerm } from '../middleware/auth.js';
import { emit, emitPerListener } from '../lib/session.js';
import { visibleMark } from '../lib/contrib.js';
import { listShares, shareStatus } from '../lib/shares.js';
import { normalizeCellWidth } from '../lib/store.js';
import { logShareEvent } from './share.js';
import { guardSelectionWrite, publishSelection } from '../lib/selections.js';

export const marksRouter = express.Router();

/** setMark 只认这三种值；PUT /marks 必须在应用任何一条之前把全部条目校验完，保证请求要么整体生效要么整体不生效。 */
const VALID_MARK_VALUES = new Set(['pick', 'reject', null]);

/**
 * 一条 mark.bulk 事件里最多列出多少个 assetId（规格 3.4）。
 * 超出只记 count：审计日志是要被人打开、导出成 CSV 的，
 * 一行里塞三千个 id 只会让这份日志没法读，而"改了多少张"才是那条信息。
 */
const BULK_ID_LIMIT = 200;

/**
 * 发起者的身份。requirePerm('write') 已经保证走到这里的只有 admin 和 editor，
 * 所以这里不再兜底猜测——猜不出来是接线错了，应该响亮地失败而不是记成匿名。
 */
function actorOf(req) {
  if (req.actor?.kind === 'admin') return { id: 'admin', nickname: null };
  const user = req.actor.user;
  return { id: user.id, nickname: user.nickname };
}

/**
 * 这条请求 / 这条连接看得见别人的标记吗。
 *
 * 判据写成 `!== false`：老的 shares.json 里 showPeerMarks 可能整个不存在。
 * 这一条口径必须和 routes/admin.js 的 publicShare() 里那一处**完全一致**，
 * 否则会出现「管理台显示公开、访客实际看不到」这种查都没法查的分歧。
 *
 * 管理员永远看得见全部——这个开关的语义是「只影响点击链接的客户」。
 */
function seesPeerMarks(actor) {
  if (actor?.kind !== 'user') return true;
  return actor.share?.showPeerMarks !== false;
}

/**
 * 按 actor 派生出他该看到的那份标记：自己那一票优先，其次是摄影师那一票，
 * 别的客户那一票一律不存在（visibleMark 的规则，见 lib/contrib.js）。
 *
 * **必须在服务端做，不能只在前端过滤**——和 viewer 角色同一个理由：
 * 前端过滤只是把东西藏起来，数据照样发到了对方的浏览器里，
 * 打开开发者工具就看得见「妈妈收藏了哪些」。
 */
function marksFor(actor, contrib) {
  const userId = actor.user.id;
  const marks = {};
  for (const [id, entry] of Object.entries(contrib ?? {})) {
    const mark = visibleMark(entry, userId);
    if (mark !== null && mark !== undefined) marks[id] = mark;
  }
  return marks;
}

/** 客户只能拿到自己的原始意见，供重新打开页面和撤销使用。 */
function ownContribFor(actor, contrib) {
  return Object.fromEntries(Object.entries(contrib ?? {})
    .filter(([, votes]) => votes[actor.user.id])
    .map(([id, votes]) => [id, votes[actor.user.id]]));
}

/**
 * 这次写入该记进哪些分享的审计日志。
 *
 * - 访客：只记自己那条分享。**不**顺带记进同 root 的其它分享——那样等于把
 *   一条分享的用户 id 和昵称抄进另一批人的日志和 CSV 里，是一次跨分享的信息泄露。
 * - 管理员：管理员不属于任何一条分享，但他改的是所有人正在看的那份结果，
 *   所以按该会话 root 下的**每一条活跃分享**各记一条。已撤销/已过期的分享不记
 *   （它们已经没有参与者，记进去只是噪声）；一条分享都没有时不记——
 *   本机单机使用没有审计对象。
 *
 * 导出路由（routes/export.js 的 `export.run`）也用这一份，不另抄一份：
 * "这次操作该记进谁的日志"是一条**性质**，两处各写各的迟早会分叉成两种答案，
 * 而其中一种就是上面那条被特意拒绝掉的跨分享泄露。导出是 admin-only，
 * 所以它只会走到下面那条管理员分支。
 */
export async function auditTargets(req) {
  if (req.actor?.kind === 'user') return [req.actor.share];
  const now = Date.now();
  const all = await listShares();
  return all.filter((s) => s.root === req.session.root && shareStatus(s, now) === 'active');
}

/**
 * 把这一批改动折成一条审计事件。
 *
 * 单张是 mark.set（带 from/to，能看出"从没标过变成 pick"还是"把别人的 pick 改成 reject"），
 * 多张是 mark.bulk。混合值的一批（撤销一步可能同时恢复好几个不同的值）没有单一的 to，
 * 记成 'mixed'——不能记成 null，null 在这里有确切含义：清除标记。
 */
function markEvent(entries, before) {
  if (entries.length === 1) {
    const [id, mark] = entries[0];
    return { action: 'mark.set', assetId: id, from: before.get(id), to: mark };
  }
  const values = new Set(entries.map(([, mark]) => mark));
  const event = {
    action: 'mark.bulk',
    count: entries.length,
    to: values.size === 1 ? entries[0][1] : 'mixed',
  };
  if (entries.length <= BULK_ID_LIMIT) event.assetIds = entries.map(([id]) => id);
  return event;
}

/**
 * 留痕。用 share.js 的 logShareEvent 而不是直接调 logEvent，是因为脱敏令牌那一步
 * （share.token + 其下全部 user.token）必须只有一份实现：这条路径今天不往事件里放
 * 令牌，明天多一个字段就可能放进去，那时脱敏得由一个所有调用方共用的闸门兜住。
 * 它内部把写日志的失败吞成一行 console.error——审计写不进去是运维问题，
 * 不该让摄影师的标记因此 500。
 */
async function recordMarks(req, entries, before, actor) {
  const event = {
    actor: actor.id,
    ...(actor.nickname ? { nickname: actor.nickname } : {}),
    ...markEvent(entries, before),
  };
  for (const share of await auditTargets(req)) {
    await logShareEvent(share, event);
  }
}

marksRouter.get('/marks', requirePerm('read'), requireSession, (req, res) => {
  const { marks, settings, marksMeta, hidden, contrib, finalMarks, finalRevision } = req.session.markStore.data;

  if (!seesPeerMarks(req.actor)) {
    // 归属角标一并不给：它会把「这张是别的客户标的」原样说出来，
    // 等于绕过刚刚做的过滤。她自己那些标记的归属就是她自己，不必说。
    const visible = marksFor(req.actor, contrib);
    for (const [id, decision] of Object.entries(finalMarks)) visible[id] = decision.mark;
    return res.json({ marks: visible, settings, marksMeta: {}, hidden, finalMarks, finalRevision,
      ownContrib: ownContribFor(req.actor, contrib) });
  }

  // marksMeta / hidden 都是平行表，marks 的形状不变。
  // 老客户端读不到这两个字段也照常工作。
  const full = { marks, settings, marksMeta, hidden, finalMarks, finalRevision };
  // contrib 只给管理员：整张贡献表发给访客等于把上面那段过滤白做了，
  // 而按客户维度筛选本来也只有管理员那一侧用得到它。
  if (req.actor?.kind === 'admin') full.contrib = contrib;
  else if (req.actor?.kind === 'user') full.ownContrib = ownContribFor(req.actor, contrib);
  return res.json(full);
});

marksRouter.put('/marks', requirePerm('write'), requireSession, async (req, res, next) => {
  try {
    const patch = req.body?.marks;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ error: 'marks 必须是对象' });
    }
    // 先把 id 和标记值都校验一遍，确认整批合法后才动手写入——
    // 否则半路遇到非法值会抛出未捕获异常，前面已经生效的条目没法回滚，
    // 客户端看到 500 却以为整条请求都没生效。
    for (const [id, mark] of Object.entries(patch)) {
      if (!req.session.byId.has(id)) return res.status(400).json({ error: `未知资产：${id}` });
      if (!VALID_MARK_VALUES.has(mark)) {
        return res.status(400).json({ error: `非法标记值：${mark}（资产 ${id}）` });
      }
    }

    const entries = Object.entries(patch).map(([id, mark]) => [id, mark ?? null]);
    const actor = actorOf(req);
    // 整批共用一个时间戳：这一批在客户端是一次操作，归属上也该是一个瞬间，
    // 而不是按写入顺序散开几毫秒。
    const at = Date.now();
    // from 必须在动手之前取：写完再取只会拿到刚写进去的值。
    let before;
    // 不变量 3（server/lib/store.js 的 setMark）：给一张已隐藏的照片打标记会让它
    // 自动退出 data.hidden。这个变化不会被下面的 marks 事件描述——那条事件说的是
    // 标记，不是隐藏——不广播的话，其他客户端本地那份 hidden 集合就此过期，会继续
    // 把一张实际已经不隐藏的照片挡在「全部/收藏/排除」之外，直到下一次全量重连补拉。
    // 同一个套路：动手前拍一份快照，动手后比对，只有真的变了才广播。
    let hiddenBefore;

    // 受限访客的广播判据是「**她**看到的那个值有没有变」，所以要在动手之前
    // 为每条这样的连接各存一份旧的 visibleMark。不能复用上面那个 before：
    // 它存的是共编 marks 的旧值（审计日志的 from 用），而同一次写入对她意味着
    // 什么，取决于她自己有没有投过票——两者算出来的答案经常不一样。
    let beforeVisible;
    await guardSelectionWrite(req, entries, () => {
      before = new Map(entries.map(([id]) => [id, req.session.markStore.data.marks[id] ?? null]));
      hiddenBefore = new Set(req.session.markStore.data.hidden);
      beforeVisible = new Map();
      for (const listener of req.session.listeners) {
        if (seesPeerMarks(listener.actor)) continue;
        const uid = listener.actor.user.id;
        const snap = new Map();
        for (const [id] of entries) {
          snap.set(id, visibleMark(req.session.markStore.data.contrib?.[id], uid));
        }
        beforeVisible.set(listener, snap);
      }
      for (const [id, mark] of entries) req.session.markStore.setMark(id, mark, { by: actor.id, at });
    });
    // 落盘是防抖后台做的，这一批的结果这会儿还不知道；但**上一批**如果写失败了，
    // 错误就一直存在 markStore 里没人读——旧实现里它只有 close() 会看，中间几百次
    // PUT 全都无条件回 {ok:true}，摄影师在一个只读文件夹上标记三小时，界面全程显示
    // 成功，磁盘上一个字节都没有。这里取走并如实上报，前端已有的乐观更新回滚会接住。
    const err = req.session.markStore.takeError();
    if (err) {
      // 这条路径上**不广播也不留痕**：客户端收到 500 会把这一批回滚掉，
      // 广播出去等于让别人看到一个发起者自己已经撤销的值。
      return res.status(500).json({ error: 'persist-failed', message: `标记未能写入磁盘：${err.message}` });
    }

    if (entries.length > 0) {
      // SSE 现在对 viewer 开放，这个事件直达访客：里面只有资产 id、标记值、
      // actor id 和时间戳——没有令牌，也没有摄影师磁盘上的绝对路径。
      req.session.marksSeq = (req.session.marksSeq ?? 0) + 1;
      const seq = req.session.marksSeq;
      const contribNow = req.session.markStore.data.contrib;

      const openChanges = {};
      for (const [id] of entries) {
        const current = req.session.markStore.data.marksMeta[id];
        openChanges[id] = { mark: req.session.markStore.data.marks[id] ?? null,
          by: current?.by ?? actor.id, at: current?.at ?? at };
      }
      const contribChanges = Object.fromEntries(entries.map(([id, mark]) => [id, { by: actor.id, mark, at }]));

      // 每条连接单独算一帧。判据是**她看到的值有没有变**，而不是「把值换成
      // 她该看到的那个、照发不误」——后者泄露的是时机：她那一格在别人操作的
      // 瞬间重渲染一次，等于告诉她「刚才有人动了这张」。
      emitPerListener(req.session, (listener) => {
        const ownContribChanges = listener.actor.kind === 'user' && listener.actor.user.id === actor.id
          ? Object.fromEntries(entries.map(([id, mark]) => [id, { mark, at }])) : undefined;
        if (seesPeerMarks(listener.actor)) {
          return { type: 'marks', origin: actor.id, seq, changes: openChanges,
            ...(listener.actor.kind === 'admin' ? { contribChanges } : {}),
            ...(ownContribChanges ? { ownContribChanges } : {}) };
        }
        const uid = listener.actor.user.id;
        const was = beforeVisible.get(listener);
        const changes = {};
        for (const [id] of entries) {
          const now = req.session.markStore.data.finalMarks[id]?.mark ?? visibleMark(contribNow?.[id], uid);
          const previous = req.session.markStore.data.finalMarks[id]?.mark ?? was?.get(id);
          if (now === previous) continue;   // 她看到的没变，这一帧对她不存在
          // **不带 by / at**：归属角标会把「这张是谁标的」原样说出来，等于
          // 绕过过滤。这和 GET 给她 marksMeta: {} 是同一个决定，两处必须一致，
          // 否则她刷新前后看到的角标不一样。前端 applyMarksBroadcast 只在
          // by/at 都在时才写 meta，缺了就自然什么都不动。
          changes[id] = { mark: now ?? null };
        }
        return Object.keys(changes).length === 0 && !ownContribChanges
          ? null                                 // null = 这条连接不发
          : { type: 'marks', origin: actor.id, seq, changes,
            ...(ownContribChanges ? { ownContribChanges } : {}) };
      });

      // data.hidden 只会因为这一批标记变短（不变量 3 只摘除，PUT /marks 从不新增
      // 隐藏项——那是 PUT /hidden 一家的事），所以长度不等就足以断定"真的变了"。
      // origin 用 actor.id 而不是字面量 'admin'：这条路由 requirePerm('write')
      // 放行 editor（见上面 actorOf 的注释），触发这条广播的不一定是管理员。
      const hiddenNow = req.session.markStore.data.hidden;
      if (hiddenNow.length !== hiddenBefore.size) {
        emit(req.session, { type: 'hidden', origin: actor.id, hidden: hiddenNow });
      }

      await recordMarks(req, entries, before, actor);
      if (req.actor.kind === 'user') await publishSelection(req.session, req.actor.user, req.actor.share);
    }

    const data = req.session.markStore.data;
    const visible = seesPeerMarks(req.actor) ? data.marks : marksFor(req.actor, data.contrib);
    if (!seesPeerMarks(req.actor)) for (const [id, decision] of Object.entries(data.finalMarks)) visible[id] = decision.mark;
    res.json({ ok: true, marks: visible, finalRevision: data.finalRevision, marksMeta: seesPeerMarks(req.actor) ? data.marksMeta : {},
      ...(req.actor.kind === 'admin' ? { contrib: data.contrib } : { ownContrib: ownContribFor(req.actor, data.contrib) }) });
  } catch (err) { next(err); }
});

/** 摄影师的最终决定覆盖有效标记，保留每位客户原本的意见和提交。 */
marksRouter.put('/final-marks', requireAdmin, requireSession, async (req, res, next) => {
  try {
    const patch = req.body?.marks;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return res.status(400).json({ error: '请选择最终名单中的照片' });
    for (const [id, mark] of Object.entries(patch)) {
      if (!req.session.byId.has(id) || !VALID_MARK_VALUES.has(mark)) return res.status(400).json({ error: `无效的照片或决定：${id}` });
    }
    req.session.markStore.setFinalMarks(patch);
    await req.session.markStore.flush();
    const data = req.session.markStore.data;
    emitPerListener(req.session, (listener) => {
      const changes = {};
      for (const id of Object.keys(patch)) {
        const visible = seesPeerMarks(listener.actor) ? data.marks[id]
          : data.finalMarks[id]?.mark ?? visibleMark(data.contrib[id], listener.actor.user.id);
        changes[id] = { mark: visible ?? null, ...(seesPeerMarks(listener.actor) ? data.marksMeta[id] : {}) };
      }
      return { type: 'final-marks', finalMarks: data.finalMarks, finalRevision: data.finalRevision, changes, hidden: data.hidden };
    });
    for (const share of await auditTargets(req)) await logShareEvent(share, {
      actor: 'admin', action: 'selection.final', count: Object.keys(patch).length,
      ...(Object.keys(patch).length <= BULK_ID_LIMIT ? { marks: patch } : {}),
    });
    res.json({ finalMarks: data.finalMarks, finalRevision: data.finalRevision, marks: data.marks, marksMeta: data.marksMeta, contrib: data.contrib });
  } catch (err) { next(err); }
});

/**
 * 隐藏 / 取消隐藏（规格 §6）。
 *
 * **admin-only，和导出同一档。** 隐藏改变的是所有人眼前的那一屏，
 * 而它没有撤销入口——客户手一滑就能让摄影师的三百张照片凭空消失。
 * 这是硬编码，界面上找不到、配置里也没有一个开关可以放开它。
 */
marksRouter.put('/hidden', requireAdmin, requireSession, async (req, res, next) => {
  try {
    const ids = req.body?.ids;
    const hidden = req.body?.hidden;
    if (!Array.isArray(ids)) {
      return res.status(400).json({ error: 'ids 必须是数组' });
    }
    if (typeof hidden !== 'boolean') {
      return res.status(400).json({ error: 'hidden 必须是布尔值' });
    }
    // 和 PUT /marks 同一条规矩：整批校验完才动手，否则半路失败没法回滚。
    for (const id of ids) {
      if (typeof id !== 'string' || !req.session.byId.has(id)) {
        return res.status(400).json({ error: `未知资产：${id}` });
      }
    }

    // 留痕要记"这次调用真的让哪些 id 换了隐藏状态"，不是请求体里原样的 ids，
    // 也不是 setHidden 返回的那份**全量** hidden 集合——两者都可能在批里混进
    // 没有真的生效的 id（已标记而被跳过的、或者取消隐藏时本来就没被隐藏的）。
    // 取消隐藏这个方向没有 skipped 这一环，只能靠动手之前的快照才知道
    // 谁是"真的从隐藏状态被拉出来的"。
    const before = new Set(req.session.markStore.data.hidden);

    const result = req.session.markStore.setHidden(ids, hidden);

    const err = req.session.markStore.takeError();
    if (err) {
      return res.status(500).json({
        error: 'persist-failed', message: `隐藏状态未能写入磁盘：${err.message}`,
      });
    }

    // 广播整份 hidden 而不是增量：它是一个几百条的字符串数组，
    // 整份推的代价可以忽略，而增量要在两端各维护一套合并规则。
    emit(req.session, { type: 'hidden', origin: 'admin', hidden: result.hidden });

    // 留痕，口径与 settings.update 一致：只记这次调用**真的生效**的那些。
    // - hidden=true 时，混进请求里的已标记 id 进了 skipped，没有被隐藏，不能记成隐藏了；
    // - hidden=false 时，请求里本来就没被隐藏的 id，"取消隐藏"对它没有意义，不能记成生效了。
    // 一批全部被过滤掉时（比如全部是已标记的，或者全部本来就没被隐藏）什么都没
    // 真的发生：此时不留痕——一条"看起来发生了什么、实际什么也没发生"的记录，
    // 是审计日志里最容易误导人的噪音。
    const skippedSet = new Set(result.skipped);
    const affected = hidden
      ? ids.filter((id) => !skippedSet.has(id))
      : ids.filter((id) => before.has(id));

    if (affected.length > 0) {
      const event = {
        actor: 'admin',
        action: hidden ? 'hidden.add' : 'hidden.remove',
        count: affected.length,
        ...(affected.length <= BULK_ID_LIMIT ? { assetIds: affected } : {}),
        ...(result.skipped.length > 0 ? { skipped: result.skipped.length } : {}),
      };
      for (const share of await auditTargets(req)) {
        await logShareEvent(share, event);
      }
    }

    res.json({ ok: true, hidden: result.hidden, skipped: result.skipped });
  } catch (err) { next(err); }
});

/**
 * 全局设置。admin-only，访客改不了——所以下面留痕那一段只有管理员这一条路径。
 *
 * 为什么这条也要留痕：`burstThresholdMs` 决定**所有人看到的分组**。摄影师
 * 把它从 1 秒改成 5 秒，每个客户屏幕上的连拍堆当场重排，而在补上这段之前
 * 审计日志里一个字都没有——事后没人能解释"刚才那一屏为什么变了"。
 * 规格 3.4 的动作表里 `settings.update` 一直在，只是没有代码产生它。
 */
marksRouter.put('/settings', requireAdmin, requireSession, async (req, res, next) => {
  try {
    const allowed = ['burstThresholdMs', 'cellWidth', 'sort'];
    const clean = Object.fromEntries(
      Object.entries(req.body ?? {}).filter(([k]) => allowed.includes(k)));
    // 必须在算 from/to 之前归一：否则超范围的输入（比如 9999）会被审计日志
    // 原样记成 to，而实际落盘的是钳制后的值——日志会说谎。归一之后如果
    // 恰好和当前值相同，下面的 current[key] === value 会正确判定成没有变化。
    if ('cellWidth' in clean) clean.cellWidth = normalizeCellWidth(clean.cellWidth);
    if ('burstThresholdMs' in clean && (!Number.isInteger(clean.burstThresholdMs)
      || clean.burstThresholdMs < 0 || clean.burstThresholdMs > 10000)) {
      return res.status(400).json({ error: '连拍间隔需为 0–10000 毫秒的整数' });
    }

    // 变更前后的字段必须在动手之前算：setSettings 之后再取 from 只会拿到刚写进去的值。
    // 只把**真的变了**的字段记进 from/to，口径与 admin.js 的 share.update 一致——
    // 一条 {} 的变更记录读起来像是发生过什么，实际什么也没发生，
    // 是审计日志里最容易误导人的一种噪音。
    const current = req.session.markStore.data.settings;
    const from = {};
    const to = {};
    for (const [key, value] of Object.entries(clean)) {
      if (current[key] === value) continue;
      from[key] = current[key] ?? null;
      to[key] = value;
    }

    req.session.markStore.setSettings(clean);

    if (Object.keys(to).length > 0) {
      const event = { actor: 'admin', action: 'settings.update', from, to };
      for (const share of await auditTargets(req)) {
        await logShareEvent(share, event);
      }
    }

    await req.session.markStore.flush();
    emit(req.session, { type: 'settings', settings: req.session.markStore.data.settings });
    res.json({ ok: true, settings: req.session.markStore.data.settings });
  } catch (err) { next(err); }
});
