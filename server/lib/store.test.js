import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readMarksFile, writeMarksFile, createMarkStore, marksDir, DEFAULT_SETTINGS,
  normalizeCellWidth, CELL_WIDTH_MIN, CELL_WIDTH_MAX, sanitizeHidden,
} from './store.js';

let tmp;
beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'store-')));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const marksPath = (root) => path.join(marksDir(root), 'marks.json');
const bakPath = (root) => path.join(marksDir(root), 'marks.bak.json');

describe('readMarksFile', () => {
  it('文件不存在时返回带默认设置的空壳', async () => {
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({});
    expect(data.settings).toEqual(DEFAULT_SETTINGS);
    expect(data.version).toBe(1);
  });

  it('读出已写入的标记', async () => {
    await writeMarksFile(tmp, { version: 1, marks: { 'cam-a/IMG_1': 'pick' }, settings: DEFAULT_SETTINGS });
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({ 'cam-a/IMG_1': 'pick' });
  });

  it('设置字段与默认值合并，缺失项补齐', async () => {
    await writeMarksFile(tmp, { version: 1, marks: {}, settings: { burstThresholdMs: 2500 } });
    const data = await readMarksFile(tmp);
    expect(data.settings.burstThresholdMs).toBe(2500);
    expect(data.settings.cellWidth).toBe(DEFAULT_SETTINGS.cellWidth);
  });

  it('主文件损坏时回退到备份', async () => {
    await writeMarksFile(tmp, { version: 1, marks: { a: 'pick' }, settings: {} });
    await writeMarksFile(tmp, { version: 1, marks: { a: 'pick', b: 'reject' }, settings: {} });
    await fs.writeFile(marksPath(tmp), 'not json at all');
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({ a: 'pick' });
    expect(data.recovered).toBe(true);
  });

  it('主文件与备份都损坏时返回空壳且标记未恢复', async () => {
    await fs.mkdir(marksDir(tmp), { recursive: true });
    await fs.writeFile(marksPath(tmp), 'garbage');
    await fs.writeFile(bakPath(tmp), 'garbage');
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({});
    expect(data.recovered).toBe(false);
  });

  it('丢弃非法的标记值', async () => {
    await fs.mkdir(marksDir(tmp), { recursive: true });
    await fs.writeFile(marksPath(tmp),
      JSON.stringify({ version: 1, marks: { a: 'pick', b: 'banana', c: null }, settings: {} }));
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({ a: 'pick' });
  });
});

