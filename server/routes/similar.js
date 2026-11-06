import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { requireSession } from './library.js';
import { emit } from '../lib/session.js';
import {
  clampThreshold, groupSimilar, hashAssets, saveHashCache, SIMILAR_MAX_ASSETS,
} from '../lib/similar.js';

export const similarRouter = express.Router();

/** 进度帧只带计数，不写文件名；同一个会话上的访客也会收到，但没有可泄露的内容。 */
let progressSeq = 0;

function captureTime(session, asset) {
  const meta = session.metas.get(asset.id);
  if (meta && Number.isFinite(meta.time) && meta.time > 0) return meta.time;
  return asset.jpgMtimeMs || asset.rawMtimeMs || 0;
}

/**
 * `GET /api/library/similar?threshold=8&dir=cam-a&scan=<客户端随机串>`
 *
 * admin-only，理由和 `/versions`、`/backups` 一致：这是摄影师的选片工具，
 * 不是访客界面的一部分；同时它会让服务端按需生成缩略图并做一轮图像计算，
 * 不能让任何持有分享链接的人反复触发。
 *
 * 分组在服务端完成，前端只拿 asset id；这样「相似」的判据只有一份实现，
 * 也不会把缩略图哈希这种内部数据下发给访客。
 *
 * `dir` 是**精确的目录**（与前端 dirFilter 口径一致），不传表示整个照片库。
 * 不递归展开：当前界面按目录筛选时，摄影师要处理的就是眼前这一层；
 * 想跨目录找重复，把范围切回整个库即可。
 */
similarRouter.get('/similar', requireAdmin, requireSession, async (req, res, next) => {
  const session = req.session;
  const started = Date.now();
  const threshold = clampThreshold(req.query.threshold);
  const dir = typeof req.query.dir === 'string' && req.query.dir !== ''
    ? req.query.dir.slice(0, 4096)
    : null;
  const scan = typeof req.query.scan === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(req.query.scan)
    ? req.query.scan
    : '';

  // 锚点按拍摄时间排列：组内第一张就是最早拍的那张，分组结果每次一致；
  // 拍摄时间缺失时退回文件时间，再退回 id，避免 0 把一批照片全挤到最前面。
  const hidden = new Set(Array.isArray(session.markStore.data.hidden) ? session.markStore.data.hidden : []);
  const scoped = session.assets
    .filter((asset) => !hidden.has(asset.id))
    .filter((asset) => dir === null || asset.dir === dir)
    .sort((a, b) => captureTime(session, a) - captureTime(session, b)
      || String(a.id).localeCompare(String(b.id)));
  const capped = scoped.length > SIMILAR_MAX_ASSETS;
  const assets = capped ? scoped.slice(0, SIMILAR_MAX_ASSETS) : scoped;
  const total = scoped.length;

  let done = 0;
  let lastEmit = 0;
  const progress = (running) => {
    if (!scan) return;
    emit(session, { type: 'similar-progress', scan, done, total: assets.length, running, seq: ++progressSeq });
  };

  try {
    progress(true);
    const result = await hashAssets(session, assets, (_done) => {
      done = _done;
      const now = Date.now();
      // 每 50 张或 150ms 发一帧。缓存命中时一轮扫描可能只花几十毫秒，
      // 按每 10 张发会把 SSE 变成刷屏机；进度条只需要看起来在动。
      if (done === assets.length || done % 50 === 0 || now - lastEmit >= 150) {
        lastEmit = now;
        progress(true);
      }
    });
    if (session.aborted) {
      progress(false);
      return res.status(409).json({ error: 'session-gone', message: '会话已失效或已被替换，请重新打开文件夹' });
    }
    await saveHashCache(session);
    const groups = groupSimilar(result.items, threshold);
    progress(false);
    res.json({
      threshold,
      dir,
      total,
      analyzed: result.analyzed,
      skipped: result.skipped,
      noPreview: result.noPreview,
      flat: result.flat,
      capped,
      durationMs: Date.now() - started,
      groups,
    });
  } catch (err) {
    progress(false);
    next(err);
  }
});
