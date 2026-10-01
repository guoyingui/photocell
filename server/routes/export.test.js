import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../index.js';
import { closeAllSessions } from '../lib/session.js';
import { createShare, revokeShare } from '../lib/shares.js';
import { readEvents } from '../lib/audit.js';
import { _test } from './export.js';

let server, base, tmp, out;

/**
 * PHOTOCULL_HOME：分享与审计日志的落点。
 *
 * 以前这个文件不需要它——导出链路一个字都不往日志里写。补上 `export.run`
 * 之后它会读分享表、会写 events.jsonl，没有这层隔离就会去碰开发者真实的
 * `~/.photocull`。
 */
let home;
let savedHome;

/** 当前会话 id：会话有身份之后，每个请求都必须带上它。 */
let sid = '';
const api = (p, init = {}) => fetch(base + p, {
  ...init,
  headers: { ...(init.headers ?? {}), ...(sid ? { 'X-PhotoCull-Session': sid } : {}) },
});
const post = (p, body) => api(p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
});
const openLib = async () => {
  const data = await (await post('/api/library/open', { root: tmp })).json();
  if (data.sessionId) sid = data.sessionId;
  return data;
};
const closeAll = async () => { await closeAllSessions(); sid = ''; };

async function waitDone(jobId) {
  const res = await api(`/api/export/${jobId}/stream`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (const line of buf.split('\n\n')) {
      if (!line.startsWith('data: ')) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === 'done') { reader.cancel(); return event.summary; }
      if (event.type === 'error') { reader.cancel(); throw new Error(event.message); }
    }
  }
  throw new Error('SSE 在 done 之前结束');
}

beforeAll(async () => {
  savedHome = process.env.PHOTOCULL_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'exp-home-'));
  process.env.PHOTOCULL_HOME = home;

  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'exp-src-')));
  out = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'exp-out-')));
  await fs.mkdir(path.join(tmp, 'cam-a'), { recursive: true });
  for (const [dir, stem] of [['', 'A'], ['cam-a', 'B']]) {
    await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 5, g: 5, b: 5 } } })
      .jpeg().toFile(path.join(tmp, dir, `${stem}.JPG`));
    await fs.writeFile(path.join(tmp, dir, `${stem}.CR3`), `raw-${stem}`);
  }

  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  await openLib();
  await api('/api/library/marks', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ marks: { A: 'pick', 'cam-a/B': 'pick' } }),
  });
});

afterAll(async () => {
  await closeAll();
  await new Promise((r) => server.close(r));
  if (savedHome === undefined) delete process.env.PHOTOCULL_HOME;
  else process.env.PHOTOCULL_HOME = savedHome;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(out, { recursive: true, force: true });
});

