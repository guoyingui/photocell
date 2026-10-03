import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { requireSession } from './library.js';
import { cacheStats, clearGeneratedCache } from '../lib/cache.js';
import { stopBake } from '../lib/bake.js';
import { emit } from '../lib/session.js';

export const cacheRouter = express.Router();
cacheRouter.get('/cache', requireAdmin, requireSession, async (req, res, next) => {
  try { res.json(await cacheStats(req.session.root)); } catch (err) { next(err); }
});
cacheRouter.delete('/cache', requireAdmin, requireSession, async (req, res, next) => {
  try {
    await stopBake(req.session);
    emit(req.session, { type: 'bake', ...req.session.bake });
    const removed = await clearGeneratedCache(req.session.root);
    emit(req.session, { type: 'cache-cleared' });
    res.json({ removed, ...(await cacheStats(req.session.root)) });
  } catch (err) { next(err); }
});
