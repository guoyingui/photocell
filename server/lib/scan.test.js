import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pairEntries, walk, scanFolder, RAW_EXTS, JPG_EXTS } from './scan.js';

const e = (p, size = 100, mtimeMs = 1000) => ({ path: p, size, mtimeMs });

describe('pairEntries', () => {
  it('同目录同 stem 的 RAW 与 JPG 配成一个资产', () => {
    const { assets } = pairEntries([e('IMG_1234.CR3'), e('IMG_1234.JPG')]);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      id: 'IMG_1234', dir: '', stem: 'IMG_1234',
      raws: ['IMG_1234.CR3'], jpg: 'IMG_1234.JPG',
    });
  });

  it('扩展名大小写不敏感', () => {
    const { assets } = pairEntries([e('a.cr3'), e('a.jpeg')]);
    expect(assets[0].raws).toEqual(['a.cr3']);
    expect(assets[0].jpg).toBe('a.jpeg');
  });

  it('stem 大小写不同也能配对，ID 取首次出现的写法', () => {
    const { assets } = pairEntries([e('IMG_1.CR3'), e('img_1.JPG')]);
    expect(assets).toHaveLength(1);
    expect(assets[0].id).toBe('IMG_1');
  });

  it('不同子目录的同名文件不撞车', () => {
    const { assets } = pairEntries([
      e('cam-a/IMG_1234.CR3'), e('cam-a/IMG_1234.JPG'),
      e('cam-b/IMG_1234.CR3'), e('cam-b/IMG_1234.JPG'),
    ]);
    expect(assets).toHaveLength(2);
    expect(assets.map((a) => a.id).sort()).toEqual(['cam-a/IMG_1234', 'cam-b/IMG_1234']);
  });

  it('目录名大小写不同不撞车（回归测试）', () => {
    const { assets } = pairEntries([e('A/b.CR3'), e('a/B.JPG')]);
    expect(assets).toHaveLength(2);
    const sorted = assets.map((a) => ({ id: a.id, dir: a.dir })).sort((x, y) => x.id < y.id ? -1 : 1);
    expect(sorted).toEqual([
      { id: 'A/b', dir: 'A' },
      { id: 'a/B', dir: 'a' },
    ]);
  });

  it('多点文件名只剥最后一个扩展名', () => {
    const { assets } = pairEntries([e('2026.07.26_shot.CR3'), e('2026.07.26_shot.JPG')]);
    expect(assets).toHaveLength(1);
    expect(assets[0].stem).toBe('2026.07.26_shot');
  });

  it('一个资产可以带多个 RAW，按字典序排列', () => {
    const { assets } = pairEntries([e('x.DNG'), e('x.CR3'), e('x.JPG')]);
    expect(assets[0].raws).toEqual(['x.CR3', 'x.DNG']);
  });

  it('只有 RAW 的孤儿也产出资产，jpg 为 null', () => {
    const { assets } = pairEntries([e('orphan.NEF')]);
    expect(assets[0]).toMatchObject({ id: 'orphan', jpg: null, raws: ['orphan.NEF'] });
  });

  it('只有 JPG 的孤儿也产出资产，raws 为空数组', () => {
    const { assets } = pairEntries([e('solo.JPG', 555, 42)]);
    expect(assets[0]).toMatchObject({ id: 'solo', raws: [], jpg: 'solo.JPG' });
    expect(assets[0].jpgSize).toBe(555);
    expect(assets[0].jpgMtimeMs).toBe(42);
  });

  it('同 stem 多个 JPG 时取字典序第一个并记警告', () => {
    const { assets, warnings } = pairEntries([e('a.jpg'), e('a.JPEG')]);
    expect(assets[0].jpg).toBe('a.JPEG');
    expect(warnings.some((w) => w.includes('a'))).toBe(true);
  });

  it('非照片扩展名被跳过并计数', () => {
    const { assets, skippedFiles } = pairEntries([e('note.txt'), e('a.CR3'), e('clip.MOV')]);
    expect(assets).toHaveLength(1);
    expect(skippedFiles).toBe(2);
  });

  it('无扩展名的文件被跳过', () => {
    const { assets, skippedFiles } = pairEntries([e('README')]);
    expect(assets).toHaveLength(0);
    expect(skippedFiles).toBe(1);
  });

  it('结果按 id 稳定排序', () => {
    const { assets } = pairEntries([e('b/2.CR3'), e('a/1.CR3'), e('b/1.CR3')]);
    expect(assets.map((a) => a.id)).toEqual(['a/1', 'b/1', 'b/2']);
  });

  // I11：walk 从不 stat RAW，所以没有 JPG 的孤儿 RAW 完全没有时间来源——
  // normalizeMeta 拿 jpgMtimeMs（恒为 0）当兜底，整批孤儿 RAW 的 time 都是 0，
  // 按时间排序时全部堆在网格最前面，日期一律显示 1970。
  it('I11: 记录第一个 RAW 的 mtime，孤儿 RAW 才有兜底时间源', () => {
    const { assets } = pairEntries([e('ORPHAN.CR3', 100, 1700000000000)]);
    expect(assets[0].jpg).toBeNull();
    expect(assets[0].rawMtimeMs).toBe(1700000000000);
  });

  it('I11: 一个资产有多个 RAW 时取第一个遇到的 mtime', () => {
    const { assets } = pairEntries([e('M.CR3', 100, 111), e('M.DNG', 100, 222)]);
    expect(assets[0].rawMtimeMs).toBe(111);
  });

  it('I11: 有 JPG 的资产照样记 RAW 的 mtime，但 jpgMtimeMs 仍然是 JPG 的', () => {
    const { assets } = pairEntries([e('A.CR3', 100, 111), e('A.JPG', 200, 999)]);
    expect(assets[0].rawMtimeMs).toBe(111);
    expect(assets[0].jpgMtimeMs).toBe(999);
  });

  it('空输入返回空结果', () => {
    expect(pairEntries([])).toEqual({ assets: [], warnings: [], skippedFiles: 0 });
  });
});

