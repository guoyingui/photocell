import express from 'express';
import { requireAdmin, requirePerm } from '../middleware/auth.js';
import { requireSession } from './library.js';
import { listShares } from '../lib/shares.js';
import { listUsers } from '../lib/users.js';
import { logShareEvent } from './share.js';
import { ownPickedIds, publishSelection, readSelections, selectionError, selectionView, withSelectionLock } from '../lib/selections.js';

export const selectionsRouter = express.Router();

function requireCustomer(req, res, next) {
  if (req.actor.kind !== 'user') return res.status(403).json({ error: 'customer-only', message: '只有客户能提交自己的选片' });
  next();
}

function checkNote(value) {
  if (typeof value !== 'string' || [...value].length > 2000) throw selectionError('备注最多 2000 个字符', 400);
  return value.trim();
}

selectionsRouter.get('/selection', requirePerm('read'), requireSession, async (req, res, next) => {
  try {
    if (req.actor.kind === 'admin') return res.json({ selection: null });
    const data = await readSelections(req.session.root);
    res.json({ selection: selectionView(req.session, req.actor.user, req.actor.share, data.people[req.actor.user.id]) });
  } catch (err) { next(err); }
});

selectionsRouter.put('/selection', requirePerm('write'), requireSession, requireCustomer, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const patch = {};
    if ('note' in body) patch.note = checkNote(body.note);
    if ('photoNotes' in body) {
      if (!body.photoNotes || typeof body.photoNotes !== 'object' || Array.isArray(body.photoNotes)) {
        throw selectionError('照片备注必须按照片编号填写', 400);
      }
      patch.photoNotes = {};
      for (const [id, note] of Object.entries(body.photoNotes)) {
        if (!req.session.byId.has(id)) throw selectionError(`未知照片：${id}`, 400);
        patch.photoNotes[id] = checkNote(note);
      }
    }
    if (!Object.keys(patch).length) throw selectionError('请填写选片备注或照片备注', 400);
    await withSelectionLock(req.session.root, async (data, save) => {
      const current = data.people[req.actor.user.id] ?? {};
      if (['submitted', 'confirmed'].includes(current.status)) throw selectionError('选片已锁定，请联系摄影师重新开放修改');
      const photoNotes = { ...current.photoNotes, ...patch.photoNotes };
      for (const [id, note] of Object.entries(photoNotes)) if (!note) delete photoNotes[id];
      data.people[req.actor.user.id] = { ...current, ...patch, photoNotes, status: 'draft',
        userId: req.actor.user.id, shareId: req.actor.share.id, nickname: req.actor.user.nickname,
        revision: (current.revision ?? 0) + 1 };
      await save();
    });
    res.json({ selection: await publishSelection(req.session, req.actor.user, req.actor.share) });
  } catch (err) { next(err); }
});

selectionsRouter.post('/selection/submit', requirePerm('write'), requireSession, requireCustomer, async (req, res, next) => {
  try {
    await withSelectionLock(req.session.root, async (data, save) => {
      const current = data.people[req.actor.user.id] ?? {};
      if (['submitted', 'confirmed'].includes(current.status)) throw selectionError('这份选片已提交，请刷新后查看提交状态');
      const pickedIds = ownPickedIds(req.session, req.actor.user.id);
      if (!pickedIds.length) throw selectionError('请先收藏至少一张照片，再提交选片', 400);
      const supplied = req.body?.assetIds;
      if (!Array.isArray(supplied) || new Set(supplied).size !== pickedIds.length
        || supplied.length !== pickedIds.length || supplied.some((id) => !pickedIds.includes(id))) {
        throw selectionError('收藏清单已变化，请刷新并重新确认后提交');
      }
      const limit = req.actor.share.selectionLimit;
      if (Number.isInteger(limit) && pickedIds.length > limit) throw selectionError(`收藏超过 ${limit} 张，请减少后再提交`, 400);
      if (req.body?.revision !== (current.revision ?? 0)) throw selectionError('备注已变化，请刷新并重新确认后提交');
      await req.session.markStore.flush();
      data.people[req.actor.user.id] = { ...current, status: 'submitted', pickedIds,
        userId: req.actor.user.id, shareId: req.actor.share.id, nickname: req.actor.user.nickname,
        submittedAt: Date.now(), confirmedAt: null, revision: (current.revision ?? 0) + 1 };
      await save();
    });
    await logShareEvent(req.actor.share, { actor: req.actor.user.id, nickname: req.actor.user.nickname,
      action: 'selection.submit', count: ownPickedIds(req.session, req.actor.user.id).length });
    res.json({ selection: await publishSelection(req.session, req.actor.user, req.actor.share) });
  } catch (err) { next(err); }
});

async function libraryCustomers(session) {
  const people = new Map();
  for (const share of (await listShares()).filter((share) => share.root === session.root)) {
    for (const user of await listUsers(share.id)) people.set(user.id, { user, share });
  }
  return people;
}

selectionsRouter.get('/selections', requireAdmin, requireSession, async (req, res, next) => {
  try {
    const [customers, data] = await Promise.all([libraryCustomers(req.session), readSelections(req.session.root)]);
    res.json({ selections: [...customers.values()].map(({ user, share }) =>
      selectionView(req.session, user, share, data.people[user.id])) });
  } catch (err) { next(err); }
});

for (const action of ['confirm', 'reopen']) {
  selectionsRouter.post(`/selections/:userId/${action}`, requireAdmin, requireSession, async (req, res, next) => {
    try {
      const customer = (await libraryCustomers(req.session)).get(req.params.userId);
      if (!customer) throw selectionError('当前照片目录中没有这位客户，请刷新客户列表', 404);
      await withSelectionLock(req.session.root, async (data, save) => {
        const current = data.people[customer.user.id];
        if (!current || !['submitted', 'confirmed'].includes(current.status)) throw selectionError('客户尚未提交，请刷新后查看最新状态');
        if (action === 'confirm' && current.status === 'confirmed') throw selectionError('这份提交已经确认');
        data.people[customer.user.id] = { ...current, status: action === 'confirm' ? 'confirmed' : 'draft',
          ...(action === 'confirm' ? { confirmedAt: Date.now() } : { reopenedAt: Date.now() }),
          revision: (current.revision ?? 0) + 1 };
        await save();
      });
      await logShareEvent(customer.share, { actor: 'admin', targetUserId: customer.user.id,
        nickname: customer.user.nickname, action: `selection.${action}` });
      res.json({ selection: await publishSelection(req.session, customer.user, customer.share) });
    } catch (err) { next(err); }
  });
}
