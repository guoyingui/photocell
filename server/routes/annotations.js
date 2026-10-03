import express from 'express';
import { requireAdmin, requirePerm } from '../middleware/auth.js';
import { requireSession } from './library.js';
import { readAnnotations, updateAnnotations } from '../lib/annotations.js';
import { emit } from '../lib/session.js';
import { LABELS, STAGES } from '../../shared/annotations.js';
import { auditTargets } from './marks.js';
import { logShareEvent } from './share.js';

export const annotationsRouter = express.Router();
annotationsRouter.get('/annotations', requirePerm('read'), requireSession, async (req, res, next) => {
  try { res.json(await readAnnotations(req.session.root)); } catch (err) { next(err); }
});
annotationsRouter.put('/annotations', requireAdmin, requireSession, async (req, res, next) => {
  try {
    const { ids, patch } = req.body ?? {};
    const known = new Set(req.session.assets.map((asset) => asset.id));
    if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some((id) => !known.has(id))
      || !patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length
      || Object.keys(patch).some((key) => !['rating', 'label', 'stage', 'keywords'].includes(key))
      || ('rating' in patch && (!Number.isInteger(patch.rating) || patch.rating < 0 || patch.rating > 5))
      || ('label' in patch && !Object.hasOwn(LABELS, patch.label))
      || ('stage' in patch && !Object.hasOwn(STAGES, patch.stage))
      || ('keywords' in patch && (!Array.isArray(patch.keywords) || patch.keywords.length > 10
        || patch.keywords.some((word) => typeof word !== 'string' || word.trim().length > 50 || /[\u0000-\u001f]/.test(word))))) {
      return res.status(400).json({ error: '请选择当前照片，星级为 0–5，关键词最多 10 个、每个不超过 50 字' });
    }
    const result = await updateAnnotations(req.session.root, [...new Set(ids)], patch);
    emit(req.session, { type: 'annotations', ...result });
    for (const share of await auditTargets(req)) await logShareEvent(share, { actor: 'admin', action: 'annotations.update',
      count: new Set(ids).size, fields: Object.keys(patch) });
    res.json(result);
  } catch (err) { next(err); }
});