describe('writeMarksFile', () => {
  it('写入后不留下 .tmp 文件', async () => {
    await writeMarksFile(tmp, { version: 1, marks: { a: 'pick' }, settings: {} });
    const files = await fs.readdir(marksDir(tmp));
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('第二次写入前把旧文件备份走', async () => {
    await writeMarksFile(tmp, { version: 1, marks: { a: 'pick' }, settings: {} });
    await writeMarksFile(tmp, { version: 1, marks: { b: 'reject' }, settings: {} });
    const bak = JSON.parse(await fs.readFile(bakPath(tmp), 'utf8'));
    expect(bak.marks).toEqual({ a: 'pick' });
  });

  it('写入 updatedAt 时间戳', async () => {
    await writeMarksFile(tmp, { version: 1, marks: {}, settings: {} });
    const data = JSON.parse(await fs.readFile(marksPath(tmp), 'utf8'));
    expect(Date.parse(data.updatedAt)).toBeGreaterThan(0);
  });

  it('F2: 写入中途崩溃时仍可读出完整旧数据', async () => {
    // 写入初始数据
    await writeMarksFile(tmp, { version: 1, marks: { a: 'pick' }, settings: {} });
    const initialData = await readMarksFile(tmp);
    expect(initialData.marks).toEqual({ a: 'pick' });

    // 保存初始的 marks.json，然后验证之后写入失败时它不变
    const initialPath = marksPath(tmp);
    const initialContent = await fs.readFile(initialPath, 'utf8');

    // 模拟 rename 失败（模拟写入中途崩溃）
    const originalRename = fs.rename;
    let shouldFail = false;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (old, newPath) => {
      if (shouldFail && newPath === initialPath) {
        throw new Error('ENOENT: rename failed');
      }
      return originalRename(old, newPath);
    });

    shouldFail = true;
    let caughtError = null;
    try {
      await writeMarksFile(tmp, { version: 1, marks: { b: 'reject' }, settings: {} });
    } catch (err) {
      caughtError = err;
    } finally {
      spy.mockRestore();
    }

    expect(caughtError).toBeTruthy();
    expect(caughtError.message).toContain('rename failed');

    // 验证读出的仍是原始数据
    const recovered = await readMarksFile(tmp);
    expect(recovered.marks).toEqual({ a: 'pick' });

    // 验证磁盘上的文件没变
    const fileContent = await fs.readFile(initialPath, 'utf8');
    expect(fileContent).toBe(initialContent);
  });

  it('残留的 .tmp 文件不影响读出数据', async () => {
    await writeMarksFile(tmp, { version: 1, marks: { a: 'pick' }, settings: {} });
    await fs.writeFile(marksPath(tmp) + '.tmp', 'garbage');
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({ a: 'pick' });
  });
});

describe('createMarkStore', () => {
  it('setMark 后防抖落盘', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 20 });
    store.setMark('a', 'pick');
    expect(store.data.marks.a).toBe('pick');
    await new Promise((r) => setTimeout(r, 80));
    const onDisk = await readMarksFile(tmp);
    expect(onDisk.marks.a).toBe('pick');
    await store.close();
  });

  it('传 null 即取消标记，且不写进文件', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 5 });
    store.setMark('a', 'pick');
    store.setMark('a', null);
    await store.flush();
    const onDisk = await readMarksFile(tmp);
    expect(onDisk.marks).toEqual({});
    await store.close();
  });

  it('连续多次修改只落盘最终状态', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 20 });
    store.setMark('a', 'pick');
    store.setMark('a', 'reject');
    store.setMark('b', 'pick');
    await store.flush();
    const onDisk = await readMarksFile(tmp);
    expect(onDisk.marks).toEqual({ a: 'reject', b: 'pick' });
    await store.close();
  });

  it('setSettings 只合并传入的字段', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 5 });
    store.setSettings({ burstThresholdMs: 2000 });
    await store.flush();
    const onDisk = await readMarksFile(tmp);
    expect(onDisk.settings.burstThresholdMs).toBe(2000);
    expect(onDisk.settings.cellWidth).toBe(DEFAULT_SETTINGS.cellWidth);
    await store.close();
  });

  // sanitize() 里的 sanitizeSettings() 只在读/写磁盘时跑；setSettings() 改的是
  // 进程内存里的 data.settings，从赋值那一刻起就会被 PUT /settings 自己的响应体、
  // GET /api/library/marks、POST /api/library/open、访客 join/resume 这四条路径
  // 原样回显给所有人，直到下次重启或落盘重读。这三条用例直接读内存（不等 flush、
  // 不经过磁盘），钉住 setSettings 自己必须归一，不能指望调用者已经归一过。
  it('setSettings 收到超范围的 cellWidth：内存里立刻就是钳制后的值', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 10000 });
    store.setSettings({ cellWidth: 99999 });
    expect(store.data.settings.cellWidth).toBe(CELL_WIDTH_MAX);
    await store.close();
  });

  it('setSettings 收到非法类型的 cellWidth：内存里回落默认值 210', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 10000 });
    store.setSettings({ cellWidth: 'banana' });
    expect(store.data.settings.cellWidth).toBe(210);
    await store.close();
  });

  // 起点必须先离开默认值 210：如果 setSettings 里 `'cellWidth' in next` 这个
  // 存在性判断被人顺手删掉（只留无条件的归一调用），normalizeCellWidth(undefined)
  // 正好等于 210，从默认值出发的话「被凭空赋值」与「没被碰过」两种结果完全撞车，
  // 这条用例就再也抓不到那次重构了。摄影师把宽度调到 350 之后，任何一次只改
  // sort 的 PUT /settings 都会把它静默弹回 210——正是要钉死的那个 bug。
  it('setSettings 只传别的字段时，cellWidth 不会被凭空赋值', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 10000 });
    store.setSettings({ cellWidth: 350 });
    store.setSettings({ sort: 'name' });
    expect(store.data.settings.cellWidth).toBe(350);
    expect(store.data.settings.sort).toBe('name');
    await store.close();
  });

  it('close 会把未落盘的改动刷出去', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 10000 });
    store.setMark('z', 'pick');
    await store.close();
    const onDisk = await readMarksFile(tmp);
    expect(onDisk.marks.z).toBe('pick');
  });

  it('拒绝非法标记值', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 5 });
    expect(() => store.setMark('a', 'banana')).toThrow();
    await store.close();
  });

  it('F3: close 后 setMark 抛出错误', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 5 });
    await store.close();
    expect(() => store.setMark('a', 'pick')).toThrow('Cannot modify a closed MarkStore');
  });

  it('F3: close 后 setSettings 抛出错误', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 5 });
    await store.close();
    expect(() => store.setSettings({ burstThresholdMs: 2000 })).toThrow('Cannot modify a closed MarkStore');
  });

  it('F4: 拒绝非对象的 marks 字段（数组）', async () => {
    await fs.mkdir(marksDir(tmp), { recursive: true });
    await fs.writeFile(marksPath(tmp),
      JSON.stringify({ version: 1, marks: ['pick', 'reject'], settings: {} }));
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({});
  });

  it('F4: 拒绝非对象的 marks 字段（字符串）', async () => {
    await fs.mkdir(marksDir(tmp), { recursive: true });
    await fs.writeFile(marksPath(tmp),
      JSON.stringify({ version: 1, marks: 'not an object', settings: {} }));
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({});
  });

  it('F4: 拒绝非对象的 marks 字段（数字）', async () => {
    await fs.mkdir(marksDir(tmp), { recursive: true });
    await fs.writeFile(marksPath(tmp),
      JSON.stringify({ version: 1, marks: 123, settings: {} }));
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({});
  });

  it('F4: 拒绝非对象的 marks 字段（null）', async () => {
    await fs.mkdir(marksDir(tmp), { recursive: true });
    await fs.writeFile(marksPath(tmp),
      JSON.stringify({ version: 1, marks: null, settings: {} }));
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({});
  });

  // sanitize() 有两条分支都要产出合法的 settings：正常分支和这条"marks 损坏
  // 时的早退分支"。以前两处各写各的 { ...DEFAULT_SETTINGS, ...settings }，
  // 容易只改对一处；F4 系列原本只用 settings: {} 探测，测不出旧 gridSize 在
  // 早退分支里有没有被迁移。这条把两件事撞在一起：marks 损坏 + 旧 gridSize。
  it('F4: marks 字段损坏时，settings 里的旧 gridSize 依然会被迁移成 cellWidth（早退分支也要走 sanitizeSettings）', async () => {
    await fs.mkdir(marksDir(tmp), { recursive: true });
    await fs.writeFile(marksPath(tmp),
      JSON.stringify({ version: 1, marks: 123, settings: { gridSize: 'large' } }));
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({});
    expect(data.settings.cellWidth).toBe(290);
  });

  // Task 7 的教训在 Task 14 上换了一副面孔重演一次：sanitize() 曾经有「正常分支」
  // 和「marks 损坏时的早退分支」两条路径，早退分支是手写的字面量，容易只在
  // 正常分支里接上 contrib、早退分支还留着旧形状。Task 14 把两条路径合并成了
  // 一条，但这条用例仍然值得钉住——它验的是「合并后的单一路径」这个结果，
  // 不是某一处具体的 if/else：marks 字段本身损坏，不能成为 contrib 被忽略、
  // 或者 hidden/marksMeta 缺字段的理由。
  it('marks 字段损坏但 contrib 完好时，contrib 仍是权威（不会退化成整份数据都读不出来）', async () => {
    await fs.mkdir(marksDir(tmp), { recursive: true });
    await fs.writeFile(marksPath(tmp), JSON.stringify({
      version: 1,
      marks: 123,
      contrib: { a: { admin: { mark: 'pick', at: 5 } } },
      settings: {},
    }));
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({ a: 'pick' });
    expect(data.marksMeta).toEqual({ a: { by: 'admin', at: 5 } });
    expect(data.contrib).toEqual({ a: { admin: { mark: 'pick', at: 5 } } });
    expect(data.hidden).toEqual([]);
  });

  // 分诊 m2：flush() 以前无条件落盘，于是每一次 open→close 都会重写 marks.json 并把
  // 旧的轮转成 marks.bak.json——哪怕这一场摄影师一个标记都没动。备份因此永远等于主
  // 文件，只能防住"同一场里写坏了"，从来防不住"昨天手滑标错了"。它同时也是只读文件夹
  // 上那个"什么都没改却在关闭时 500"的来源。
  it('m2: 一个标记都没动时，close() 不重写主文件，也不轮转备份', async () => {
    await writeMarksFile(tmp, { version: 1, marks: { a: 'pick' }, settings: {} });
    const before = await fs.readFile(marksPath(tmp), 'utf8');

    const store = await createMarkStore(tmp, { debounceMs: 5 });
    await store.close();

    await expect(fs.access(bakPath(tmp))).rejects.toThrow();   // 备份根本不该被创建
    expect(await fs.readFile(marksPath(tmp), 'utf8')).toBe(before);
  });

  it('m2: 真有改动时 close() 照常落盘（脏标志不能把该写的也挡掉）', async () => {
    await writeMarksFile(tmp, { version: 1, marks: { a: 'pick' }, settings: {} });
    const store = await createMarkStore(tmp, { debounceMs: 10000 });
    store.setMark('b', 'reject');
    await store.close();
    expect((await readMarksFile(tmp)).marks).toEqual({ a: 'pick', b: 'reject' });
  });

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(isRoot)('takeError 取走并清空后台落盘的错误（C1：以前没人读它）', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 5 });
    expect(store.takeError()).toBeFalsy();

    await fs.chmod(tmp, 0o555);   // 打开之后才变成不可写
    try {
      store.setMark('a', 'pick');
      await new Promise((r) => setTimeout(r, 150));   // 等防抖触发并失败

      const err = store.takeError();
      expect(err).toBeTruthy();
      expect(String(err.message)).toMatch(/EACCES|EPERM|EROFS/);
      // 取走即清空：下一次请求不该重复报同一个已经上报过的错误。
      expect(store.takeError()).toBeFalsy();
    } finally {
      await fs.chmod(tmp, 0o755);
    }
    await store.close();
  });

  it.skipIf(isRoot)('落盘失败后改动仍然是脏的，权限恢复后 close() 会把它补写进去', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 5 });
    await fs.chmod(tmp, 0o555);
    store.setMark('a', 'pick');
    await new Promise((r) => setTimeout(r, 150));
    expect(store.takeError()).toBeTruthy();

    await fs.chmod(tmp, 0o755);
    await store.close();
    expect((await readMarksFile(tmp)).marks).toEqual({ a: 'pick' });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Task 10：归属信息（marksMeta 平行表）
  //
  // 兼容性在这里是硬要求：marks 字段的形状**一个字节都不能变**。导出链路、
  // 前端 derive.ts、既有的乐观更新与回滚全都按 Record<id,'pick'|'reject'> 的
  // 读法工作，把归属塞进 marks 的值里（比如 {mark,by,at}）会同时打断这三条。
  // ───────────────────────────────────────────────────────────────────────────

  it('setMark 记下归属，磁盘上的 marks 仍然是 Record<id, "pick"|"reject">', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 5 });
    store.setMark('cam-a/IMG_0421', 'pick', { by: 'u_2c7b', at: 1785000123456 });
    await store.flush();

    const raw = JSON.parse(await fs.readFile(marksPath(tmp), 'utf8'));
    // 逐字节：marks 序列化出来必须和升级之前完全一样，值是裸字符串而不是对象。
    expect(JSON.stringify(raw.marks)).toBe('{"cam-a/IMG_0421":"pick"}');
    expect(raw.marksMeta).toEqual({ 'cam-a/IMG_0421': { by: 'u_2c7b', at: 1785000123456 } });
    await store.close();
  });

  // Task 14 之后：marksMeta 不再是独立归一的平行表，marks/marksMeta 都从 contrib
  // 派生。旧文件没有 contrib 字段时走 backfill()——任何缺失或损坏的归属都会
  // 退化成「admin，at 0」，而不是「没有归属」：contrib 里没有匿名票这种东西，
  // 每一个有效标记都必须有一个主人。这条与下面几条断言的更新都是同一条因果链。
  it('读旧格式（没有 marksMeta 字段）不报错，归属回填成 admin', async () => {
    await fs.mkdir(marksDir(tmp), { recursive: true });
    // 这就是升级之前的 marks.json：只有 version / updatedAt / marks / settings。
    await fs.writeFile(marksPath(tmp), JSON.stringify({
      version: 1, updatedAt: '2026-01-01T00:00:00.000Z',
      marks: { a: 'pick', b: 'reject' }, settings: {},
    }));
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({ a: 'pick', b: 'reject' });
    expect(data.marksMeta).toEqual({
      a: { by: 'admin', at: 0 },
      b: { by: 'admin', at: 0 },
    });
  });

  it('marksMeta 字段坏掉（数组/字符串/条目缺字段）时退化成 admin 归属，不影响 marks', async () => {
    await fs.mkdir(marksDir(tmp), { recursive: true });
    await fs.writeFile(marksPath(tmp), JSON.stringify({
      version: 1, marks: { a: 'pick' }, marksMeta: ['nonsense'], settings: {},
    }));
    expect((await readMarksFile(tmp)).marksMeta).toEqual({ a: { by: 'admin', at: 0 } });

    await fs.writeFile(marksPath(tmp), JSON.stringify({
      version: 1, marks: { a: 'pick' }, marksMeta: 'nonsense', settings: {},
    }));
    expect((await readMarksFile(tmp)).marksMeta).toEqual({ a: { by: 'admin', at: 0 } });

    await fs.writeFile(marksPath(tmp), JSON.stringify({
      version: 1,
      marks: { a: 'pick', b: 'pick', c: 'pick' },
      marksMeta: { a: { by: '', at: 1 }, b: { by: 'u_1' }, c: { by: 'u_1', at: 7 } },
      settings: {},
    }));
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({ a: 'pick', b: 'pick', c: 'pick' });
    // a、b 的归属条目本身是坏的（空 by / 缺 at），退化成 admin；c 是好的，原样保留。
    expect(data.marksMeta).toEqual({
      a: { by: 'admin', at: 0 },
      b: { by: 'admin', at: 0 },
      c: { by: 'u_1', at: 7 },
    });
  });

  it('取消标记时归属一并移除，不留下指向已不存在标记的孤儿', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 5 });
    store.setMark('a', 'pick', { by: 'u_1', at: 1 });
    // 同一个人取消自己那一票（换成别人取消是另一回事——见下面「取消时回退到
    // 上一个人那一票」，那条测的是按人记票，不是全局单一归属被清空）。
    store.setMark('a', null, { by: 'u_1', at: 2 });
    await store.flush();
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({});
    expect(data.marksMeta).toEqual({});
    await store.close();
  });

  it('不带归属的写落到 admin 名下，不会留着上一个人的名字', async () => {
    // Task 14 之前：这条路径会把 u_1 的归属删掉，marksMeta 变回空表。
    // 现在 contrib 是权威、没有匿名票——落不到任何人名下的写，落到 admin 名下。
    const store = await createMarkStore(tmp, { debounceMs: 5 });
    store.setMark('a', 'pick', { by: 'u_1', at: 1 });
    store.setMark('a', 'reject');            // 本机单机流程：没有 actor 概念
    await store.flush();
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({ a: 'reject' });
    expect(data.marksMeta).toEqual({ a: { by: 'admin', at: expect.any(Number) } });
    await store.close();
  });

  it('marks 里没有的 id，其归属条目在读取时被丢弃', async () => {
    await fs.mkdir(marksDir(tmp), { recursive: true });
    await fs.writeFile(marksPath(tmp), JSON.stringify({
      version: 1, marks: { a: 'pick' },
      marksMeta: { a: { by: 'u_1', at: 1 }, ghost: { by: 'u_1', at: 2 } },
      settings: {},
    }));
    const data = await readMarksFile(tmp);
    expect(data.marksMeta).toEqual({ a: { by: 'u_1', at: 1 } });
  });

  it('F1: 大规模并发防抖写入不会丢失标记或导致 ENOENT', async () => {
    // 种子数据：30,000 条标记使写入耗时 ~20-27ms（足以触发竞态）
    const largeMarks = {};
    for (let i = 0; i < 30000; i++) {
      largeMarks[`photo_${i}`] = 'pick';
    }
    await writeMarksFile(tmp, { version: 1, marks: largeMarks, settings: {} });

    // 创建 store，debounceMs: 1 使防抖定时器触发频繁
    const store = await createMarkStore(tmp, { debounceMs: 1 });

    // 快速连续修改，间隔 ~2ms（小于写入时间）以确保防抖定时器在写入中途触发
    // 这会导致多个 persist() 调用被安排，测试竞态条件
    const newMarks = {};
    for (let i = 0; i < 1000; i++) {
      const mark = i % 2 === 0 ? 'pick' : 'reject';
      store.setMark(`new_${i}`, mark);
      newMarks[`new_${i}`] = mark;
      if (i % 100 === 0) {
        // 小延迟，但不足以让所有防抖完成
        await new Promise((r) => setTimeout(r, 1));
      }
    }

    // 重点：不等待静默期，直接关闭
    // 这会导致多个防抖定时器在途中时调用 close()
    // 在原始的"thundering herd"代码中，这会导致 ENOENT 错误或数据丢失
    await store.close();

    // 验证关闭后没有错误（关键：不会抛 ENOENT）
    // 且所有标记都正确持久化
    const final = await readMarksFile(tmp);

    // 检查所有新添加的 1000 个标记
    for (let i = 0; i < 1000; i++) {
      expect(final.marks[`new_${i}`]).toBe(newMarks[`new_${i}`],
        `Mark new_${i} should be ${newMarks[`new_${i}`]} but got ${final.marks[`new_${i}`]}`);
    }

    // 检查所有原始的 30000 个标记都还在（未被竞态条件覆盖或丢失）
    for (let i = 0; i < 30000; i++) {
      expect(final.marks[`photo_${i}`]).toBe('pick',
        `Original mark photo_${i} was lost or corrupted`);
    }

    // 最终检查：总数应该是 31000
    expect(Object.keys(final.marks).length).toBe(31000);
  });
});

