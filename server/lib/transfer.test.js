import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  planTarget, copyVerified, moveVerified, runExport, TransferError, MANIFEST_HEADER,
} from './transfer.js';

/** manifest 的列位置，按表头查——加一列不该让"status 列说了什么"这类断言全线失守。 */
const COL = Object.fromEntries(MANIFEST_HEADER.map((name, i) => [name, i]));
const cell = (row, name) => row.split(',')[COL[name]];
const manifestRows = (csv) => csv.split('\r\n').filter(Boolean).slice(1);   // 去掉表头
const rowFor = (csv, assetId) => manifestRows(csv).find((r) => r.split(',')[0] === assetId);

let src, dest;

beforeEach(async () => {
  src = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tx-src-')));
  dest = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tx-dest-')));
});
afterEach(async () => {
  await fs.rm(src, { recursive: true, force: true });
  await fs.rm(dest, { recursive: true, force: true });
});

const write = async (dir, name, content) => {
  const p = path.join(dir, name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
  return p;
};

describe('planTarget', () => {
  it('目标不存在时写入', async () => {
    const s = await write(src, 'a.CR3', 'hello');
    const plan = await planTarget(path.join(dest, 'a.CR3'), await fs.stat(s));
    expect(plan.action).toBe('write');
    expect(plan.finalPath).toBe(path.join(dest, 'a.CR3'));
  });

  it('目标已存在且大小与 mtime 一致时跳过', async () => {
    const s = await write(src, 'a.CR3', 'hello');
    const st = await fs.stat(s);
    const d = await write(dest, 'a.CR3', 'hello');
    await fs.utimes(d, st.atime, st.mtime);
    const plan = await planTarget(d, st);
    expect(plan.action).toBe('skip');
  });

  it('目标存在但内容不同则改名', async () => {
    const s = await write(src, 'a.CR3', 'hello world');
    await write(dest, 'a.CR3', 'different');
    const plan = await planTarget(path.join(dest, 'a.CR3'), await fs.stat(s));
    expect(plan.action).toBe('rename');
    expect(path.basename(plan.finalPath)).toBe('a_1.CR3');
  });

  it('改名会一直找到可用的后缀', async () => {
    const s = await write(src, 'a.CR3', 'hello world');
    await write(dest, 'a.CR3', 'x');
    await write(dest, 'a_1.CR3', 'y');
    await write(dest, 'a_2.CR3', 'z');
    const plan = await planTarget(path.join(dest, 'a.CR3'), await fs.stat(s));
    expect(path.basename(plan.finalPath)).toBe('a_3.CR3');
  });

  it('mtime 差 1 秒以内仍算相同（FAT32 有 2 秒精度）', async () => {
    const s = await write(src, 'a.CR3', 'hello');
    const st = await fs.stat(s);
    const d = await write(dest, 'a.CR3', 'hello');
    await fs.utimes(d, st.atime, new Date(st.mtime.getTime() + 900));
    expect((await planTarget(d, st)).action).toBe('skip');
  });
});

describe('copyVerified', () => {
  it('复制后大小一致并保留 mtime', async () => {
    const s = await write(src, 'a.CR3', 'abcdef');
    const d = path.join(dest, 'sub', 'a.CR3');
    await copyVerified(s, d);
    expect(await fs.readFile(d, 'utf8')).toBe('abcdef');
    const [ss, ds] = [await fs.stat(s), await fs.stat(d)];
    expect(ds.size).toBe(ss.size);
    expect(Math.abs(ds.mtimeMs - ss.mtimeMs)).toBeLessThan(2000);
  });

  it('自动创建缺失的目标子目录', async () => {
    const s = await write(src, 'a.CR3', 'x');
    await copyVerified(s, path.join(dest, 'deep', 'deeper', 'a.CR3'));
    expect(await fs.readFile(path.join(dest, 'deep', 'deeper', 'a.CR3'), 'utf8')).toBe('x');
  });

  it('源文件不存在时抛错且不留下残片', async () => {
    const d = path.join(dest, 'ghost.CR3');
    await expect(copyVerified(path.join(src, 'ghost.CR3'), d)).rejects.toThrow();
    await expect(fs.access(d)).rejects.toThrow();
  });

  it('fs.copyFile 中途失败（如 ENOSPC）时清理半截残片，不留下损坏文件', async () => {
    const s = await write(src, 'a.CR3', 'abcdefghij');
    const d = path.join(dest, 'a.CR3');
    // 模拟磁盘写到一半没空间了：copyFile 已经把部分字节落到 dest，随后才抛错。
    const spy = vi.spyOn(fs, 'copyFile').mockImplementation(async (_from, to) => {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.writeFile(to, 'partial-bytes-only');
      throw new Error('ENOSPC: no space left on device');
    });
    try {
      await expect(copyVerified(s, d)).rejects.toThrow('ENOSPC');
      await expect(fs.access(d)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('moveVerified', () => {
  it('复制校验通过后才删除源文件', async () => {
    const s = await write(src, 'a.CR3', 'payload');
    const d = path.join(dest, 'a.CR3');
    await moveVerified(s, d);
    expect(await fs.readFile(d, 'utf8')).toBe('payload');
    await expect(fs.access(s)).rejects.toThrow();
  });

  it('复制失败时源文件原封不动', async () => {
    const s = await write(src, 'a.CR3', 'payload');
    // 目标路径的父级是个文件，mkdir 必然失败
    await write(dest, 'blocker', 'x');
    await expect(moveVerified(s, path.join(dest, 'blocker', 'a.CR3'))).rejects.toThrow();
    expect(await fs.readFile(s, 'utf8')).toBe('payload');
  });
});

describe('runExport', () => {
  const mkAssets = async () => {
    await write(src, 'A.CR3', 'raw-a');
    await write(src, 'A.JPG', 'jpg-a');
    await write(src, 'cam-b/B.CR3', 'raw-b');
    await write(src, 'cam-b/B.JPG', 'jpg-b');
    await write(src, 'C.JPG', 'jpg-c-only');
    return [
      { id: 'A', dir: '', stem: 'A', raws: ['A.CR3'], jpg: 'A.JPG' },
      { id: 'cam-b/B', dir: 'cam-b', stem: 'B', raws: ['B.CR3'], jpg: 'B.JPG' },
      { id: 'C', dir: '', stem: 'C', raws: [], jpg: 'C.JPG' },
    ];
  };
  const marks = { A: 'pick', 'cam-b/B': 'pick', C: 'pick' };

  it('只导出收藏的 RAW，保留相对目录结构', async () => {
    const assets = await mkAssets();
    const s = await runExport({ root: src, destRoot: dest, assets, marks, mode: 'copy' }, {});
    expect(s.exported).toBe(2);
    expect(await fs.readFile(path.join(dest, 'A.CR3'), 'utf8')).toBe('raw-a');
    expect(await fs.readFile(path.join(dest, 'cam-b', 'B.CR3'), 'utf8')).toBe('raw-b');
  });

  it('没有 RAW 的收藏项计入 missingRaw 而不是静默丢弃', async () => {
    const assets = await mkAssets();
    const s = await runExport({ root: src, destRoot: dest, assets, marks, mode: 'copy' }, {});
    expect(s.missingRaw).toEqual(['C']);
  });

  it('未收藏的资产不导出', async () => {
    const assets = await mkAssets();
    const s = await runExport({ root: src, destRoot: dest, assets, marks: { A: 'pick' }, mode: 'copy' }, {});
    expect(s.exported).toBe(1);
    await expect(fs.access(path.join(dest, 'cam-b', 'B.CR3'))).rejects.toThrow();
  });

  it('reject 的资产即使在 marks 里也不导出', async () => {
    const assets = await mkAssets();
    const s = await runExport(
      { root: src, destRoot: dest, assets, marks: { A: 'pick', 'cam-b/B': 'reject' }, mode: 'copy' }, {});
    expect(s.exported).toBe(1);
  });

  it('flatten 把所有文件放进单层目录', async () => {
    const assets = await mkAssets();
    await runExport({ root: src, destRoot: dest, assets, marks, mode: 'copy', flatten: true }, {});
    expect(await fs.readFile(path.join(dest, 'B.CR3'), 'utf8')).toBe('raw-b');
  });

  it('includeJpg 同时复制 JPG', async () => {
    const assets = await mkAssets();
    await runExport({ root: src, destRoot: dest, assets, marks, mode: 'copy', includeJpg: true }, {});
    expect(await fs.readFile(path.join(dest, 'A.JPG'), 'utf8')).toBe('jpg-a');
  });

  it('jpgSubdir 把 JPG 放进子目录', async () => {
    const assets = await mkAssets();
    await runExport({
      root: src, destRoot: dest, assets, marks, mode: 'copy', includeJpg: true, jpgSubdir: 'JPG',
    }, {});
    expect(await fs.readFile(path.join(dest, 'JPG', 'A.JPG'), 'utf8')).toBe('jpg-a');
  });

  it('一个资产的多个 RAW 全部导出', async () => {
    await write(src, 'M.CR3', 'r1');
    await write(src, 'M.DNG', 'r2');
    const assets = [{ id: 'M', dir: '', stem: 'M', raws: ['M.CR3', 'M.DNG'], jpg: null }];
    const s = await runExport({ root: src, destRoot: dest, assets, marks: { M: 'pick' }, mode: 'copy' }, {});
    expect(s.exported).toBe(2);
  });

  it('move 模式导出后源 RAW 消失', async () => {
    const assets = await mkAssets();
    await runExport({ root: src, destRoot: dest, assets, marks, mode: 'move' }, {});
    await expect(fs.access(path.join(src, 'A.CR3'))).rejects.toThrow();
    expect(await fs.readFile(path.join(dest, 'A.CR3'), 'utf8')).toBe('raw-a');
  });

  it('拒绝导出到源目录内部', async () => {
    const assets = await mkAssets();
    await expect(runExport(
      { root: src, destRoot: path.join(src, 'out'), assets, marks, mode: 'copy' }, {}))
      .rejects.toBeInstanceOf(TransferError);
  });

  it('拒绝导出到源目录本身', async () => {
    const assets = await mkAssets();
    await expect(runExport({ root: src, destRoot: src, assets, marks, mode: 'copy' }, {}))
      .rejects.toBeInstanceOf(TransferError);
  });

  it('目标目录只是与源目录路径前缀相同（不是子目录）时仍然允许', async () => {
    // /tmp/tx-src-abc 和 /tmp/tx-src-abc-out：字符串前缀相同，但后者不是前者的子目录。
    const assets = await mkAssets();
    const siblingDest = `${src}-out`;
    try {
      const s = await runExport({ root: src, destRoot: siblingDest, assets, marks, mode: 'copy' }, {});
      expect(s.exported).toBe(2);
    } finally {
      await fs.rm(siblingDest, { recursive: true, force: true });
    }
  });

  it('destRoot 是指向源目录内部的符号链接时也被拒绝', async () => {
    // isWithin 只做字符串比较，不解析符号链接；这里的链接字符串上"不在 src 里"，
    // 但链接目标确确实实落在 src 内部，必须先 realpath 才能识破。
    const assets = await mkAssets();
    const secret = path.join(src, 'secret');
    await fs.mkdir(secret, { recursive: true });
    const link = path.join(dest, 'link-into-src');
    await fs.symlink(secret, link, 'dir');
    await expect(runExport({ root: src, destRoot: link, assets, marks, mode: 'copy' }, {}))
      .rejects.toBeInstanceOf(TransferError);
  });

  it('destRoot 是指向源目录之外真实位置的符号链接时仍然允许导出', async () => {
    const assets = await mkAssets();
    const realTarget = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tx-real-')));
    const link = path.join(dest, 'link-outside');
    await fs.symlink(realTarget, link, 'dir');
    try {
      const s = await runExport({ root: src, destRoot: link, assets, marks, mode: 'copy' }, {});
      expect(s.exported).toBe(2);
      expect(await fs.readFile(path.join(realTarget, 'A.CR3'), 'utf8')).toBe('raw-a');
    } finally {
      await fs.rm(realTarget, { recursive: true, force: true });
    }
  });

  it('生成 manifest.csv 与 rejected.txt', async () => {
    const assets = await mkAssets();
    await runExport({
      root: src, destRoot: dest, assets,
      marks: { A: 'pick', 'cam-b/B': 'reject' }, mode: 'copy', manifest: true,
      metas: new Map([['A', { time: Date.parse('2026-07-26T09:00:00Z') }]]),
    }, {});
    const csv = await fs.readFile(path.join(dest, 'manifest.csv'), 'utf8');
    expect(csv).toContain('assetId');
    expect(csv).toContain('A');
    const rejected = await fs.readFile(path.join(dest, 'rejected.txt'), 'utf8');
    expect(rejected.trim()).toBe('cam-b/B');
  });

  it('跳过的文件不会在 manifest 里被记成已导出，Summary 单独列出被跳过的资产', async () => {
    const assets = await mkAssets();
    // 先正常导出一次。
    const s1 = await runExport({ root: src, destRoot: dest, assets, marks, mode: 'copy' }, {});
    expect(s1.exported).toBe(2);

    // 源文件大小、mtime 都没变，第二次导出应该整批走 skip 分支（快速续传路径）。
    const s2 = await runExport(
      { root: src, destRoot: dest, assets, marks, mode: 'copy', manifest: true }, {});

    expect(s2.exported).toBe(0);
    expect(s2.skipped).toBe(2);
    expect(s2.skippedAssets).toHaveLength(2);
    expect(s2.skippedAssets).toEqual(expect.arrayContaining([
      { id: 'A', existingPath: path.join(dest, 'A.CR3') },
      { id: 'cam-b/B', existingPath: path.join(dest, 'cam-b', 'B.CR3') },
    ]));

    const csv = await fs.readFile(path.join(dest, 'manifest.csv'), 'utf8');
    const aRow = rowFor(csv, 'A');
    expect(aRow).toBeDefined();
    // 关键断言：这一行必须标注为 skipped，绝不能让 status 列（或列缺失）
    // 让人误以为这个文件是这次导出写入的。
    expect(cell(aRow, 'status')).toBe('skipped');
  });

  it('撞名改名的文件会记录在 Summary.renamedAssets 里，manifest 标注为 renamed', async () => {
    const assets = await mkAssets();
    // 目标位置预先放一个内容不同（大小不同）的同名文件，模拟"另一批素材撞名"。
    await write(dest, 'A.CR3', 'a-completely-different-and-longer-payload');

    const s = await runExport(
      { root: src, destRoot: dest, assets, marks, mode: 'copy', manifest: true }, {});

    expect(s.renamed).toBe(1);
    expect(s.renamedAssets).toEqual([{ id: 'A', path: path.join(dest, 'A_1.CR3') }]);
    expect(await fs.readFile(path.join(dest, 'A_1.CR3'), 'utf8')).toBe('raw-a');
    // 撞名的旧文件原封不动，没有被覆盖。
    expect(await fs.readFile(path.join(dest, 'A.CR3'), 'utf8')).toBe('a-completely-different-and-longer-payload');

    const csv = await fs.readFile(path.join(dest, 'manifest.csv'), 'utf8');
    const aRow = rowFor(csv, 'A');
    expect(aRow).toContain('A_1.CR3');
    expect(cell(aRow, 'status')).toBe('renamed');
  });

  it('上报进度', async () => {
    const assets = await mkAssets();
    const seen = [];
    await runExport({ root: src, destRoot: dest, assets, marks, mode: 'copy' },
      { onProgress: (p) => seen.push(p.done) });
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBe(2);
  });

  it('signal 中止后停止处理并标记 canceled', async () => {
    const assets = await mkAssets();
    const ctrl = new AbortController();
    ctrl.abort();
    const s = await runExport({ root: src, destRoot: dest, assets, marks, mode: 'copy' },
      { signal: ctrl.signal });
    expect(s.canceled).toBe(true);
    expect(s.exported).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // I4：取消时也必须留下记录。move 模式下取消，前面那些源 RAW 已经被删掉了，而
  // summary 只活在浏览器的 React state 里，刷新一下就没了——取消恰恰是最需要
  // 记录的那条路径，旧实现却偏偏是唯一不写记录的。
  // ───────────────────────────────────────────────────────────────────────────
  it('I4: 取消之后仍然写出 manifest.csv 和 rejected.txt', async () => {
    const assets = await mkAssets();
    const ctrl = new AbortController();
    ctrl.abort();

    const s = await runExport({
      root: src, destRoot: dest, assets,
      marks: { A: 'pick', 'cam-b/B': 'reject', C: 'pick' }, mode: 'move', manifest: true,
    }, { signal: ctrl.signal });

    expect(s.canceled).toBe(true);
    const csv = await fs.readFile(path.join(dest, 'manifest.csv'), 'utf8');
    expect(csv).toContain('assetId');
    const rejected = await fs.readFile(path.join(dest, 'rejected.txt'), 'utf8');
    expect(rejected.trim()).toBe('cam-b/B');
  });

  it('I4: 取消时没轮到的收藏 RAW 也出行，标成 canceled', async () => {
    const assets = await mkAssets();
    const ctrl = new AbortController();
    // 第一个文件处理完就取消：一半已经落地、一半还没轮到，正是摄影师按下取消的形状。
    const s = await runExport(
      { root: src, destRoot: dest, assets, marks, mode: 'move', manifest: true },
      { signal: ctrl.signal, onProgress: () => ctrl.abort() });

    expect(s.canceled).toBe(true);
    expect(s.exported).toBe(1);

    const csv = await fs.readFile(path.join(dest, 'manifest.csv'), 'utf8');
    const statuses = manifestRows(csv).map((r) => cell(r, 'status'));
    expect(statuses).toContain('exported');
    expect(statuses).toContain('canceled');
    // 三个收藏资产（A / cam-b/B / C）一个都不能少。
    expect(new Set(manifestRows(csv).map((r) => r.split(',')[0])))
      .toEqual(new Set(['A', 'cam-b/B', 'C']));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // I5：manifest 必须为每一个收藏资产出行。旧实现把 push 放在 try 里面，失败的直接
  // 消失；没有 RAW 的收藏压根不进 job 列表，也不会出现——3 个收藏只看到 2 行，
  // 而且无从知道少的是哪一个、为什么少。
  // ───────────────────────────────────────────────────────────────────────────
  it('I5: 拷贝失败的收藏出 failed 行，并带上失败原因', async () => {
    await write(src, 'ok.CR3', 'fine');
    const assets = [
      { id: 'ok', dir: '', stem: 'ok', raws: ['ok.CR3'], jpg: null },
      { id: 'gone', dir: '', stem: 'gone', raws: ['gone.CR3'], jpg: null },   // 源文件不存在
    ];
    const s = await runExport({
      root: src, destRoot: dest, assets, marks: { ok: 'pick', gone: 'pick' },
      mode: 'copy', manifest: true,
    }, {});

    expect(s.errors).toHaveLength(1);
    const csv = await fs.readFile(path.join(dest, 'manifest.csv'), 'utf8');
    const goneRow = rowFor(csv, 'gone');
    expect(goneRow, '失败的收藏必须出现在 manifest 里').toBeDefined();
    expect(cell(goneRow, 'status')).toBe('failed');
    expect(goneRow).toMatch(/ENOENT/);            // 原因写进了 note 列
    expect(cell(rowFor(csv, 'ok'), 'status')).toBe('exported');
  });

  it('I5: 收藏了但没有 RAW 的资产出 no-raw 行', async () => {
    const assets = await mkAssets();
    const s = await runExport(
      { root: src, destRoot: dest, assets, marks, mode: 'copy', manifest: true }, {});

    expect(s.missingRaw).toEqual(['C']);
    const csv = await fs.readFile(path.join(dest, 'manifest.csv'), 'utf8');
    const cRow = rowFor(csv, 'C');
    expect(cRow, '没有 RAW 的收藏也必须出现在 manifest 里').toBeDefined();
    expect(cell(cRow, 'status')).toBe('no-raw');
    // 每一个收藏资产都有行——README 承诺的对账关系必须成立。
    expect(new Set(manifestRows(csv).map((r) => r.split(',')[0])))
      .toEqual(new Set(['A', 'cam-b/B', 'C']));
  });

  it('MINOR: move 时删源失败记成 moved-copy-ok-delete-failed，而不是彻底失败', async () => {
    const assets = await mkAssets();
    const srcRaw = path.join(src, 'A.CR3');
    const realRm = fs.rm.bind(fs);
    const spy = vi.spyOn(fs, 'rm').mockImplementation(async (target, opts) => {
      if (target === srcRaw) throw new Error('EACCES: 源文件删不掉');
      return realRm(target, opts);
    });
    try {
      await runExport(
        { root: src, destRoot: dest, assets, marks, mode: 'move', manifest: true }, {});
    } finally {
      spy.mockRestore();
    }

    // 文件确确实实已经正确送达，只是源文件还在——记成 failed 是漏报，
    // 摄影师会以为要重导一次，而重导只会撞名生成一份 _1 副本。
    expect(await fs.readFile(path.join(dest, 'A.CR3'), 'utf8')).toBe('raw-a');
    const csv = await fs.readFile(path.join(dest, 'manifest.csv'), 'utf8');
    const aRow = rowFor(csv, 'A');
    expect(cell(aRow, 'status')).toBe('moved-copy-ok-delete-failed');
    expect(cell(aRow, 'exportedAs')).toBe('A.CR3');   // 送达位置照样记下来
  });

  // ───────────────────────────────────────────────────────────────────────────
  // I6：工具对照片一张都不覆盖，对自己的审计文件却是裸 writeFile 无条件覆盖。
  // ───────────────────────────────────────────────────────────────────────────
  it('I6: 第二次导出进同一个交付目录不会覆盖第一份 manifest / rejected', async () => {
    const assets = await mkAssets();
    await runExport({
      root: src, destRoot: dest, assets,
      marks: { A: 'pick', 'cam-b/B': 'reject' }, mode: 'copy', manifest: true,
    }, {});
    const first = await fs.readFile(path.join(dest, 'manifest.csv'), 'utf8');
    const firstRejected = await fs.readFile(path.join(dest, 'rejected.txt'), 'utf8');

    // 第二次：标记换了一批，导出结论也不一样（A 这次是 skipped）。
    await runExport({
      root: src, destRoot: dest, assets,
      marks: { A: 'pick', C: 'pick' }, mode: 'copy', manifest: true,
    }, {});

    // 第一份原封不动。
    expect(await fs.readFile(path.join(dest, 'manifest.csv'), 'utf8')).toBe(first);
    expect(await fs.readFile(path.join(dest, 'rejected.txt'), 'utf8')).toBe(firstRejected);
    // 第二份另起一个名字，内容是这一次的结论。
    const second = await fs.readFile(path.join(dest, 'manifest_1.csv'), 'utf8');
    expect(cell(rowFor(second, 'A'), 'status')).toBe('skipped');
    await fs.access(path.join(dest, 'rejected_1.txt'));
  });

  it('I13: jpgSubdir 含路径分隔符或 .. 时直接拒绝，不写任何文件', async () => {
    const assets = await mkAssets();
    for (const bad of ['../../../../tmp/x', '..', 'a/b', 'a\\b']) {
      await expect(runExport({
        root: src, destRoot: dest, assets, marks, mode: 'copy',
        includeJpg: true, jpgSubdir: bad,
      }, {}), `jpgSubdir=${bad} 必须被拒绝`).rejects.toBeInstanceOf(TransferError);
    }
    // 一个文件都没被写出去——尤其重要的是 move 模式下这个请求还会删源文件。
    await expect(fs.access(path.join(dest, 'A.CR3'))).rejects.toThrow();
  });

  it('单个文件出错不中断整场导出', async () => {
    await write(src, 'ok.CR3', 'fine');
    const assets = [
      { id: 'ok', dir: '', stem: 'ok', raws: ['ok.CR3'], jpg: null },
      { id: 'gone', dir: '', stem: 'gone', raws: ['gone.CR3'], jpg: null },
    ];
    const s = await runExport({
      root: src, destRoot: dest, assets, marks: { ok: 'pick', gone: 'pick' }, mode: 'copy',
    }, {});
    expect(s.exported).toBe(1);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0].id).toBe('gone');
  });
});