describe('POST /api/export', () => {
  it('复制模式导出收藏的 RAW', async () => {
    const { jobId, total } = await (await post('/api/export', { destRoot: out, mode: 'copy' })).json();
    expect(total).toBe(2);
    const summary = await waitDone(jobId);
    expect(summary.exported).toBe(2);
    expect(await fs.readFile(path.join(out, 'A.CR3'), 'utf8')).toBe('raw-A');
    expect(await fs.readFile(path.join(out, 'cam-a', 'B.CR3'), 'utf8')).toBe('raw-B');
  });

  it('重复导出到同一目录全部跳过', async () => {
    const { jobId } = await (await post('/api/export', { destRoot: out, mode: 'copy' })).json();
    const summary = await waitDone(jobId);
    expect(summary.skipped).toBe(2);
    expect(summary.exported).toBe(0);
  });

  it('move 模式缺少 confirmCount 时拒绝', async () => {
    const res = await post('/api/export', { destRoot: out, mode: 'move' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('确认');
  });

  it('move 模式 confirmCount 不匹配时拒绝', async () => {
    const res = await post('/api/export', { destRoot: out, mode: 'move', confirmCount: 99 });
    expect(res.status).toBe(400);
  });

  it('拒绝导出到源文件夹内部', async () => {
    const res = await post('/api/export', { destRoot: path.join(tmp, 'inside'), mode: 'copy' });
    expect(res.status).toBe(400);
  });

  it('拒绝通过软链接指向源文件夹内部的导出目标', async () => {
    // 软链接本身放在一个和源文件夹无关的临时目录里，字符串层面看不出指向源文件
    // 夹；只有解析出真实路径才能发现它其实落在 tmp 内部。
    const linkParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'exp-link-')));
    const link = path.join(linkParent, 'sneaky');
    await fs.symlink(path.join(tmp, 'cam-a'), link, 'dir');
    try {
      const res = await post('/api/export', { destRoot: link, mode: 'copy' });
      expect(res.status).toBe(400);
    } finally {
      await fs.rm(linkParent, { recursive: true, force: true });
    }
  });

  it('拒绝越界的导出目标', async () => {
    const res = await post('/api/export', { destRoot: '/etc/photocull-out', mode: 'copy' });
    expect(res.status).toBe(403);
  });

  // I13：jpgSubdir 是唯一一个会被原样 path.join 进目标路径的客户端字符串。destRoot
  // 过了 assertWithin，拼接之后的 dest 却没人再校验——它能直接逃出已校验的 destRoot，
  // 而 move 模式下同一个请求还会顺手删掉源文件。
  it('I13: jpgSubdir 含路径分隔符或 .. 时返回 400，任务根本不会被创建', async () => {
    for (const bad of ['../../../../tmp/photocull-escape', '..', 'a/b', 'a\\b']) {
      const res = await post('/api/export',
        { destRoot: out, mode: 'copy', includeJpg: true, jpgSubdir: bad });
      expect(res.status, `jpgSubdir=${bad}`).toBe(400);
      expect(await res.json()).not.toHaveProperty('jobId');
    }
  });

  it('I13: 正常的一段子目录名仍然放行', async () => {
    const out3 = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'exp-sub-')));
    try {
      const res = await post('/api/export',
        { destRoot: out3, mode: 'copy', includeJpg: true, jpgSubdir: 'JPG' });
      expect(res.status).toBe(200);
      await waitDone((await res.json()).jobId);
      await fs.access(path.join(out3, 'JPG', 'A.JPG'));
    } finally {
      await fs.rm(out3, { recursive: true, force: true });
    }
  });

  it('未打开库时返回 409', async () => {
    await closeAll();
    expect((await post('/api/export', { destRoot: out, mode: 'copy' })).status).toBe(409);
    await openLib();
    await api('/api/library/marks', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marks: { A: 'pick', 'cam-a/B': 'pick' } }),
    });
  });
});

describe('导出 SSE 与取消', () => {
  it('未知 jobId 的 stream 返回 404', async () => {
    expect((await api('/api/export/nope/stream')).status).toBe(404);
  });

  it('cancel 未知 jobId 返回 404', async () => {
    expect((await post('/api/export/nope/cancel')).status).toBe(404);
  });

  it('导出完成后 summary 里带 destRoot', async () => {
    const out2 = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'exp-out2-')));
    const { jobId } = await (await post('/api/export', { destRoot: out2, mode: 'copy', manifest: true })).json();
    const summary = await waitDone(jobId);
    expect(summary.destRoot).toBe(out2);
    expect(await fs.readFile(path.join(out2, 'manifest.csv'), 'utf8')).toContain('assetId');
    await fs.rm(out2, { recursive: true, force: true });
  });
});