describe('扩展名表', () => {
  it('覆盖主流相机 RAW', () => {
    for (const ext of ['cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'dng', 'pef', 'srw']) {
      expect(RAW_EXTS.has(ext)).toBe(true);
    }
  });
  it('JPG 三种写法都认', () => {
    expect([...JPG_EXTS].sort()).toEqual(['jpe', 'jpeg', 'jpg']);
  });
});

describe('walk', () => {
  let tmp;
  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scan-')));
    await fs.mkdir(path.join(tmp, 'cam-a'), { recursive: true });
    await fs.mkdir(path.join(tmp, '.photocull', 'thumbs'), { recursive: true });
    await fs.mkdir(path.join(tmp, '.hidden'), { recursive: true });
    await fs.mkdir(path.join(tmp, '__MACOSX'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'root.JPG'), 'x');
    await fs.writeFile(path.join(tmp, 'cam-a', 'IMG_1.CR3'), 'xx');
    await fs.writeFile(path.join(tmp, '.photocull', 'thumbs', 'cached.webp'), 'x');
    await fs.writeFile(path.join(tmp, '.hidden', 'secret.JPG'), 'x');
    await fs.writeFile(path.join(tmp, '__MACOSX', 'junk.JPG'), 'x');
  });
  afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('递归收集文件并输出 POSIX 相对路径', async () => {
    const { entries } = await walk(tmp);
    const paths = entries.map((x) => x.path).sort();
    expect(paths).toEqual(['cam-a/IMG_1.CR3', 'root.JPG']);
  });

  it('跳过 .photocull / 隐藏目录 / __MACOSX', async () => {
    const { entries } = await walk(tmp);
    expect(entries.some((x) => x.path.includes('.photocull'))).toBe(false);
    expect(entries.some((x) => x.path.includes('.hidden'))).toBe(false);
    expect(entries.some((x) => x.path.includes('__MACOSX'))).toBe(false);
  });

  it('带上 size 与 mtimeMs', async () => {
    const { entries } = await walk(tmp);
    const one = entries.find((x) => x.path === 'cam-a/IMG_1.CR3');
    expect(one.size).toBe(2);
    expect(one.mtimeMs).toBeGreaterThan(0);
  });

  it('超过深度上限时停止下探并记警告', async () => {
    const { entries, warnings } = await walk(tmp, { maxDepth: 0 });
    expect(entries.map((x) => x.path)).toEqual(['root.JPG']);
    expect(warnings.some((w) => w.includes('深度'))).toBe(true);
  });

  it('不跟随目录符号链接（防环）', async () => {
    const linked = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scan-link-')));
    await fs.writeFile(path.join(linked, 'far.JPG'), 'x');
    await fs.symlink(linked, path.join(tmp, 'loop'));
    const { entries } = await walk(tmp);
    expect(entries.some((x) => x.path.includes('far'))).toBe(false);
    await fs.rm(path.join(tmp, 'loop'), { force: true });
    await fs.rm(linked, { recursive: true, force: true });
  });

  it('onBatch 选项会在末尾调用一次，传入累计文件总数', async () => {
    const batches = [];
    const { entries } = await walk(tmp, { onBatch: (count) => batches.push(count) });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toBe(entries.length);
  });

  it('没有 onBatch 选项时不抛异常', async () => {
    await expect(walk(tmp)).resolves.toBeDefined();
  });

  it('onBatch 接收的计数是累计 entries.length，不是每批增量', async () => {
    const tmp2 = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scan-batch-')));
    // 创建 5 个文件，用 batchSize: 2，期望收到累计计数 [2, 4, 5]
    // 如果实现错误地传递 sinceBatch（增量），会得到 [2, 2, 1]
    await fs.writeFile(path.join(tmp2, 'f1.jpg'), 'x');
    await fs.writeFile(path.join(tmp2, 'f2.jpg'), 'x');
    await fs.writeFile(path.join(tmp2, 'f3.jpg'), 'x');
    await fs.writeFile(path.join(tmp2, 'f4.jpg'), 'x');
    await fs.writeFile(path.join(tmp2, 'f5.jpg'), 'x');
    const counts = [];
    await walk(tmp2, { batchSize: 2, onBatch: (count) => counts.push(count) });
    await fs.rm(tmp2, { recursive: true, force: true });
    // 累计计数序列：读完2个→[2]，读完4个→[2,4]，最后1个在末尾→[2,4,5]
    expect(counts).toEqual([2, 4, 5]);
  });
});

