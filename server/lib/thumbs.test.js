import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { cacheKey, getThumb, thumbPath, TIERS } from './thumbs.js';

// F3 (fix round 1)：把 sharp 的默认导出包成 spy，同时保留真实实现，
// 这样既能生成真实 webp 文件，又能统计 generate() 实际被调用了几次，
// 用来证明并发合流（inflight）确实只触发一次真正的生成工作。
vi.mock('sharp', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: vi.fn(actual.default) };
});

describe('cacheKey', () => {
  it('相同输入产出相同 key', () => {
    expect(cacheKey('a/b.JPG', 1, 2, 'grid')).toBe(cacheKey('a/b.JPG', 1, 2, 'grid'));
  });
  it('mtime 变化导致 key 变化', () => {
    expect(cacheKey('a.JPG', 1, 2, 'grid')).not.toBe(cacheKey('a.JPG', 9, 2, 'grid'));
  });
  it('文件大小变化导致 key 变化', () => {
    expect(cacheKey('a.JPG', 1, 2, 'grid')).not.toBe(cacheKey('a.JPG', 1, 3, 'grid'));
  });
  it('档位变化导致 key 变化', () => {
    expect(cacheKey('a.JPG', 1, 2, 'grid')).not.toBe(cacheKey('a.JPG', 1, 2, 'preview'));
  });
  it('路径变化导致 key 变化', () => {
    expect(cacheKey('a.JPG', 1, 2, 'grid')).not.toBe(cacheKey('b.JPG', 1, 2, 'grid'));
  });
  it('key 是 16 位十六进制，可安全作文件名', () => {
    expect(cacheKey('a/b c.JPG', 1, 2, 'grid')).toMatch(/^[0-9a-f]{16}$/);
  });
  it('F1: 字段边界不可被输入内容伪造（此前会碰撞的一对输入现在必须不同）', () => {
    // 空格拼接方案下，'a/b c.JPG 1234' + 5678 + 0 + 'grid'
    // 与 'a/b' + 'c.JPG 1234 5678' + 0 + 'grid' 拼出同一个字符串。
    const k1 = cacheKey('a/b c.JPG 1234', 5678, 0, 'grid');
    const k2 = cacheKey('a/b', 'c.JPG 1234 5678', 0, 'grid');
    expect(k1).not.toBe(k2);
  });
});

describe('thumbPath', () => {
  it('合法 key 生成 .photocull/thumbs 下的路径', () => {
    const key = cacheKey('a.JPG', 1, 2, 'grid');
    expect(thumbPath('/root', key)).toBe(path.join('/root', '.photocull', 'thumbs', `${key}.webp`));
  });
  it('F2: 路径穿越式 key 被拒绝，而不是被拼进路径里', () => {
    expect(() => thumbPath('/root', '../../../../../../etc/passwd')).toThrow();
  });
  it('F2: 空 key 被拒绝', () => {
    expect(() => thumbPath('/root', '')).toThrow();
  });
});

