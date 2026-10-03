import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cacheStats, clearGeneratedCache } from './cache.js';
import { ensureCacheDir, withCacheWork } from './cacheLifecycle.js';
let root;
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-cache-'))); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
describe('预览缓存清理', () => {
  it('只删除生成文件，保留照片、标记、客户提交、备注、后期信息和导出历史', async () => {
    await ensureCacheDir(root, 'thumbs'); await ensureCacheDir(root, 'raw-previews');
    const keep = ['A.CR3', '.photocull/marks.json', '.photocull/marks.bak.json', '.photocull/review.json',
      '.photocull/selections.json', '.photocull/annotations.json', '.photocull/thumbs/custom.txt'];
    for (const name of keep) await fs.writeFile(path.join(root, name), 'keep');
    await fs.mkdir(path.join(root, '.photocull', 'exports')); await fs.writeFile(path.join(root, '.photocull', 'exports', 'job.json'), 'keep');
    await fs.writeFile(path.join(root, '.photocull', 'thumbs', '0123456789abcdef.webp'), '123');
    await fs.writeFile(path.join(root, '.photocull', 'raw-previews', '0123456789abcdef.jpg'), '12345');
    expect(await cacheStats(root)).toEqual({ files: 2, bytes: 8 }); expect(await clearGeneratedCache(root)).toEqual({ files: 2, bytes: 8 });
    expect(await cacheStats(root)).toEqual({ files: 0, bytes: 0 });
    for (const name of [...keep, '.photocull/exports/job.json']) expect(await fs.readFile(path.join(root, name), 'utf8')).toBe('keep');
  });
  it('等当前生成任务结束才删除，后来的生成请求在清理后执行', async () => {
    await ensureCacheDir(root, 'thumbs');
    let release, started;
    const gate = new Promise((resolve) => { release = resolve; }), active = new Promise((resolve) => { started = resolve; });
    const old = withCacheWork(root, async () => { started(); await gate; await fs.writeFile(path.join(root, '.photocull', 'thumbs', '0123456789abcdef.webp'), 'old'); });
    await active;
    const cleaning = clearGeneratedCache(root);
    // withFileLock 是 Promise 队列，在下一次微任务正式建立清理屏障。
    await Promise.resolve(); let ran = false;
    const next = withCacheWork(root, async () => { ran = true; expect(await cacheStats(root)).toEqual({ files: 0, bytes: 0 }); });
    expect(ran).toBe(false); release(); await old;
    expect((await cleaning).files).toBe(1); await next; expect(ran).toBe(true);
  });
  it('缓存目录指向库外时拒绝；文件软链接不跟随，消失的库不被重新创建', async () => {
    await fs.mkdir(path.join(root, '.photocull'));
    await fs.symlink(os.tmpdir(), path.join(root, '.photocull', 'thumbs'));
    await expect(clearGeneratedCache(root)).rejects.toMatchObject({ status: 403 });
    await fs.unlink(path.join(root, '.photocull', 'thumbs')); await ensureCacheDir(root, 'thumbs');
    await fs.symlink('/definitely-missing-cache-file', path.join(root, '.photocull', 'thumbs', '0123456789abcdef.webp'));
    expect(await clearGeneratedCache(root)).toEqual({ files: 0, bytes: 0 });
    await fs.rm(root, { recursive: true }); await expect(ensureCacheDir(root, 'thumbs')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(root)).rejects.toThrow();
  });
});
