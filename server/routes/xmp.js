import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { requireSession } from './library.js';
import { readAnnotations } from '../lib/annotations.js';
import { xmpFiles, zipFiles } from '../lib/xmp.js';
import { auditTargets } from './marks.js';
import { logShareEvent } from './share.js';

export const xmpRouter = express.Router();
xmpRouter.post('/xmp', requireAdmin, requireSession, async (req, res, next) => {
  try {
    const { assetIds } = req.body ?? {};
    const known = new Map(req.session.assets.map((asset) => [asset.id, asset]));
    if (!Array.isArray(assetIds) || !assetIds.length || assetIds.length > 10000 || assetIds.some((id) => !known.has(id))) {
      return res.status(400).json({ error: '请选择当前文件夹中的 1–10000 张照片' });
    }
    const { annotations } = await readAnnotations(req.session.root);
    const assets = [...new Set(assetIds)].map((id) => known.get(id));
    const files = xmpFiles(assets, annotations, req.session.markStore.data.finalMarks ?? {});
    const body = zipFiles(files);
    for (const share of await auditTargets(req)) await logShareEvent(share, { actor: 'admin', action: 'export.xmp', count: files.length });
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="photocull-xmp.zip"',
      'Cache-Control': 'no-store' }).send(body);
  } catch (err) { next(err); }
});
