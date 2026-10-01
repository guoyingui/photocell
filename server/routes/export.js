import express from 'express';
import crypto from 'node:crypto';
import { assertWithin, isWithin, realpathDeep } from '../lib/safepath.js';
import { browseRoots } from '../lib/session.js';
import { requireSession } from './library.js';
import { auditTargets } from './marks.js';
import { logShareEvent } from './share.js';
import { requireAdmin } from '../middleware/auth.js';
import { runExport, TransferError } from '../lib/transfer.js';
import { resolveExportScope } from '../../shared/exportScope.js';

export const exportRouter = express.Router();

const jobs = new Map();   // jobId -> { events, listeners, finished, controller, summary, error, mode }

let JOB_TTL_MS = 10 * 60 * 1000;

function createJob(mode = 'copy') {
  const job = {
    id: crypto.randomUUID(),
    mode,
    events: [],
    listeners: new Set(),
    finished: false,
    controller: new AbortController(),
    summary: null,
    error: null,
  };
  jobs.set(job.id, job);
  return job;
}

/**
 * 有没有正在跑的 move 任务。move 会在校验通过后删掉源 RAW，这个过程中换文件夹
 * （/api/library/open、/api/library/close）必须被拒绝：界面回到选择器之后，后台
 * 还在一个一个删掉摄影师的原片，而他连取消按钮都找不到了。
 */
export function hasRunningMoveJob() {
  for (const job of jobs.values()) {
    if (job.mode === 'move' && !job.finished) return true;
  }
  return false;
}

/**
 * 清理定时器只从"任务已经结束"那一刻起算——不管是正常完成、出错，还是被取消后
 * 跑完了收尾（取消只是 abort 信号，runExport 仍然会正常 resolve，一样走 finishJob）。
 * 之前写成在 createJob() 里、任务一创建就调度，会导致一个耗时超过 TTL 的导出
 * （几千张 RAW、外置硬盘、网络盘都很容易超过 10 分钟）在还没跑完的时候就从注册表
 * 里消失：/stream 和 /cancel 都会 404，进度更新戛然而止，summary（连同 Task 8
 * 那次修复才补上的 skippedAssets/renamedAssets）再也拿不到——move 模式下更严重，
 * 正在删源文件的任务再也无法被取消。
 */
function scheduleCleanup(job) {
  setTimeout(() => jobs.delete(job.id), JOB_TTL_MS).unref?.();
}

/** 任务收尾统一入口：标记完成、推送终态事件、安排清理定时器。 */
function finishJob(job, event) {
  job.finished = true;
  push(job, event);
  scheduleCleanup(job);
}

function push(job, event) {
  job.events.push(event);
  for (const fn of job.listeners) {
    try { fn(event); } catch { /* 订阅者已断开 */ }
  }
}

/**
 * 数一遍这次会动多少个文件 —— move 模式的确认闸门要跟它比对。
 * assets/marks 必须是调用方已经在同一个时间点固定下来的快照，不能是会在
 * await 间隙被并发 PUT /api/library/marks 修改的活引用，否则这里数出来的
 * total 和真正搬文件时用的集合可能对不上。
 */
function countJobs(assets, marks, { includeJpg }) {
  let n = 0;
  for (const asset of assets) {
    if (marks[asset.id] !== 'pick') continue;
    n += asset.raws.length;
    if (includeJpg && asset.jpg) n += 1;
  }
  return n;
}

/** 这次会动到多少**张照片**（`countJobs` 数的是文件，一张照片可能有两个 RAW）。 */
function countAssets(assets, marks) {
  let n = 0;
  for (const asset of assets) if (marks[asset.id] === 'pick') n++;
  return n;
}