describe('scanFolder', () => {
  let tmp;
  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scanf-')));
    await fs.mkdir(path.join(tmp, 'cam-b'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'A.CR3'), 'x');
    await fs.writeFile(path.join(tmp, 'A.JPG'), 'x');
    await fs.writeFile(path.join(tmp, 'cam-b', 'A.CR3'), 'x');
    await fs.writeFile(path.join(tmp, 'cam-b', 'A.JPG'), 'x');
    await fs.writeFile(path.join(tmp, 'notes.txt'), 'x');
  });
  afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('端到端产出跨目录不撞车的资产表', async () => {
    const { assets, skippedFiles } = await scanFolder(tmp);
    expect(assets.map((a) => a.id)).toEqual(['A', 'cam-b/A']);
    expect(skippedFiles).toBe(1);
  });

  // MINOR：软链接一律不跟随（防成环、防越界），这没问题；问题是软链接过来的**照片**
  // 以前既不进资产表也不进任何计数，完全静默地消失——正是规格里说的
  // "静默丢图是最不可接受的失败模式"。至少要让它出现在"已跳过 N 个"那个数字里。
  it('软链接的照片文件被计入 skippedFiles，而不是静默消失', async () => {
    const linkTarget = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scanf-link-')));
    await fs.writeFile(path.join(linkTarget, 'real.JPG'), 'x');
    const before = (await scanFolder(tmp)).skippedFiles;
    await fs.symlink(path.join(linkTarget, 'real.JPG'), path.join(tmp, 'linked.JPG'));
    await fs.symlink(path.join(linkTarget, 'real.JPG'), path.join(tmp, 'linked.CR3'));
    try {
      const { assets, skippedFiles } = await scanFolder(tmp);
      // 仍然不跟随：不能出现在资产表里。
      expect(assets.map((a) => a.id)).toEqual(['A', 'cam-b/A']);
      // 但必须被数出来——JPG 和 RAW 的软链接各算一个。
      expect(skippedFiles).toBe(before + 2);
    } finally {
      await fs.rm(path.join(tmp, 'linked.JPG'), { force: true });
      await fs.rm(path.join(tmp, 'linked.CR3'), { force: true });
      await fs.rm(linkTarget, { recursive: true, force: true });
    }
  });

  it('软链接的非照片文件不计入 skippedFiles（那本来就不是丢图）', async () => {
    const before = (await scanFolder(tmp)).skippedFiles;
    await fs.symlink(path.join(tmp, 'notes.txt'), path.join(tmp, 'linked.txt'));
    try {
      expect((await scanFolder(tmp)).skippedFiles).toBe(before);
    } finally {
      await fs.rm(path.join(tmp, 'linked.txt'), { force: true });
    }
  });
});