describe('normalizeCellWidth', () => {
  it('三档旧值迁移成现在 CELL_W 表里的那三个数', () => {
    // 迁移必须落在这三个数上，老文件夹的观感才一格都不变。
    expect(normalizeCellWidth('small')).toBe(150);
    expect(normalizeCellWidth('medium')).toBe(210);
    expect(normalizeCellWidth('large')).toBe(290);
  });

  it('合法数字原样通过', () => {
    expect(normalizeCellWidth(180)).toBe(180);
    expect(normalizeCellWidth(CELL_WIDTH_MIN)).toBe(CELL_WIDTH_MIN);
    expect(normalizeCellWidth(CELL_WIDTH_MAX)).toBe(CELL_WIDTH_MAX);
  });

  it('超范围的钳制到边界', () => {
    expect(normalizeCellWidth(50)).toBe(CELL_WIDTH_MIN);
    expect(normalizeCellWidth(9999)).toBe(CELL_WIDTH_MAX);
  });

  it('非数字一律回落 210', () => {
    expect(normalizeCellWidth(undefined)).toBe(210);
    expect(normalizeCellWidth(null)).toBe(210);
    expect(normalizeCellWidth('随便什么')).toBe(210);
    expect(normalizeCellWidth(NaN)).toBe(210);
    expect(normalizeCellWidth({})).toBe(210);
  });

  it('小数取整', () => {
    expect(normalizeCellWidth(180.7)).toBe(181);
  });
});

