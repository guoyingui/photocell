import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { requireSession } from './library.js';
import { backupBundle, createBackup, listBackups, readBackup, previewRestore, restoreBackup } from '../lib/backups.js';
import { closeSession, emit } from '../lib/session.js';
import { hasRunningExportJob } from './export.js';
import { auditTargets } from './marks.js';
import { logShareEvent } from './share.js';

export const backupsRouter = express.Router();
backupsRouter.get('/backups', requireAdmin, requireSession, async (req, res, next) => {
  try { res.json({ backups: await listBackups(req.session.root) }); } catch (err) { next(err); }
});
backupsRouter.post('/backups', requireAdmin, requireSession, async (req, res, next) => {
  try {
    const bundle = await backupBundle(req.session);
    const id = await createBackup(req.session, 'manual', bundle);
    res.json({ id, bundle });
  } catch (err) { next(err); }
});
backupsRouter.get('/backups/:id', requireAdmin, requireSession, async (req, res, next) => {
  try { res.set('Cache-Control', 'no-store').json(await readBackup(req.session.root, req.params.id)); }
  catch (err) { next(err); }
});
backupsRouter.post('/backups/preview', requireAdmin, requireSession, async (req, res, next) => {
  try { res.json(await previewRestore(req.session, req.body?.bundle)); } catch (err) { next(err); }
});
backupsRouter.post('/backups/restore', requireAdmin, requireSession, async (req, res, next) => {
  try {
    if (hasRunningExportJob(req.session.root)) return res.status(409).json({ error: '请等待当前目录的导出结束或先取消，再恢复备份' });
    const result = await restoreBackup(req.session, req.body?.bundle, req.body?.token, req.body?.confirmName);
    for (const share of await auditTargets(req)) await logShareEvent(share, { actor: 'admin', action: 'backup.restore', safetyId: result.safetyId });
    // 旧会话全部作废，已排队的旧标记和离线客户端不能把恢复后的数据再覆盖。
    req.session.restoring = true;
    emit(req.session, { type: 'library-restored' });
    await closeSession(req.session.id);
    res.json(result);
  } catch (err) { next(err); }
});
