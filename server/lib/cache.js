import fs from 'node:fs/promises';
import path from 'node:path';
import { assertWithin } from './safepath.js';
import { withCacheMaintenance } from './cacheLifecycle.js';

const CACHES = [['thumbs', /^[0-9a-f]{16}\.webp(?:\.\d+\.\d+\.tmp)?$/],
  ['raw-previews', /^[0-9a-f]{16}\.jpg(?:\.[0-9a-f-]{36}\.tmp)?$/]];
async function filesIn(root) {
  const files = [];
  for (const [folder, pattern] of CACHES) {
    const dir = await assertWithin([root], path.join(root, '.photocull', folder));
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
    for (const entry of entries) {
      if (!entry.isFile() || !pattern.test(entry.name)) continue;
      const file = await assertWithin([root], path.join(dir, entry.name));
      try { const stat = await fs.lstat(file); if (stat.isFile()) files.push({ file, bytes: stat.size }); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
  }
  return files;
}
export async function cacheStats(root) {
  const files = await filesIn(root);
  return { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}
export function clearGeneratedCache(root) {
  return withCacheMaintenance(root, async () => {
    const files = await filesIn(root);
    for (const { file } of files) await fs.unlink(file).catch((err) => { if (err.code !== 'ENOENT') throw err; });
    return { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
  });
}
