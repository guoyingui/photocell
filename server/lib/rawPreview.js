import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import pLimit from 'p-limit';
import { assertWithin } from './safepath.js';
import { ensureCacheDir, withCacheWork } from './cacheLifecycle.js';

const MAX_JPEG = 64 * 1024 * 1024;
const pending = new Map();
const extractLimit = pLimit(2);
const unsupported = (message) => Object.assign(new Error(message), { code: 'raw-preview-unavailable', status: 422 });

/** 只沿 TIFF 目录读取有界的数据块，不加载或解码整个 RAW。 */
export async function extractTiffPreview(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const read = async (offset, length) => {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) {
        throw unsupported('RAW 预览偏移或长度不合法');
      }
      const data = Buffer.alloc(length);
      const { bytesRead } = await handle.read(data, 0, length, offset);
      if (bytesRead !== length) throw unsupported('RAW 文件已变化，请刷新文件夹');
      return data;
    };
    if (size < 8) throw unsupported('RAW 没有可读取的内嵌 JPEG');
    const header = await read(0, 8), order = header.toString('ascii', 0, 2);
    if (!['II', 'MM'].includes(order)) throw unsupported('当前仅支持 TIFF 容器内嵌 JPEG；CR3 等其他容器暂不支持');
    const short = (data, offset) => order === 'II' ? data.readUInt16LE(offset) : data.readUInt16BE(offset);
    const long = (data, offset) => order === 'II' ? data.readUInt32LE(offset) : data.readUInt32BE(offset);
    if (short(header, 2) !== 42) throw unsupported('当前不支持此 RAW 容器');
    const queue = [long(header, 4)], visited = new Set(), candidates = [];
    let orientation = 1;
    while (queue.length && visited.size < 128) {
      const offset = queue.shift();
      if (!offset || visited.has(offset)) continue;
      visited.add(offset);
      let entries;
      try {
        const count = short(await read(offset, 2), 0);
        if (count > 4096) continue;
        entries = await read(offset + 2, count * 12 + 4);
        const tags = new Map();
        for (let i = 0; i < count; i++) {
          const at = i * 12, tag = short(entries, at), type = short(entries, at + 2), length = long(entries, at + 4);
          if (![3, 4].includes(type) || length > 256 || !length || ![274, 330, 513, 514, 259, 273, 279].includes(tag)) continue;
          const bytes = type === 3 ? 2 : 4;
          try {
            const values = bytes * length <= 4 ? entries.subarray(at + 8, at + 12) : await read(long(entries, at + 8), bytes * length);
            tags.set(tag, Array.from({ length }, (_, n) => type === 3 ? short(values, n * bytes) : long(values, n * bytes)));
          } catch { /* 忽略损坏的单个标签 */ }
        }
        if (visited.size === 1 && tags.get(274)?.[0] >= 1 && tags.get(274)[0] <= 8) orientation = tags.get(274)[0];
        queue.push(...(tags.get(330) ?? []), long(entries, count * 12));
        if (tags.has(513) && tags.has(514)) candidates.push([tags.get(513)[0], tags.get(514)[0]]);
        if ([6, 7].includes(tags.get(259)?.[0]) && tags.get(273)?.length === 1 && tags.get(279)?.length === 1) {
          candidates.push([tags.get(273)[0], tags.get(279)[0]]);
        }
      } catch { /* 某个目录损坏时仍检查其他目录 */ }
    }
    let best = null;
    const checked = new Set();
    for (const [offset, length] of candidates.slice(0, 32)) {
      const key = `${offset}:${length}`;
      if (checked.has(key) || length < 4 || length > MAX_JPEG || offset + length > size) continue;
      checked.add(key);
      try {
        const magic = await read(offset, 2);
        if (magic[0] !== 0xff || magic[1] !== 0xd8) continue;
        const jpeg = await read(offset, length), meta = await sharp(jpeg).metadata();
        if (meta.format !== 'jpeg' || !meta.width || !meta.height) continue;
        if (!best || meta.width * meta.height > best.width * best.height) {
          best = { jpeg, width: meta.width, height: meta.height, orientation: meta.orientation ?? orientation };
        }
      } catch { /* 无效或非 JPEG 的压缩 RAW 数据不会作为预览返回 */ }
    }
    if (!best) throw unsupported('该 RAW 未找到可用的内嵌 JPEG，请提供配对 JPG 或使用其他软件生成预览');
    // 原样保留 JPEG 像素，仅补齐缺失的方向标签，避免竖图被横着显示。
    if (best.orientation !== 1 && !(await sharp(best.jpeg).metadata()).orientation) {
      const tiff = Buffer.alloc(26); tiff.write('II'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
      tiff.writeUInt16LE(1, 8); tiff.writeUInt16LE(274, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(best.orientation, 18);
      const exif = Buffer.concat([Buffer.from('Exif\0\0'), tiff]), marker = Buffer.alloc(4);
      marker.writeUInt16BE(0xffe1); marker.writeUInt16BE(exif.length + 2, 2);
      best.jpeg = Buffer.concat([best.jpeg.subarray(0, 2), marker, exif, best.jpeg.subarray(2)]);
    }
    return best;
  } finally { await handle.close(); }
}

export async function rawPreview(root, asset) {
  let lastError = unsupported('该照片没有可用的 RAW 预览');
  for (const raw of asset.raws ?? []) {
    try {
      const source = await assertWithin([root], path.join(root, ...asset.dir.split('/').filter(Boolean), raw));
      const stat = await fs.stat(source);
      const key = crypto.createHash('sha1').update(JSON.stringify([asset.dir, raw, stat.size, stat.mtimeMs, 1])).digest('hex').slice(0, 16);
      const dir = await assertWithin([root], path.join(root, '.photocull', 'raw-previews'));
      const file = await assertWithin([root], path.join(dir, key + '.jpg'));
      try { await fs.access(file); return { file, key, kind: 'raw' }; } catch { /* 生成 */ }
      const flight = `${root}\0${key}`;
      if (!pending.has(flight)) {
        const job = extractLimit(() => withCacheWork(root, async () => {
          const result = await extractTiffPreview(source);
          const after = await fs.stat(source);
          if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw unsupported('RAW 文件已变化，请刷新文件夹');
          await ensureCacheDir(root, 'raw-previews');
          const temp = await assertWithin([root], file + '.' + crypto.randomUUID() + '.tmp');
          try { await fs.writeFile(temp, result.jpeg, { mode: 0o600 }); await fs.rename(temp, file); }
          finally { await fs.rm(temp, { force: true }); }
          return { file, key, kind: 'raw' };
        })).finally(() => pending.delete(flight));
        pending.set(flight, job);
      }
      return await pending.get(flight);
    } catch (err) {
      if (err.status === 403) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

export async function previewSource(root, asset) {
  if (asset.jpg) {
    const file = await assertWithin([root], path.join(root, ...asset.dir.split('/').filter(Boolean), asset.jpg));
    return { file, key: `${asset.jpgMtimeMs}-${asset.jpgSize}`, kind: 'jpg' };
  }
  return rawPreview(root, asset);
}
