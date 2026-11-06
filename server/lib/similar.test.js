import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  clampThreshold, groupSimilar, hashFile, hashPixels, hammingDistance,
  loadHashCache, saveHashCache, SIMILAR_DEFAULT_THRESHOLD, SIMILAR_MAX_THRESHOLD,
} from './similar.js';

const W = 320;
const H = 240;
const patternA = (x, y) => [
  128 + 90 * Math.sin(x / 33) * Math.cos(y / 27),
  128 + 70 * Math.sin((x + y) / 41),
  128 + 60 * Math.cos((x - y) / 29),
];
const patternA2 = (x, y) => patternA(x + 4, y + 2).map((v) => Math.min(255, v + 8));
const patternB = (x, y) => [
  128 + 90 * Math.cos(x / 19) * Math.sin(y / 51),
  128 + 70 * Math.cos((x - y) / 17),
  128 + 60 * Math.sin((x + y) / 23),
];
function pixels(fn) {
  const data = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * W + x) * 3;
      data[i] = Math.round(r);
      data[i + 1] = Math.round(g);
      data[i + 2] = Math.round(b);
    }
  }
  return data;
}

let tmp;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'similar-lib-'));
  for (const [name, fn] of [['a', patternA], ['a2', patternA2], ['b', patternB]]) {
    await sharp(pixels(fn), { raw: { width: W, height: H, channels: 3 } })
      .jpeg({ quality: 90 }).toFile(path.join(tmp, `${name}.JPG`));
  }
  await sharp({ create: { width: W, height: H, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .jpeg().toFile(path.join(tmp, 'flat.JPG'));
});
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe('hashPixels / hashFile', () => {
  it('把 9×8 的相邻明暗关系编成 16 位十六进制', () => {
    const data = new Uint8Array(72);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 9; x++) data[y * 9 + x] = x % 2 === 0 ? 0 : 255;
    }
    expect(hashPixels(data)).toBe('5555555555555555');
  });

  it('画面过于平坦时返回 null，避免把所有纯色图并成一组', () => {
    expect(hashPixels(new Uint8Array(72).fill(128))).toBeNull();
    expect(hashPixels(new Uint8Array(10))).toBeNull();
  });

  it('相似的画面的哈希距离小，不同画面距离大', async () => {
    const a = await hashFile(path.join(tmp, 'a.JPG'));
    const a2 = await hashFile(path.join(tmp, 'a2.JPG'));
    const b = await hashFile(path.join(tmp, 'b.JPG'));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(hammingDistance(a, a2)).toBeLessThanOrEqual(8);
    expect(hammingDistance(a, b)).toBeGreaterThan(20);
  });

  it('平坦照片和坏文件返回 null，不抛错', async () => {
    expect(await hashFile(path.join(tmp, 'flat.JPG'))).toBeNull();
    expect(await hashFile(path.join(tmp, 'missing.JPG'))).toBeNull();
  });
});

describe('hammingDistance / clampThreshold', () => {
  it('同一个哈希距离为 0，全 0 与全 1 距离为 64', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('0000000000000000', '000000000000000f')).toBe(4);
  });

  it('非法哈希直接抛错，不静默当成相同', () => {
    expect(() => hammingDistance('xyz', '0000000000000000')).toThrow(TypeError);
    expect(() => hammingDistance(undefined, '0000000000000000')).toThrow(TypeError);
  });

  it('阈值钳制在 0–24，非法值回到默认 8', () => {
    expect(clampThreshold(-5)).toBe(0);
    expect(clampThreshold(999)).toBe(SIMILAR_MAX_THRESHOLD);
    expect(clampThreshold('12')).toBe(12);
    expect(clampThreshold('abc')).toBe(SIMILAR_DEFAULT_THRESHOLD);
    expect(clampThreshold(undefined)).toBe(SIMILAR_DEFAULT_THRESHOLD);
  });
});

describe('groupSimilar', () => {
  const h = (n) => n.toString(16).padStart(16, '0');
  it('按锚点距离分组，忽略未达到两张的组', () => {
    const groups = groupSimilar([
      { id: 'a', hash: h(0) },
      { id: 'b', hash: h(1) },
      { id: 'c', hash: h(7) },
      { id: 'd', hash: h(0xffff) },
    ], 2);
    expect(groups).toHaveLength(1);
    expect(groups[0].assetIds).toEqual(['a', 'b']);
    expect(groups[0].key).toBe('a');
    expect(groups[0].distances).toEqual({ a: 0, b: 1 });
  });

  it('阈值 0 只合并完全相同的哈希', () => {
    expect(groupSimilar([{ id: 'a', hash: h(0) }, { id: 'b', hash: h(0) }], 0)).toHaveLength(1);
    expect(groupSimilar([{ id: 'a', hash: h(0) }, { id: 'b', hash: h(1) }], 0)).toHaveLength(0);
  });

  it('不会像单链并查集那样把首尾不像的照片串成一组', () => {
    // a 与 b 差 8、b 与 c 差 8，但 a 与 c 差 16：阈值 8 时 c 不能跟进 a 组。
    const a = '0000000000000000';
    const b = '00000000000000ff';
    const c = '000000000000ffff';
    expect(hammingDistance(a, b)).toBe(8);
    expect(hammingDistance(b, c)).toBe(8);
    expect(hammingDistance(a, c)).toBe(16);
    const groups = groupSimilar([{ id: 'a', hash: a }, { id: 'b', hash: b }, { id: 'c', hash: c }], 8);
    expect(groups.map((group) => group.assetIds)).toEqual([['a', 'b']]);
  });

  it('大组排在前面，同规模按首个 id 稳定排序', () => {
    const hashes = [
      { id: 'x1', hash: h(0) }, { id: 'x2', hash: h(1) },
      { id: 'y1', hash: h(0xff00) }, { id: 'y2', hash: h(0xff01) }, { id: 'y3', hash: h(0xff02) },
    ];
    expect(groupSimilar(hashes, 2).map((group) => group.assetIds))
      .toEqual([['y1', 'y2', 'y3'], ['x1', 'x2']]);
  });

  it('过滤掉没有合法哈希的条目', () => {
    expect(groupSimilar([
      { id: 'a', hash: h(0) }, { id: 'b', hash: null }, { id: 'c', hash: 'nope' },
    ], 8)).toEqual([]);
    expect(groupSimilar(null, 8)).toEqual([]);
  });
});

describe('哈希磁盘缓存', () => {
  it('写入后重新开一个会话仍能读回，损坏文件按空缓存处理', async () => {
    const root = await fs.mkdtemp(path.join(tmp, 'cache-'));
    await fs.mkdir(path.join(root, '.photocull'));
    const first = { root, similar: { loaded: true, loading: null, dirty: false, hashes: new Map() } };
    first.similar.hashes.set('0123456789abcdef', 'abcdef0123456789');
    first.similar.dirty = true;
    await saveHashCache(first);
    const second = { root };
    const loaded = await loadHashCache(second);
    expect(loaded.hashes.get('0123456789abcdef')).toBe('abcdef0123456789');

    await fs.writeFile(path.join(root, '.photocull', 'similar.json'), '{broken');
    const third = await loadHashCache({ root });
    expect(third.hashes.size).toBe(0);
  });
});