// 分诊项 b（服务端半边）：move 会在校验通过后删掉源 RAW。这个过程中换文件夹，
// 界面会回到选择器，而后台还在一个一个删掉摄影师的原片，他连取消按钮都找不到了。
describe('move 任务在跑时拒绝换文件夹（分诊项 b）', () => {
  it('有未结束的 move 任务时，close 和 open 都返回 409', async () => {
    const job = _test.createJob('move');
    try {
      const closeRes = await post('/api/library/close');
      expect(closeRes.status).toBe(409);
      const closeBody = await closeRes.json();
      expect(closeBody.code).toBe('move-in-progress');
      expect(closeBody.error).toContain('移动');

      const openRes = await post('/api/library/open', { root: tmp });
      expect(openRes.status).toBe(409);
      expect((await openRes.json()).code).toBe('move-in-progress');

      // 会话必须还活着——被拒绝的是"换文件夹"，不是整个库。
      expect((await api('/api/library/assets')).status).toBe(200);
    } finally {
      _test.jobs.delete(job.id);
    }
  });

  it('copy 任务不拦：只有会删源文件的 move 才需要这道闸', async () => {
    const job = _test.createJob('copy');
    try {
      expect((await post('/api/library/open', { root: tmp })).status).toBe(200);
    } finally {
      _test.jobs.delete(job.id);
    }
  });

  it('move 任务结束之后不再拦', async () => {
    const job = _test.createJob('move');
    try {
      _test.finishJob(job, { type: 'done', summary: {} });
      expect((await post('/api/library/open', { root: tmp })).status).toBe(200);
    } finally {
      _test.jobs.delete(job.id);
    }
  });
});