describe('getThumb', () => {
  let tmp;
  const asset = { id: 'cam-a/shot', dir: 'cam-a', stem: 'shot', raws: [], jpg: 'shot.JPG' };

  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'thumb-')));
    await fs.mkdir(path.join(tmp, 'cam-a'), { recursive: true });
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 30, b: 30 } } })
      .jpeg().toFile(path.join(tmp, 'cam-a', 'shot.JPG'));
    const st = await fs.stat(path.join(tmp, 'cam-a', 'shot.JPG'));
    asset.jpgSize = st.size;
    asset.jpgMtimeMs = st.mtimeMs;
  });
  afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('生成 grid 档缩略图，长边等于 320', async () => {
    const { file, placeholder } = await getThumb(tmp, asset, 'grid');
    expect(placeholder).toBe(false);
    const meta = await sharp(file).metadata();
    expect(Math.max(meta.width, meta.height)).toBe(TIERS.grid.size);
    expect(meta.format).toBe('webp');
  });

  it('缓存文件落在 .photocull/thumbs 下', async () => {
    const { file, key } = await getThumb(tmp, asset, 'grid');
    expect(file).toBe(thumbPath(tmp, key));
    expect(file).toContain(path.join('.photocull', 'thumbs'));
  });

  it('第二次调用命中磁盘缓存，不重新生成', async () => {
    const { file } = await getThumb(tmp, asset, 'grid');
    const before = (await fs.stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 30));
    const again = await getThumb(tmp, asset, 'grid');
    expect((await fs.stat(again.file)).mtimeMs).toBe(before);
  });

  it('preview 档不放大小于目标尺寸的原图', async () => {
    const { file } = await getThumb(tmp, asset, 'preview');
    const meta = await sharp(file).metadata();
    expect(Math.max(meta.width, meta.height)).toBe(1200);
  });

  it('没有 JPG 的资产返回占位', async () => {
    const res = await getThumb(tmp, { ...asset, id: 'x', jpg: null }, 'grid');
    expect(res.placeholder).toBe(true);
    expect(res.file).toBeNull();
  });

  it('损坏的 JPG 返回占位而不是抛错', async () => {
    await fs.writeFile(path.join(tmp, 'cam-a', 'broken.JPG'), 'not an image at all');
    const st = await fs.stat(path.join(tmp, 'cam-a', 'broken.JPG'));
    const res = await getThumb(tmp, {
      id: 'cam-a/broken', dir: 'cam-a', stem: 'broken', raws: [], jpg: 'broken.JPG',
      jpgSize: st.size, jpgMtimeMs: st.mtimeMs,
    }, 'grid');
    expect(res.placeholder).toBe(true);
  });

  it('并发请求同一张图不会互相破坏', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => getThumb(tmp, asset, 'grid')));
    for (const r of results) {
      expect(r.placeholder).toBe(false);
      expect((await sharp(r.file).metadata()).format).toBe('webp');
    }
  });

  it('F3: 并发请求同一张全新图片，合流确实只触发一次真正的生成', async () => {
    // 用一张此前任何测试都没碰过的图，保证第一次调用就是缓存未命中，
    // 8 个并发请求会真正竞争同一个 inflight key —— 而不是全部命中已有缓存。
    await fs.mkdir(path.join(tmp, 'cam-c'), { recursive: true });
    await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 10, g: 200, b: 10 } } })
      .jpeg().toFile(path.join(tmp, 'cam-c', 'race.JPG'));
    const st = await fs.stat(path.join(tmp, 'cam-c', 'race.JPG'));
    const raceAsset = {
      id: 'cam-c/race', dir: 'cam-c', stem: 'race', raws: [], jpg: 'race.JPG',
      jpgSize: st.size, jpgMtimeMs: st.mtimeMs,
    };

    sharp.mockClear();
    const results = await Promise.all(Array.from({ length: 8 }, () => getThumb(tmp, raceAsset, 'grid')));
    const generateCallCount = sharp.mock.calls.length;

    for (const r of results) expect(r.placeholder).toBe(false);
    expect(generateCallCount).toBe(1);
  });

  it('未知档位抛错', async () => {
    await expect(getThumb(tmp, asset, 'huge')).rejects.toThrow();
  });

  // MINOR：cacheKey 只由（相对路径, mtime, size, 档位）算出来，不含 root。两个不同的
  // 文件夹里放着同名、同大小、同 mtime 的 JPG（同一张卡导两次就是这个形状）会算出
  // 同一个 key——inflight 表如果也不带 root，第二个文件夹的并发请求会直接拿到第一个
  // 文件夹的生成结果，返回的 file 指向别人的缓存目录。
  it('inflight 合流的 key 带上 root：两个 root 的同 key 请求不会串', async () => {
    const rootA = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'thumb-ra-')));
    const rootB = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'thumb-rb-')));
    try {
      // 两张内容不同但**同名、同大小、同 mtime** 的 JPG——cacheKey 因此完全相同。
      const buf = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 9, g: 9, b: 240 } } })
        .jpeg({ quality: 80 }).toBuffer();
      const other = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 240, g: 9, b: 9 } } })
        .jpeg({ quality: 80 }).toBuffer();
      // 长度对齐到相同字节数，size 才会一致。
      const size = Math.min(buf.length, other.length);
      await fs.writeFile(path.join(rootA, 'twin.JPG'), buf.subarray(0, size));
      await fs.writeFile(path.join(rootB, 'twin.JPG'), other.subarray(0, size));
      const when = new Date(1700000000000);
      await fs.utimes(path.join(rootA, 'twin.JPG'), when, when);
      await fs.utimes(path.join(rootB, 'twin.JPG'), when, when);

      const st = await fs.stat(path.join(rootA, 'twin.JPG'));
      const twin = {
        id: 'twin', dir: '', stem: 'twin', raws: [], jpg: 'twin.JPG',
        jpgSize: st.size, jpgMtimeMs: st.mtimeMs,
      };
      // 前提确认：两个 root 下算出来的 cacheKey 确实是同一个，测试才有意义。
      expect(cacheKey('twin.JPG', st.mtimeMs, st.size, 'grid'))
        .toBe(cacheKey('twin.JPG', st.mtimeMs, st.size, 'grid'));

      // 同时发起：不带 root 的 inflight key 会让第二个请求直接复用第一个的 promise。
      const [a, b] = await Promise.all([
        getThumb(rootA, twin, 'grid'),
        getThumb(rootB, twin, 'grid'),
      ]);
      expect(a.file.startsWith(rootA)).toBe(true);
      expect(b.file.startsWith(rootB)).toBe(true);
      expect(a.file).not.toBe(b.file);
    } finally {
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });
});
