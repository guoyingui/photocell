import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertWithin } from '../lib/safepath.js';
import { browseRoots } from '../lib/session.js';
import { requireAdmin } from '../middleware/auth.js';
import { isLoopback } from '../lib/actor.js';
import { nativeFolderCapability, chooseNativeFolder } from '../lib/nativeFolder.js';

export const fsRouter = express.Router();

fsRouter.get('/native-folder', requireAdmin, async (req, res, next) => {
  try { res.json({ available: isLoopback(req) && Boolean(await nativeFolderCapability()) }); }
  catch (err) { next(err); }
});
fsRouter.post('/native-folder', requireAdmin, async (req, res, next) => {
  if (!isLoopback(req)) return res.status(403).json({ error: 'local-only', message: '请在运行 PhotoCull 的电脑上打开系统文件夹窗口' });
  if (req.body?.open !== true) return res.status(400).json({ error: '请通过系统选择文件夹按钮打开窗口' });
  try {
    const selected = await chooseNativeFolder();
    res.json({ path: selected ? await assertWithin(await browseRoots(), selected) : null });
  } catch (err) { next(err); }
});

/**
 * 这三条路由全部 requireAdmin，没有例外。
 *
 * `/api/fs/*` 是一个能列出本机文件系统结构的接口——它的边界是 browseRoots()，
 * 那条边界防的是"越界读取"，不是"谁在读"。一个拿到分享链接的客户永远没有理由
 * 知道摄影师的主目录里有哪些文件夹，更没有理由在里面建目录。
 * 这是 Global Constraints 里逐字写死的一条，不是可配置开关。
 */

/**
 * fs.readdir 抛出的原始错误消息里带着服务器的绝对路径（例如 "scandir '/private/var/.../secret'"），
 * 直接透传给客户端既没意义又泄露服务器目录结构。这里把三种可预见的失败原因
 * 映射成不带路径的通用提示；映射表之外的错误仍然交给顶层错误中间件当 500 处理。
 */
const LIST_ERROR_STATUS = {
  ENOTDIR: [400, '该路径不是文件夹'],
  ENOENT: [404, '路径不存在'],
  EACCES: [400, '没有权限访问该路径'],
};

fsRouter.get('/roots', requireAdmin, async (req, res, next) => {
  try {
    const roots = await browseRoots();
    res.json({
      roots: roots.map((p) => ({ path: p, label: path.basename(p) || p })),
      home: os.homedir(),
    });
  } catch (err) { next(err); }
});

fsRouter.get('/list', requireAdmin, async (req, res, next) => {
  try {
    const target = await assertWithin(await browseRoots(), String(req.query.path ?? os.homedir()));
    let dirents;
    try {
      dirents = await fs.readdir(target, { withFileTypes: true });
    } catch (err) {
      const mapped = LIST_ERROR_STATUS[err.code];
      if (!mapped) throw err;
      const [status, message] = mapped;
      return res.status(status).json({ error: message });
    }
    const dirs = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, path: path.join(target, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    res.json({ path: target, parent: path.dirname(target), dirs });
  } catch (err) { next(err); }
});

fsRouter.post('/mkdir', requireAdmin, async (req, res, next) => {
  try {
    const parent = await assertWithin(await browseRoots(), String(req.body?.parent ?? ''));
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.includes('/') || name.includes('\\') || name === '..') {
      return res.status(400).json({ error: '目录名非法' });
    }
    const target = path.join(parent, name);
    await fs.mkdir(target, { recursive: true });
    res.json({ path: target });
  } catch (err) { next(err); }
});
