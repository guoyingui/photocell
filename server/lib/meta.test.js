import { describe, it, expect, vi, beforeEach } from 'vitest';
import exifr from 'exifr';
import { normalizeMeta, readAllMeta } from './meta.js';

// readAllMeta 以前零覆盖（分诊项 e），而它正好管着并发上限、乱序完成时的落位、
// 单文件失败的降级和批次回调——三个任务依赖它，真实机身的 EXIF 又恰恰是意外
// 最多的地方。把 exifr.parse 换成可编程的假实现，这几条语义才测得动。
vi.mock('exifr', () => {
  const parse = vi.fn();
  class Exifr {
    constructor(options) { this.options = options; }
    async read(abs) { this.abs = abs; }
    async parse() { return parse(this.abs, this.options); }
  }
  return { default: { parse, Exifr } };
});

const asset = (id, { jpg = `${id}.JPG`, dir = '', jpgMtimeMs = 1000, rawMtimeMs = 0 } = {}) =>
  ({ id, dir, stem: id, raws: [`${id}.CR3`], jpg, jpgSize: 10, jpgMtimeMs, rawMtimeMs });

describe('normalizeMeta', () => {
  it('优先用 DateTimeOriginal', () => {
    const m = normalizeMeta(
      { DateTimeOriginal: new Date('2026-07-26T10:00:00Z'), Model: 'R5', BodySerialNumber: 'SN1' },
      999, 'cam-a');
    expect(m.time).toBe(Date.parse('2026-07-26T10:00:00Z'));
    expect(m.timeSource).toBe('exif');
  });

  it('用 SubSecTimeOriginal 补足毫秒', () => {
    const m = normalizeMeta(
      { DateTimeOriginal: new Date('2026-07-26T10:00:00Z'), SubSecTimeOriginal: '25' }, 0, '');
    expect(m.time).toBe(Date.parse('2026-07-26T10:00:00Z') + 250);
  });

  it('SubSecTimeOriginal 是数字时也能处理', () => {
    const m = normalizeMeta(
      { DateTimeOriginal: new Date('2026-07-26T10:00:00Z'), SubSecTimeOriginal: 7 }, 0, '');
    expect(m.time).toBe(Date.parse('2026-07-26T10:00:00Z') + 700);
  });

  it('无 DateTimeOriginal 时退到 CreateDate', () => {
    const m = normalizeMeta({ CreateDate: new Date('2026-01-01T00:00:00Z') }, 999, '');
    expect(m.time).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(m.timeSource).toBe('createDate');
  });

  it('都没有时退到文件 mtime', () => {
    const m = normalizeMeta(null, 12345, '');
    expect(m.time).toBe(12345);
    expect(m.timeSource).toBe('mtime');
  });

  it('body 由 Model 与序列号组成', () => {
    const m = normalizeMeta({ Model: 'ILCE-7RM5', BodySerialNumber: 'ABC' }, 0, 'cam-a');
    expect(m.body).toBe('ILCE-7RM5|ABC');
  });

  it('机身信息缺失时退化为目录名', () => {
    const m = normalizeMeta({}, 0, 'cam-b');
    expect(m.body).toBe('dir:cam-b');
  });

  it('只有 Model 没有序列号时仍用 Model', () => {
    const m = normalizeMeta({ Model: 'X-T5' }, 0, 'cam-b');
    expect(m.body).toBe('X-T5|');
  });

  it('orientation 缺失或非法时归一为 1', () => {
    expect(normalizeMeta({}, 0, '').orientation).toBe(1);
    expect(normalizeMeta({ Orientation: 99 }, 0, '').orientation).toBe(1);
    expect(normalizeMeta({ Orientation: 6 }, 0, '').orientation).toBe(6);
  });

  it('拍摄参数缺失时为 null 而不是 undefined', () => {
    const m = normalizeMeta({}, 0, '');
    expect(m.iso).toBeNull();
    expect(m.fNumber).toBeNull();
    expect(m.exposureTime).toBeNull();
    expect(m.focalLength).toBeNull();
  });

  it('拍摄参数存在时透传', () => {
    const m = normalizeMeta({ ISO: 400, FNumber: 1.4, ExposureTime: 0.004, FocalLength: 85 }, 0, '');
    expect(m).toMatchObject({ iso: 400, fNumber: 1.4, exposureTime: 0.004, focalLength: 85 });
  });

  it('无效日期不会产出 NaN 时间', () => {
    const m = normalizeMeta({ DateTimeOriginal: new Date('invalid') }, 777, '');
    expect(m.time).toBe(777);
    expect(m.timeSource).toBe('mtime');
  });
});