describe('settings 迁移', () => {
  it('读一个只有 gridSize 的旧文件，得到对应的 cellWidth', async () => {
    await writeMarksFile(tmp, { version: 1, marks: {}, settings: { gridSize: 'large' } });
    const data = await readMarksFile(tmp);
    expect(data.settings.cellWidth).toBe(290);
    expect(data.settings.gridSize).toBeUndefined();
  });

  it('cellWidth 与 gridSize 同时存在时以 cellWidth 为准', async () => {
    await writeMarksFile(tmp, { version: 1, marks: {}, settings: { gridSize: 'small', cellWidth: 333 } });
    const data = await readMarksFile(tmp);
    expect(data.settings.cellWidth).toBe(333);
  });
});

describe('sanitizeHidden', () => {
  it('放行未标记的 id', () => {
    expect(sanitizeHidden(['a', 'b'], {})).toEqual(['a', 'b']);
  });

  it('已标记的从 hidden 里剔除（不变量在读取层也兜一道）', () => {
    // 不变量不能只靠写入层挡——那假设了所有写入都经过我们的代码。
    // 脏数据、并发、手改文件都会造出「已标记 ∧ 已隐藏」这个非法状态。
    expect(sanitizeHidden(['a', 'b'], { a: 'pick' })).toEqual(['b']);
  });

  it('去重', () => {
    expect(sanitizeHidden(['a', 'a', 'b'], {})).toEqual(['a', 'b']);
  });

  it('非数组、非字符串元素一律丢弃，不抛', () => {
    expect(sanitizeHidden(undefined, {})).toEqual([]);
    expect(sanitizeHidden({ a: true }, {})).toEqual([]);
    expect(sanitizeHidden(['a', 1, null, '', 'b'], {})).toEqual(['a', 'b']);
  });
});

