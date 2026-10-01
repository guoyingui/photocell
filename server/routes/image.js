import express from 'express';
import path from 'node:path';
import { requireSession } from './library.js';
import { requirePerm } from '../middleware/auth.js';
import { getThumb, PLACEHOLDER_SVG } from '../lib/thumbs.js';

export const imageRouter = express.Router();

const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * res.sendFile 默认 dotfiles:'ignore' —— 路径里只要有一段以 "." 开头就直接 404，
 * 不管文件是否存在。缩略图缓存固定放在 <root>/.photocull/thumbs/ 下，
 * 而 .photocull 就是个点号目录，不加这个选项缩略图永远读不出来。
 * 这里放开是安全的：两个路由的路径都只从内存资产表按 id 查出来，从不接受客户端路径，
 * 放开 dotfiles 不会打开穿越攻击的口子，只是不再无差别拒绝合法的点号路径。
 */
const ALLOW_DOTFILES = { dotfiles: 'allow' };

/**
 * 这里只接受资产 id，绝不接受客户端路径。
 * 真实路径永远从内存资产表查出来 —— 穿越攻击在这一步就退化成 404。
 *
 * requireSession 不是可选的：这两个路由以前只问"有没有会话"，于是第二个标签页
 * 打开另一个文件夹之后，第一个标签页请求 IMG_0002 的缩略图会拿到另一个文件夹里
 * 同名的那张照片——界面上完全看不出来。`<img src>` 设不了请求头，会话 id 走 ?sid=。
 */
imageRouter.get('/thumb', requirePerm('read'), requireSession, async (req, res, next) => {
  try {
    const session = req.session;
    const asset = session.byId.get(String(req.query.id ?? ''));
    if (!asset) return res.status(404).json({ error: '未知资产' });

    const { file, key, placeholder } = await getThumb(session.root, asset, String(req.query.tier ?? 'grid'));

    if (placeholder) {
      res.set('Cache-Control', 'public, max-age=60');
      return res.type('image/svg+xml').send(PLACEHOLDER_SVG);
    }
    if (req.headers['if-none-match'] === `"${key}"`) {
      res.set({ ETag: `"${key}"`, 'Cache-Control': IMMUTABLE });
      return res.status(304).end();
    }
    res.set({ ETag: `"${key}"`, 'Cache-Control': IMMUTABLE, 'Content-Type': 'image/webp' });
    res.sendFile(file, ALLOW_DOTFILES);
  } catch (err) { next(err); }
});

imageRouter.get('/original', requirePerm('read'), requireSession, (req, res, next) => {
  try {
    const session = req.session;
    const asset = session.byId.get(String(req.query.id ?? ''));
    if (!asset || !asset.jpg) return res.status(404).json({ error: '该资产没有 JPG' });

    const abs = path.join(session.root, ...asset.dir.split('/').filter(Boolean), asset.jpg);
    res.set({
      'Content-Type': 'image/jpeg',
      ETag: `"${asset.jpgMtimeMs}-${asset.jpgSize}"`,
      'Cache-Control': 'private, max-age=3600',
    });
    res.sendFile(abs, ALLOW_DOTFILES);   // sendFile 自带 Range 支持；root 路径本身若含点号目录也不会被误 404
  } catch (err) { next(err); }
});
