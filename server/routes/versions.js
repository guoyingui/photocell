import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { requireSession } from './library.js';
import { readSelections } from '../lib/selections.js';

export const versionsRouter = express.Router();
versionsRouter.get('/versions', requireAdmin, requireSession, async (req, res, next) => {
  try {
    const selections = await readSelections(req.session.root);
    const versions = [...(req.session.markStore.data.finalHistory ?? []),
      ...Object.values(selections.people).flatMap((person) => person.history ?? [])];
    res.json({ versions: versions.sort((a, b) => b.createdAt - a.createdAt) });
  } catch (err) { next(err); }
});