describe('导出任务的清理定时器（F1：TTL 必须从任务结束时起算，不能从创建时起算）', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  it('仍在运行的任务超过 TTL 窗口后依然可达', async () => {
    const prevTtl = _test.getTtlMs();
    _test.setTtlMs(10);   // 极短 TTL，模拟"任务还在跑，但从创建时刻起算的 10 分钟早就过了"
    const job = _test.createJob();   // 不调用 finishJob —— 代表"仍在运行"
    try {
      await sleep(100);   // 明显超过上面设的 TTL

      // 旧写法（setTimeout 安排在 createJob 里）会在这里已经把任务删掉；
      // 修复后，清理只在 finishJob 时才安排，所以任务必须还在注册表里。
      expect(_test.jobs.has(job.id)).toBe(true);

      const streamRes = await api(`/api/export/${job.id}/stream`);
      expect(streamRes.status).toBe(200);
      await streamRes.body.cancel();   // 手动断开，不然这条 SSE 连接会一直挂着

      const cancelRes = await post(`/api/export/${job.id}/cancel`);
      expect(cancelRes.status).toBe(200);
      expect((await cancelRes.json()).ok).toBe(true);
    } finally {
      _test.setTtlMs(prevTtl);
      _test.jobs.delete(job.id);   // 这个任务从没真正 finish 过，手动清掉避免污染后续用例
    }
  });

  it('已完成的任务在 TTL 之后会被清理，不会无限堆积', async () => {
    const prevTtl = _test.getTtlMs();
    _test.setTtlMs(10);
    const job = _test.createJob();
    try {
      _test.finishJob(job, { type: 'done', summary: {} });   // 模拟任务正常结束
      expect(_test.jobs.has(job.id)).toBe(true);   // 刚结束，还没到 TTL

      await sleep(100);   // 明显超过上面设的 TTL
      expect(_test.jobs.has(job.id)).toBe(false);   // 超过 TTL 后被清理
    } finally {
      _test.setTtlMs(prevTtl);
      _test.jobs.delete(job.id);   // 万一断言提前失败导致没被清理，兜底一下
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 审计：export.run（规格 §3.4）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 导出是整个程序里**最不可逆**的操作：`mode:'move'` 在校验通过后删掉源 RAW，
 * 而 RAW 不可再生。在补上这一段之前，整条导出链路对 logShareEvent / logEvent
 * 是零引用——跑一次完整导出，日志里只有 mark.set 和 user.join。
 *
 * 这一组用真实的分享记录 + 真实的 events.jsonl，不打桩：留痕这件事的价值
 * 全部在"事后真的读得到"，桩证明不了这一点。
 */
describe('export.run 审计', () => {
  const runsOf = (events) => events.filter((e) => e.action === 'export.run');

  /** 每条用例一个干净的分享，避免上一条用例写下的记录混进来。 */
  async function shareOn(root, label) {
    const share = await createShare({ root, label });
    return share;
  }

  it('复制模式：留下一条 export.run，载荷是 mode / dest / counts', async () => {
    const share = await shareOn(tmp, '导出留痕');
    const dest = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'exp-audit-')));
    try {
      const res = await post('/api/export', { destRoot: dest, mode: 'copy', manifest: false });
      expect(res.status).toBe(200);
      await waitDone((await res.json()).jobId);

      const runs = runsOf(await readEvents(share.id));
      expect(runs).toHaveLength(1);
      expect(runs[0].actor).toBe('admin');
      expect(runs[0].mode).toBe('copy');
      expect(runs[0].dest).toBe(dest);
      // 两张照片，每张一个 RAW；includeJpg 没开，所以文件数也是 2。
      expect(runs[0].counts).toEqual({ assets: 2, files: 2 });
      expect(typeof runs[0].ts).toBe('number');
    } finally {
      await revokeShare(share.id);
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  /**
   * move 是这条记录真正的理由：它会删掉源文件。`mode` 必须如实记下来——
   * 一条分不清 copy 和 move 的导出记录，在事后追查"我的 RAW 去哪了"时
   * 等于没有。
   */
  it('移动模式：mode 记成 move', async () => {
    const share = await shareOn(tmp, 'move 留痕');
    const src = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'exp-mv-src-')));
    const dest = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'exp-mv-out-')));
    try {
      await fs.writeFile(path.join(src, 'M.CR3'), 'raw-M');
      const opened = await (await post('/api/library/open', { root: src })).json();
      sid = opened.sessionId;
      await api('/api/library/marks', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ marks: { M: 'pick' } }),
      });

      const moveShare = await shareOn(src, 'move 的那条分享');
      const res = await post('/api/export', {
        destRoot: dest, mode: 'move', confirmCount: 1, manifest: false,
      });
      expect(res.status).toBe(200);
      await waitDone((await res.json()).jobId);

      const runs = runsOf(await readEvents(moveShare.id));
      expect(runs).toHaveLength(1);
      expect(runs[0].mode).toBe('move');
      expect(runs[0].dest).toBe(dest);
      expect(runs[0].counts).toEqual({ assets: 1, files: 1 });
      // 源文件真的被删了——这正是这条记录存在的理由。
      await expect(fs.access(path.join(src, 'M.CR3'))).rejects.toThrow();

      // 那条分享指向的是 src，不是 tmp：这次导出不该记进别的库的日志里。
      expect(runsOf(await readEvents(share.id))).toEqual([]);
    } finally {
      await revokeShare(share.id);
      await closeAll();
      await openLib();   // 把后续用例依赖的 tmp 会话恢复回来
      await fs.rm(src, { recursive: true, force: true });
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  /**
   * 被闸门拦下的请求**不留痕**：留痕的语义是"这次导出被接受了"，
   * 给一次根本没发生的操作记一行，是审计日志里最容易误导人的一种噪音。
   */
  it('confirmCount 对不上被拒时不留痕', async () => {
    const share = await shareOn(tmp, '被拒的导出');
    const dest = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'exp-deny-')));
    try {
      const res = await post('/api/export', {
        destRoot: dest, mode: 'move', confirmCount: 99, manifest: false,
      });
      expect(res.status).toBe(400);
      expect(runsOf(await readEvents(share.id))).toEqual([]);
    } finally {
      await revokeShare(share.id);
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  /**
   * 已撤销的分享不记（口径与 marks.js 的 auditTargets 完全一致：
   * 它已经没有参与者，记进去只是噪声）。
   */
  it('已撤销的分享不记', async () => {
    const share = await shareOn(tmp, '马上就被撤销');
    const dest = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'exp-revoked-')));
    try {
      await revokeShare(share.id);
      const res = await post('/api/export', { destRoot: dest, mode: 'copy', manifest: false });
      expect(res.status).toBe(200);
      await waitDone((await res.json()).jobId);
      expect(runsOf(await readEvents(share.id))).toEqual([]);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });
});