/**
 * 留痕：`export.run`（规格 §3.4 的动作表里一直有它，此前没有代码产生它）。
 *
 * 为什么这一条非补不可：导出是整个程序里**最不可逆**的操作——`mode:'move'`
 * 在校验通过后会删掉源 RAW，而 RAW 是不可再生的。在补上这段之前，这条链路
 * 对 logShareEvent / logEvent 是零引用：跑一次完整导出，日志里只有 `mark.set`
 * 和 `user.join`，摄影师事后没有任何办法从审计日志看出"那批原片是什么时候、
 * 被移动到哪里去的"。而"对每个账户的操作进行记录留存"是产品需求本身。
 *
 * 三条口径：
 *
 * - **记在响应发出之前**（`await`，不是 fire-and-forget）。与 share.js 的
 *   denyLink 同一条理由：客户端被告知"任务已开始"的那一刻，这件事必须已经
 *   落盘了，否则"最不可逆的操作有留痕"这条保证带着一个丢事件的窗口。
 * - **记的是"这次导出被接受了"，不是"它跑完了"。** 载荷里的 counts 因此是
 *   **计划**要动的数量，不是实际完成的数量——一个跑到一半失败/被取消的任务
 *   同样会留下这一行。这是有意的：任务开始那一刻才是那个可审计的决定，
 *   而正在删 RAW 的进程如果崩了，恰恰是最需要日志里有这一行的时候。
 * - **走 auditTargets**，不自己数分享。导出是 admin-only，所以它落到的是
 *   "该会话 root 下每一条活跃分享各记一条"那一支；一条分享都没有（本机单机
 *   使用）时不记，因为没有审计对象。
 *
 * `dest` 是摄影师磁盘上的绝对路径。这与 `share.create` 记 `root` 的口径一致：
 * 审计日志只有管理员读得到（`/api/admin/shares/:id/events` 是 admin-only），
 * 而一条不说清楚"移到哪去了"的删除记录，对事后追查毫无用处。
 */
async function recordExportRun(req, { mode, dest, counts }) {
  const event = { actor: 'admin', action: 'export.run', mode, dest, counts };
  for (const share of await auditTargets(req)) {
    await logShareEvent(share, event);
  }
}

