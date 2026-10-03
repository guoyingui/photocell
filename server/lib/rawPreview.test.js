import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { extractTiffPreview, previewSource } from './rawPreview.js';
import { getThumb } from './thumbs.js';
import { readAllMeta } from './meta.js';

let root;
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'raw-preview-'))); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const image = (width, height) => sharp({ create: { width, height, channels: 3, background: '#de4422' } }).jpeg().toBuffer();

// 带多个 TIFF IFD 的人工容器，明确不是某款相机实拍样张。
async function fixture({ bigEndian = false, orientation = 1, broken = false } = {}) {
  const previews = [await image(160, 100), await image(1200, 800)];
  const table = Buffer.alloc(8 + 2 * 42); table.write(bigEndian ? 'MM' : 'II');
  const short = (value, offset) => bigEndian ? table.writeUInt16BE(value, offset) : table.writeUInt16LE(value, offset);
  const long = (value, offset) => bigEndian ? table.writeUInt32BE(value, offset) : table.writeUInt32LE(value, offset);
  short(42, 2); long(8, 4);
  let start = table.length;
  for (let n = 0; n < 2; n++) {
    const offset = 8 + n * 42; short(3, offset);
    for (const [i, tag, value, type] of [[0, 274, orientation, 3], [1, 513, broken ? 0xffffffff : start, 4], [2, 514, previews[n].length, 4]]) {
      const at = offset + 2 + i * 12; short(tag, at); short(type, at + 2); long(1, at + 4);
      if (type === 3) short(value, at + 8); else long(value, at + 8);
    }
    long(n === 0 ? 50 : 0, offset + 38); start += previews[n].length;
  }
  return Buffer.concat([table, ...previews]);
}
const asset = { id: 'A', dir: '', stem: 'A', jpg: null, jpgSize: 0, jpgMtimeMs: 0, raws: ['A.NEF'], rawMtimeMs: 123 };

describe('TIFF RAW 内嵌 JPEG 预览', () => {
  it.each([false, true])('读取小端/大端 TIFF，选择最大 JPEG，生成方向正确的缩略图：bigEndian=%s', async (bigEndian) => {
    const source = await fixture({ bigEndian, orientation: 6 }); await fs.writeFile(path.join(root, 'A.NEF'), source);
    const original = await extractTiffPreview(path.join(root, 'A.NEF'));
    expect(original.width).toBe(1200); expect(original.height).toBe(800); expect(original.orientation).toBe(6);
    expect((await sharp(original.jpeg).metadata()).orientation).toBe(6);
    const thumb = await getThumb(root, asset, 'grid'); expect(thumb.placeholder).toBe(false);
    const meta = await sharp(thumb.file).metadata(); expect(meta.width).toBe(213); expect(meta.height).toBe(320);
    expect(await fs.readFile(path.join(root, 'A.NEF'))).toEqual(source);
  });
  it('同源请求合并，磁盘缓存复用，修改 RAW 后不返回旧预览，配对 JPG 优先', async () => {
    await fs.writeFile(path.join(root, 'A.NEF'), await fixture());
    const first = await Promise.all([previewSource(root, asset), previewSource(root, asset)]);
    expect(first[0].file).toBe(first[1].file);
    expect((await fs.readdir(path.join(root, '.photocull', 'raw-previews'))).length).toBe(1);
    await fs.writeFile(path.join(root, 'A.NEF'), await fixture({ orientation: 3 }));
    const stat = await fs.stat(path.join(root, 'A.NEF')); await fs.utimes(path.join(root, 'A.NEF'), stat.atime, new Date(stat.mtimeMs + 2000));
    expect((await previewSource(root, asset)).key).not.toBe(first[0].key);
    await fs.writeFile(path.join(root, 'A.JPG'), await image(100, 100));
    expect((await previewSource(root, { ...asset, jpg: 'A.JPG' })).kind).toBe('jpg');
  });
  it('损坏偏移、无预览及不支持的容器明确失败，不会全量读取 RAW 或污染其他目录', async () => {
    await fs.writeFile(path.join(root, 'A.NEF'), await fixture({ broken: true }));
    await expect(previewSource(root, asset)).rejects.toThrow('未找到');
    await fs.writeFile(path.join(root, 'A.NEF'), '0000ftypcrx not a TIFF');
    await expect(previewSource(root, asset)).rejects.toThrow('CR3');
    expect((await getThumb(root, asset, 'grid')).placeholder).toBe(true);
    await fs.symlink(os.tmpdir(), path.join(root, 'out'));
    await expect(previewSource(root, { ...asset, dir: 'out' })).rejects.toMatchObject({ status: 403 });
  });
  it('纯 RAW EXIF 的方向可读取，失败时使用扫描得到的 RAW 时间', async () => {
    await fs.writeFile(path.join(root, 'A.NEF'), await fixture({ orientation: 8 }));
    const [meta] = await readAllMeta(root, [asset]); expect(meta.orientation).toBe(8); expect(meta.time).toBe(123);
    await fs.writeFile(path.join(root, 'A.NEF'), 'broken');
    expect((await readAllMeta(root, [asset]))[0]).toMatchObject({ time: 123, timeSource: 'mtime' });
  });
});