describe('marks 从 contrib 求得', () => {
  it('写标记时 marks 与 marksMeta 跟着更新', async () => {
    const store = await createMarkStore(tmp);
    store.setMark('a', 'pick', { by: 'u_ab', at: 100 });
    expect(store.data.marks.a).toBe('pick');
    expect(store.data.marksMeta.a).toEqual({ by: 'u_ab', at: 100 });
    expect(store.data.contrib.a).toEqual({ u_ab: { mark: 'pick', at: 100 } });
    await store.close();
  });

  it('后写的赢，和改造前的行为一模一样', async () => {
    const store = await createMarkStore(tmp);
    store.setMark('a', 'pick', { by: 'u_ab', at: 100 });
    store.setMark('a', 'reject', { by: 'admin', at: 200 });
    expect(store.data.marks.a).toBe('reject');
    expect(store.data.marksMeta.a).toEqual({ by: 'admin', at: 200 });
    await store.close();
  });

  it('取消时回退到上一个人那一票', async () => {
    // 改造前：新娘把摄影师收藏的一张改成排除、再自己取消，摄影师那一票就永久消失了。
    const store = await createMarkStore(tmp);
    store.setMark('a', 'pick', { by: 'admin', at: 100 });
    store.setMark('a', 'reject', { by: 'u_ab', at: 200 });
    store.setMark('a', null, { by: 'u_ab', at: 300 });

    expect(store.data.marks.a).toBe('pick');
    expect(store.data.marksMeta.a).toEqual({ by: 'admin', at: 100 });
    await store.close();
  });

  it('所有人都取消之后标记和归属一起消失', async () => {
    const store = await createMarkStore(tmp);
    store.setMark('a', 'pick', { by: 'admin', at: 100 });
    store.setMark('a', null, { by: 'admin', at: 200 });
    expect(store.data.marks.a).toBeUndefined();
    expect(store.data.marksMeta.a).toBeUndefined();
    expect(store.data.contrib.a).toBeUndefined();
    await store.close();
  });

  it('不带归属地写仍然记得住，算作 admin', async () => {
    // 本机单机流程没有 actor 这个概念。改造前这条路径会把归属删掉；
    // 现在它必须落到 admin 名下，否则 contrib 里会出现一张没有任何人的标记。
    const store = await createMarkStore(tmp);
    store.setMark('a', 'pick');
    expect(store.data.marks.a).toBe('pick');
    expect(store.data.contrib.a.admin.mark).toBe('pick');
    await store.close();
  });
});