exportRouter.post('/', requireAdmin, requireSession, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const mode = body.mode === 'move' ? 'move' : 'copy';
    const includeJpg = body.includeJpg === true;

    // 在任何 await 之前先拍一份 marks 快照：markStore.setMark() 是原地修改
    // data.marks（`data.marks[id] = mark` / `delete data.marks[id]`），如果这里
    // 一直用活引用，那么下面 assertWithin/realpathDeep 的 await 让出事件循环的
    // 间隙里，一次并发的 PUT /api/library/marks 就可能改掉某张照片的 pick 状态，
    // 使得 confirmCount 校验时数出来的 total 和 runExport 真正处理的文件集合对不
    // 上——对 move 模式这是"确认数量"这道最后防线的完整性问题。之后 countJobs
    // 和传给 runExport 的 opts.marks 必须用同一份快照，不能分开取两次。
    // req.session.assets 不需要同样处理：它只在 openSession() 时被整体替换，不会
    // 被任何路由原地修改（marks.js 只碰 markStore，不碰 assets 数组本身）。
    const { assets, marks } = resolveExportScope(
      req.session.assets, req.session.markStore.data, body.scope,
    );

    // jpgSubdir 是唯一一个会被原样 path.join 进目标路径的客户端字符串。destRoot 过了
    // assertWithin，拼接之后的 dest 却没有再校验一次——"../../../../tmp/x" 能直接
    // 逃出已校验的 destRoot，而 move 模式下同一个请求还会顺手删掉源文件。
    // 这里只允许一段普通目录名，不接受任何路径分隔符或 ".."。
    const jpgSubdir = typeof body.jpgSubdir === 'string' ? body.jpgSubdir : '';
    if (/[/\\]|\.\./.test(jpgSubdir)) {
      return res.status(400).json({ error: 'JPG 子目录名不能包含路径分隔符或 ".."' });
    }

    const destRoot = await assertWithin(await browseRoots(), String(body.destRoot ?? ''));
    const total = countJobs(assets, marks, { includeJpg });

    // 导出目标不能落在源文件夹内部：runExport()（transfer.js）内部也会做同一个
    // 检查，那是它作为库函数对任意调用者的自我防御（inner 层），不是这里的冗余，
    // 不要因为“看起来重复”就删掉其中一个。问题在于 runExport 是下面异步触发、
    // 没有被 await 的（res.json 已经先同步发出响应），它抛出的 TransferError 只
    // 会变成一条 SSE error 事件，永远影响不到这次 POST 请求本身的状态码。这里
    // 必须在响应发出之前，同步把同样的检查再做一遍（outer 层），"目标不能在源
    // 文件夹内部"这条规则才能对 HTTP 响应生效。用 realpathDeep 而不是直接比较
    // 字符串，是因为 destRoot 可能是指向源文件夹内部的软链接——纯字符串比较会
    // 放过它，Task 8 就是在 runExport 内部踩过这个坑。
    const [realRoot, realDest] = await Promise.all([
      realpathDeep(req.session.root),
      realpathDeep(destRoot),
    ]);
    if (isWithin(realRoot, realDest)) {
      throw new TransferError('导出目标不能是源文件夹本身或其子目录');
    }

    if (mode === 'move') {
      if (!Number.isInteger(body.confirmCount)) {
        return res.status(400).json({ error: '移动模式必须输入确认数量' });
      }
      if (body.confirmCount !== total) {
        return res.status(400).json({ error: `确认数量不符：应为 ${total}，收到 ${body.confirmCount}` });
      }
    }

    // 留痕排在 createJob 与响应之前：走到这里全部闸门都已经过了，这次导出
    // 一定会开始。记完再回应，客户端拿到 jobId 的那一刻日志已经落盘。
    await recordExportRun(req, {
      mode,
      dest: destRoot,
      counts: { assets: countAssets(assets, marks), files: total },
    });

    const job = createJob(mode);
    res.json({ jobId: job.id, total });

    const opts = {
      root: req.session.root,
      destRoot,
      assets,
      marks,   // 上面拍的快照，不是活引用
      metas: req.session.metas,
      includeJpg,
      jpgSubdir,
      flatten: body.flatten === true,
      manifest: body.manifest !== false,
      mode,
    };

    runExport(opts, {
      signal: job.controller.signal,
      onProgress: (p) => push(job, { type: 'progress', ...p }),
    }).then((summary) => {
      job.summary = summary;
      finishJob(job, { type: 'done', summary });
    }).catch((err) => {
      job.error = err.message;
      finishJob(job, { type: 'error', message: err.message });
    });
  } catch (err) { next(err); }
});

exportRouter.get('/:jobId/stream', requireAdmin, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: '未知导出任务' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Node 默认要等到第一次 res.write() 才会真的把响应头刷到 socket 上。如果订阅时
  // job.events 还是空的、job 也还没 finished（比如刚创建、第一条 progress 还没
  // 产生），下面就完全不会调用 write()，客户端会一直卡在等响应头，直到 25 秒后
  // 的 ping 才有第一批字节——这里显式刷一下头，让连接本身立刻可用。
  res.flushHeaders();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  for (const event of job.events) send(event);   // 补发已发生的事件，订阅者不会漏
  if (job.finished) return res.end();

  job.listeners.add(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); job.listeners.delete(send); });
});

exportRouter.post('/:jobId/cancel', requireAdmin, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: '未知导出任务' });
  job.controller.abort();
  res.json({ ok: true });
});

/**
 * 仅供测试使用：验证「清理定时器只从任务结束时起算」（F1）需要在不真的等 10 分钟、
 * 也不需要真的跑一个足够慢的导出来制造竞态的前提下，直接摆弄任务注册表本身的生命
 * 周期——jobs 是同一个 Map 实例，createJob/finishJob 是同一套逻辑，真实的 HTTP
 * 路由（/stream、/cancel）看到的是完全一致的状态。生产代码从不读写这个导出。
 */
export const _test = {
  jobs,
  createJob,
  finishJob,
  setTtlMs(ms) { JOB_TTL_MS = ms; },
  getTtlMs() { return JOB_TTL_MS; },
};
