import express from 'express';
import { requirePerm } from '../middleware/auth.js';
import { requireSession } from './library.js';
import { readReview, updateReview } from '../lib/review.js';
import { emitPerListener } from '../lib/session.js';

export const reviewRouter = express.Router();
const actorId = (actor) => actor.kind === 'admin' ? 'admin' : actor.user.id;

reviewRouter.get('/review', requirePerm('read'), requireSession, async (req, res, next) => {
  try {
    const known = new Set(req.session.assets.map((asset) => asset.id));
    res.json({ reviewed: (await readReview(req.session.root, actorId(req.actor))).filter((id) => known.has(id)) });
  } catch (err) { next(err); }
});

// 只读访客也可记录自己的浏览进度，不能改照片标记或其他人的进度。
reviewRouter.put('/review', requirePerm('read'), requireSession, async (req, res, next) => {
  try {
    const { ids, seen } = req.body ?? {};
    const known = new Set(req.session.assets.map((asset) => asset.id));
    if (!Array.isArray(ids) || ids.length > 10000 || typeof seen !== 'boolean'
      || ids.some((id) => typeof id !== 'string' || !known.has(id))) {
      return res.status(400).json({ error: '请选择当前文件夹中的照片，并指定已看过或未看' });
    }
    const actor = actorId(req.actor);
    const reviewed = await updateReview(req.session.root, actor, ids, seen);
    const event = { type: 'review', ids, seen };
    emitPerListener(req.session, (listener) => actorId(listener.actor) === actor ? event : null);
    res.json({ reviewed: reviewed.filter((id) => known.has(id)) });
  } catch (err) { next(err); }
});