describe('旧文件回填 contrib', () => {
  it('读一个没有 contrib 的旧文件，contrib 被回填出来', async () => {
    await writeMarksFile(tmp, {
      version: 1,
      marks: { a: 'pick', b: 'reject' },
      marksMeta: { a: { by: 'u_ab', at: 777 } },
      settings: {},
    });
    const data = await readMarksFile(tmp);
    expect(data.contrib).toEqual({
      a: { u_ab: { mark: 'pick', at: 777 } },
      b: { admin: { mark: 'reject', at: 0 } },
    });
  });

  it('回填之后 marks 求值的结果和原来一模一样', async () => {
    await writeMarksFile(tmp, {
      version: 1, marks: { a: 'pick' }, marksMeta: { a: { by: 'u_ab', at: 777 } }, settings: {},
    });
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({ a: 'pick' });
    expect(data.marksMeta).toEqual({ a: { by: 'u_ab', at: 777 } });
  });

  it('已经有 contrib 的文件不回填，以 contrib 为准', async () => {
    await writeMarksFile(tmp, {
      version: 1,
      marks: { a: 'pick' },
      contrib: { a: { admin: { mark: 'reject', at: 5 } } },
      settings: {},
    });
    const data = await readMarksFile(tmp);
    expect(data.marks.a).toBe('reject');
  });
});