describe('readAllMeta', () => {
  beforeEach(() => { exifr.parse.mockReset(); });

  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  it('每个资产都产出一条结果，id 与顺序都对得上', async () => {
    exifr.parse.mockResolvedValue({ DateTimeOriginal: new Date('2026-07-26T10:00:00Z') });
    const assets = [asset('A'), asset('B'), asset('C')];
    const out = await readAllMeta('/root', assets);
    expect(out.map((m) => m.id)).toEqual(['A', 'B', 'C']);
  });

  it('并发上限真的生效：同一时刻在飞的读取不超过 concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    exifr.parse.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return {};
    });
    const assets = Array.from({ length: 12 }, (_, i) => asset(`A${i}`));
    await readAllMeta('/root', assets, { concurrency: 3 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);   // 确实是并发跑的，不是被串行化了
    expect(exifr.parse).toHaveBeenCalledTimes(12);
  });

  it('乱序完成时结果仍然按原索引落位，而不是按完成先后', async () => {
    // 第一个故意最慢：如果实现用的是 push 而不是 out[i]，结果顺序就会变成 B、C、A。
    const slow = deferred();
    const fastFinished = deferred();
    let fastCount = 0;
    exifr.parse.mockImplementation(async (abs) => {
      if (String(abs).endsWith('/A.JPG')) return slow.promise;
      if (++fastCount === 2) fastFinished.resolve();
      return { Model: 'fast' };
    });

    const assets = [asset('A'), asset('B'), asset('C')];
    const pending = readAllMeta('/root', assets, { concurrency: 3 });
    await fastFinished.promise;   // 按文件指定慢读取，不依赖异步路径校验的完成顺序
    slow.resolve({ Model: 'slow' });

    const out = await pending;
    expect(out.map((m) => m.id)).toEqual(['A', 'B', 'C']);
    expect(out[0].body).toContain('slow');
    expect(out[1].body).toContain('fast');
  });

  it('单个文件读取失败时降级为 mtime，且不影响其它文件', async () => {
    exifr.parse.mockImplementation(async (abs) => {
      if (String(abs).includes('B.JPG')) throw new Error('损坏的 EXIF 段');
      return { DateTimeOriginal: new Date('2026-07-26T10:00:00Z') };
    });
    const assets = [asset('A'), asset('B', { jpgMtimeMs: 4242 }), asset('C')];
    const out = await readAllMeta('/root', assets);

    expect(out[1]).toMatchObject({ id: 'B', time: 4242, timeSource: 'mtime' });
    expect(out[0].timeSource).toBe('exif');
    expect(out[2].timeSource).toBe('exif');
  });

  it('没有 JPG 的资产尝试 RAW 元数据，没有 EXIF 时降级到 RAW 时间', async () => {
    exifr.parse.mockResolvedValue({});
    const out = await readAllMeta('/root', [asset('ORPHAN', { jpg: null, rawMtimeMs: 777 })]);
    expect(exifr.parse).toHaveBeenCalledWith('/root/ORPHAN.CR3', expect.any(Object));
    expect(out[0].timeSource).toBe('mtime');
  });

  // I11：孤儿 RAW 的兜底时间必须来自 RAW 自己的 mtime。以前这里恒取 jpgMtimeMs
  // （孤儿 RAW 上恒为 0），于是它们的 time 全是 0，在按时间排序的网格里堆到最前面，
  // 日期一律显示 1970。
  it('I11: 孤儿 RAW 用 RAW 的 mtime 兜底，不再是 1970', async () => {
    const out = await readAllMeta('/root', [
      asset('ORPHAN', { jpg: null, jpgMtimeMs: 0, rawMtimeMs: 1700000000000 }),
    ]);
    expect(out[0].time).toBe(1700000000000);
    expect(out[0].time).not.toBe(0);
  });

  it('I11: 有 JPG 时兜底仍然用 JPG 的 mtime', async () => {
    exifr.parse.mockResolvedValue(null);   // 没有可用的 EXIF 时间
    const out = await readAllMeta('/root', [
      asset('WITHJPG', { jpgMtimeMs: 555, rawMtimeMs: 999 }),
    ]);
    expect(out[0].time).toBe(555);
  });

  it('批次回调：每批不超过 200，总数与顺序合起来正好覆盖全部资产', async () => {
    exifr.parse.mockResolvedValue({});
    const assets = Array.from({ length: 450 }, (_, i) => asset(`A${i}`));
    const batches = [];
    const out = await readAllMeta('/root', assets, { onBatch: (b) => batches.push(b) });

    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(200);
    // 满批必须正好是 200——阈值写错（比如 >= 改成 >）会让批次大小漂移。
    expect(batches.slice(0, -1).every((b) => b.length === 200)).toBe(true);
    // 每一条结果都恰好被推送一次，不重不漏。
    const pushed = batches.flat().map((m) => m.id);
    expect(pushed).toHaveLength(assets.length);
    expect(new Set(pushed).size).toBe(assets.length);
    expect(new Set(pushed)).toEqual(new Set(out.map((m) => m.id)));
  });

  it('批次回调：不足一批时也会在末尾补发一次', async () => {
    exifr.parse.mockResolvedValue({});
    const batches = [];
    await readAllMeta('/root', [asset('A'), asset('B')], { onBatch: (b) => batches.push(b) });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it('没有 onBatch 时不抛异常', async () => {
    exifr.parse.mockResolvedValue({});
    await expect(readAllMeta('/root', [asset('A')])).resolves.toHaveLength(1);
  });

  it('空资产表直接返回空数组，不调用回调', async () => {
    const batches = [];
    const out = await readAllMeta('/root', [], { onBatch: (b) => batches.push(b) });
    expect(out).toEqual([]);
    expect(batches).toEqual([]);
  });
});
