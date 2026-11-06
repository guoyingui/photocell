import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../index.js';
import { closeAllSessions, closeSession, openSession } from '../lib/session.js';

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
const patternC = (x, y) => [
  128 + 90 * Math.sin((x + y) / 13),
  128 + 90 * Math.cos((x - y) / 11),
  128 + 90 * Math.sin(x / 47),
];
const patternD = (x, y) => [
  128 + 90 * Math.cos((x + 2 * y) / 9),
  128 + 90 * Math.sin((2 * x - y) / 15),
  128 + 90 * Math.cos(y / 7),
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
async function jpeg(file, fn) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await sharp(pixels(fn), { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: 90 }).toFile(file);
}

let tmp, root, savedHome, session, server, base;
const request = (query, method = 'GET') => fetch(base + `/api/library/similar${query}`, {
  method,
  headers: { 'X-PhotoCull-Session': session.id },
});
const json = async (query) => {
  const response = await request(query);
  const data = await response.json();
  expect(response.status, JSON.stringify(data)).toBe(200);
  return data;
};

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-similar-')));
  root = path.join(tmp, 'photos');
  await fs.mkdir(root);
  savedHome = process.env.PHOTOCULL_HOME;
  process.env.PHOTOCULL_HOME = path.join(tmp, 'home');
  await jpeg(path.join(root, 'a.JPG'), patternA);
  await jpeg(path.join(root, 'a2.JPG'), patternA2);
  await jpeg(path.join(root, 'b.JPG'), patternB);
  await jpeg(path.join(root, 'sub', 'c.JPG'), patternC);
  await jpeg(path.join(root, 'sub', 'd.JPG'), patternD);
  await fs.writeFile(path.join(root, 'orphan.CR3'), 'fake raw');
  session = await openSession(root);
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  // 每个用例后把隐藏状态清掉，避免互相影响。
  if (session) session.markStore.data.hidden = [];
});

afterAll(async () => {
  await closeAllSessions();
  await new Promise((resolve) => server.close(resolve));
  if (savedHome === undefined) delete process.env.PHOTOCULL_HOME;
  else process.env.PHOTOCULL_HOME = savedHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('相似照片分组', () => {
  it('默认阈值把近似的两张归为一组，不把不同画面混进来', async () => {
    const data = await json('');
    expect(data.threshold).toBe(8);
    expect(data.analyzed).toBe(5);
    expect(data.groups).toHaveLength(1);
    expect(data.groups[0].assetIds.sort()).toEqual(['a', 'a2']);
    expect(data.groups[0].maxDistance).toBeLessThanOrEqual(8);
    expect(data.skipped).toBe(1);
  });

  it('严格阈值不会把有细微差异的照片强行并组', async () => {
    const data = await json('?threshold=0');
    expect(data.threshold).toBe(0);
    expect(data.groups).toEqual([]);
  });

  it('阈值越界被钳制到 0–24', async () => {
    expect((await json('?threshold=-3')).threshold).toBe(0);
    expect((await json('?threshold=999')).threshold).toBe(24);
    expect((await json('?threshold=abc')).threshold).toBe(8);
  });

  it('按目录精确筛选，同一批照片在不同目录各自成组', async () => {
    const rootData = await json('?dir=');
    expect(rootData.total).toBe(6);
    const sub = await json('?dir=sub');
    expect(sub.total).toBe(2);
    expect(sub.analyzed).toBe(2);
    // 子目录里的两张是不同画面；目录筛选不能把根目录的同名照片串进来。
    expect(sub.groups).toEqual([]);
    const rootOnly = await json(`?dir=${encodeURIComponent('')}`);
    expect(rootOnly.total).toBe(6);
  });

  it('隐藏的照片不参与分组，也不会让残留的旧组出现', async () => {
    session.markStore.data.hidden = ['a2'];
    const data = await json('');
    expect(data.total).toBe(5);
    expect(data.analyzed).toBe(4);
    expect(data.groups).toEqual([]);
  });

  it('没有预览的纯 RAW 单独计数，不阻断其它照片', async () => {
    await closeSession(session.id);
    session = await openSession(root);
    const data = await json('');
    expect(data.noPreview).toBe(1);
    expect(data.skipped).toBe(1);
    expect(data.analyzed).toBe(5);
    expect(data.groups).toHaveLength(1);
  });

  it('把哈希写入 .photocull/similar.json，供后续扫描复用', async () => {
    const cacheFile = path.join(root, '.photocull', 'similar.json');
    await json('');
    const cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    expect(cache.version).toBe(1);
    expect(Object.keys(cache.hashes).length).toBeGreaterThan(0);
    expect(Object.values(cache.hashes).every((hash) => /^[0-9a-f]{16}$/.test(hash))).toBe(true);
  });

  it('通过 SSE 回报进度，并只回显本次扫描的随机串', async () => {
    const events = [];
    session.listeners.add({ send: (event) => { if (event.type === 'similar-progress') events.push(event); }, end: () => {} });
    const data = await json('?scan=abc-123');
    expect(data.analyzed).toBe(5);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.scan === 'abc-123')).toBe(true);
    expect(events.at(-1).running).toBe(false);
    expect(events.at(-1).done).toBe(6);
  });

  it('客户端传入的扫描串必须是安全短串，不能写进进度帧', async () => {
    const events = [];
    session.listeners.add({ send: (event) => { if (event.type === 'similar-progress') events.push(event); }, end: () => {} });
    await json(`?scan=${encodeURIComponent('<script>alert(1)</script>')}`);
    expect(events).toEqual([]);
  });
});