describe('setHidden', () => {
  it('隐藏未标记的照片', async () => {
    const store = await createMarkStore(tmp);
    const res = store.setHidden(['a', 'b'], true);
    expect(res).toEqual({ hidden: ['a', 'b'], skipped: [] });
    expect(store.data.hidden).toEqual(['a', 'b']);
    await store.close();
  });

  it('已标记的被跳过，其余照常隐藏', async () => {
    // 框选五十张里有一张收藏过就整批失败，是比部分执行更差的行为，
    // 而不变量在两种做法下同样成立。
    const store = await createMarkStore(tmp);
    store.setMark('a', 'pick', { by: 'admin', at: 1 });
    const res = store.setHidden(['a', 'b'], true);
    expect(res).toEqual({ hidden: ['b'], skipped: ['a'] });
    expect(store.data.hidden).toEqual(['b']);
    await store.close();
  });

  it('取消隐藏', async () => {
    const store = await createMarkStore(tmp);
    store.setHidden(['a', 'b'], true);
    const res = store.setHidden(['a'], false);
    expect(res).toEqual({ hidden: ['b'], skipped: [] });
    expect(store.data.hidden).toEqual(['b']);
    await store.close();
  });

  it('给一张已隐藏的照片打标记会自动取消它的隐藏', async () => {
    // 否则「已标记 ∧ 已隐藏」这个非法状态会从后门溜进来。
    const store = await createMarkStore(tmp);
    store.setHidden(['a'], true);
    store.setMark('a', 'pick', { by: 'admin', at: 1 });
    expect(store.data.hidden).toEqual([]);
    expect(store.data.marks.a).toBe('pick');
    await store.close();
  });

  it('清除标记不会把照片重新隐藏回去', async () => {
    // 自动取消隐藏是一次性的动作，不是一条要维持的双向绑定。
    const store = await createMarkStore(tmp);
    store.setHidden(['a'], true);
    store.setMark('a', 'pick', { by: 'admin', at: 1 });
    store.setMark('a', null, { by: 'admin', at: 2 });
    expect(store.data.hidden).toEqual([]);
    await store.close();
  });

  it('隐藏状态落盘并读得回来', async () => {
    const store = await createMarkStore(tmp);
    store.setHidden(['a', 'b'], true);
    await store.close();
    const data = await readMarksFile(tmp);
    expect(data.hidden).toEqual(['a', 'b']);
  });
});
