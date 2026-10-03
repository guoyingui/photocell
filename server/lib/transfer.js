import fs from 'node:fs/promises';
import path from 'node:path';
import { assertWithin, isWithin, realpathDeep } from './safepath.js';
import { csvRow } from './csv.js';

export class TransferError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransferError';
    this.status = 400;
  }
}

const MTIME_TOLERANCE_MS = 2000;   // FAT32 的 mtime 精度是 2 秒

export async function planTarget(destPath, srcStat) {
  let st;
  try {
    st = await fs.stat(destPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { action: 'write', finalPath: destPath };
    throw err;
  }
  if (st.size === srcStat.size && Math.abs(st.mtimeMs - srcStat.mtimeMs) < MTIME_TOLERANCE_MS) {
    return { action: 'skip', finalPath: destPath };
  }
  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const stem = path.basename(destPath, ext);
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, `${stem}_${i}${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return { action: 'rename', finalPath: candidate };
    }
  }
  throw new TransferError(`${destPath} 的重名后缀已用尽`);
}

export async function copyVerified(src, dest) {
  const srcStat = await fs.stat(src);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.copyFile(src, dest);
  } catch (err) {
    // fs.copyFile 中途失败（ENOSPC、I/O 错误、权限被收回……）也可能已经往
    // dest 写入了半截字节。不清理的话，这半截残片会留在交付目录里，下次
    // 重试还会因为大小不符被 planTarget 判成"改名"，真正的文件永远进不去
    // 这个文件名，残片却一直冒充占着位置。
    await fs.rm(dest, { force: true });
    throw err;
  }

  const destStat = await fs.stat(dest);
  if (destStat.size !== srcStat.size) {
    await fs.rm(dest, { force: true });   // 不留半成品
    throw new TransferError(`复制校验失败：${src} 大小 ${srcStat.size} → ${destStat.size}`);
  }
  await fs.utimes(dest, srcStat.atime, srcStat.mtime);
}

/**
 * 复制已经校验通过、只有删源那一步失败。
 *
 * 这跟"复制失败"是完全不同的结局：文件已经正确送达交付目录，只是源文件还在。
 * 旧实现让它跟普通失败走同一条 catch，于是它既被记成 error、又完全不进 manifest——
 * 摄影师对着 CSV 会以为这张根本没交付。单独立一个类型，好让上层如实记账。
 */
export class MoveDeleteError extends Error {
  constructor(src, dest, cause) {
    super(`已送达 ${dest}，但删除源文件 ${src} 失败：${cause.message}`);
    this.name = 'MoveDeleteError';
    this.deliveredPath = dest;
    this.cause = cause;
  }
}

/** 严格顺序：复制 → 校验 → 删源。校验通过前源文件绝不被碰。 */
export async function moveVerified(src, dest) {
  await copyVerified(src, dest);
  try {
    await fs.rm(src);
  } catch (err) {
    throw new MoveDeleteError(src, dest, err);
  }
}

const joinRel = (root, dir, name) => path.join(root, ...String(dir).split('/').filter(Boolean), name);

export const transferKey = (file) => JSON.stringify([file.id ?? file.asset.id, file.kind, file.name]);
export function transferJobs(assets, marks, { includeJpg = false, onlyFiles } = {}) {
  const jobs = [];
  const allowed = onlyFiles ? new Set(onlyFiles) : null;
  for (const asset of assets) {
    if (marks[asset.id] !== 'pick') continue;
    for (const name of asset.raws) jobs.push({ asset, name, kind: 'raw' });
    if (includeJpg && asset.jpg) jobs.push({ asset, name: asset.jpg, kind: 'jpg' });
  }
  return allowed ? jobs.filter((job) => allowed.has(transferKey(job))) : jobs;
}

export const MANIFEST_HEADER =
  ['assetId', 'mark', 'rawFile', 'jpgFile', 'captureTime', 'exportedAs', 'status', 'note'];

/**
 * 记录文件（manifest.csv / rejected.txt）绝不覆盖已经存在的同名文件。
 *
 * 照片一张都不会被覆盖，工具自己的审计文件却是裸 fs.writeFile 无条件覆盖：第二次
 * 导出进同一个交付目录（补几张、或者换第二张卡），第一份 manifest 就没了，而它记的
 * 恰恰是上一次到底交付了什么。
 *
 * 这里复用 planTarget 的"撞名就加 _1/_2 后缀"逻辑，但故意让它永远走不到 skip 分支：
 * skip 的语义是"目标已经是同一份内容，不用重复写"，对审计文件不成立——同名文件是
 * 上一次导出的记录，必须原样留着，这一次的记录另起一个名字。传一个不可能跟任何真实
 * 文件匹配的 size（-1）就够了，planTarget 的 skip 条件因此恒为假。
 */
async function writeRecordFile(destRoot, name, content) {
  const plan = await planTarget(path.join(destRoot, name), { size: -1, mtimeMs: NaN });
  await fs.writeFile(plan.finalPath, content, 'utf8');
  return plan.finalPath;
}

export async function runExport(opts, hooks = {}) {
  const {
    root, destRoot, assets, marks,
    includeJpg = false, jpgSubdir = '', flatten = false,
    mode = 'copy', manifest = false, metas = new Map(),
  } = opts;
  const { onProgress, onFile, signal } = hooks;

  // isWithin 本身只做字符串层面的 path.resolve/path.relative 比较，不解析
  // 符号链接：如果 destRoot 是指向 root 内部某处的软链接，字符串比较会判定
  // "不在里面"而放行，实际写入却落进了正在被扫描的源目录——move 模式下甚至
  // 可能删掉自己刚读过的源文件。这里必须先把两边都解析成真实路径再比较；
  // realpathDeep 支持 destRoot 尚不存在的情况（导出时才新建目录）。
  const [realRoot, realDestRoot] = await Promise.all([realpathDeep(root), realpathDeep(destRoot)]);
  if (isWithin(realRoot, realDestRoot)) {
    throw new TransferError('导出目标不能是源文件夹本身或其子目录');
  }

  // jpgSubdir 会被原样 path.join 进目标路径。destRoot 过了 assertWithin，拼接之后的
  // dest 没人再校验——"../../../../tmp/x" 能直接逃出已校验的 destRoot，move 模式下
  // 同一个请求还会顺手删掉源文件。路由层（export.js）已经挡了一道，这里是这个库函数
  // 对任意调用者的自我防御，跟上面 destRoot 那道双重检查是同一个理由，不是冗余。
  if (/[/\\]|\.\./.test(jpgSubdir)) {
    throw new TransferError('JPG 子目录名不能包含路径分隔符或 ".."');
  }

  const picked = assets.filter((a) => marks[a.id] === 'pick');
  const rejected = assets.filter((a) => marks[a.id] === 'reject').map((a) => a.id);

  const manifestRows = [];
  const captureTime = (asset) => {
    const t = metas.get(asset.id)?.time;
    return t ? new Date(t).toISOString() : '';
  };
  /**
   * manifest 必须为**每一个收藏资产**出行：README 承诺"每行对应一个已收藏资产的
   * RAW 文件"，摄影师会拿它跟自己的收藏数对账。旧实现只在 try 成功的分支里 push，
   * 于是拷贝失败的、以及压根没有 RAW 的收藏项在 CSV 里干脆消失——3 个收藏只看到
   * 2 行，而且无从知道少的是哪一个、为什么少。status 列本来就是为这个存在的。
   */
  const row = (asset, rawFile, exportedAs, status, note = '') =>
    manifestRows.push([asset.id, 'pick', rawFile, asset.jpg ?? '', captureTime(asset), exportedAs, status, note]);

  const jobs = transferJobs(assets, marks, opts);
  const missingRaw = [];
  for (const asset of picked) {
    if (asset.raws.length === 0 && !opts.onlyFiles) {
      missingRaw.push(asset.id);
      row(asset, '', '', 'no-raw', '收藏了这一张，但文件夹里没有对应的 RAW 文件');
    }
  }

  const summary = {
    exported: 0, skipped: 0, renamed: 0,
    // 跳过 / 改名的具体是哪张照片、落在哪个已有路径——不只是一个数字，
    // 好让调用方（Task 17 的导出面板）能把"正确续传"和"撞名覆盖风险"
    // 的区别展示给摄影师，而不是让人去手工比对整个文件夹。
    skippedAssets: [], renamedAssets: [],
    missingRaw, errors: [], canceled: false, destRoot,
    total: jobs.length, files: [], records: [],
  };

  await fs.mkdir(destRoot, { recursive: true });

  let done = 0;
  let cursor = 0;
  for (; cursor < jobs.length; cursor++) {
    const job = jobs[cursor];
    if (signal?.aborted) { summary.canceled = true; break; }

    const src = joinRel(root, job.asset.dir, job.name);
    const relDir = flatten ? '' : job.asset.dir;
    const subdir = job.kind === 'jpg' && jpgSubdir ? jpgSubdir : '';
    const dest = path.join(destRoot, subdir, ...relDir.split('/').filter(Boolean), job.name);

    let result = { id: job.asset.id, dir: job.asset.dir, name: job.name, kind: job.kind, status: 'failed' };
    try {
      await assertWithin([realRoot], src);
      await assertWithin([realDestRoot], dest);
      const srcStat = await fs.stat(src);
      const plan = await planTarget(dest, srcStat);
      await assertWithin([realDestRoot], plan.finalPath);
      let status;

      if (plan.action === 'skip') {
        summary.skipped++;
        summary.skippedAssets.push({ id: job.asset.id, existingPath: plan.finalPath });
        status = 'skipped';
      } else {
        if (mode === 'move') await moveVerified(src, plan.finalPath);
        else await copyVerified(src, plan.finalPath);
        summary.exported++;
        if (plan.action === 'rename') {
          summary.renamed++;
          summary.renamedAssets.push({ id: job.asset.id, path: plan.finalPath });
          status = 'renamed';
        } else {
          status = 'exported';
        }
      }
      if (job.kind === 'raw') {
        // status 明确区分 exported / renamed / skipped——跳过的文件已经在目标
        // 位置存在（来自更早一次导出），这一次并没有被写入，manifest 不能把
        // 它记成"已导出"，否则打开 CSV 的摄影师会误以为每一行都是这次交付的。
        row(job.asset, job.name, path.relative(destRoot, plan.finalPath), status);
      }
      result = { ...result, status, path: plan.finalPath };
    } catch (err) {
      result = { ...result, message: err.message,
        ...(err instanceof MoveDeleteError ? { status: 'delete-failed', path: err.deliveredPath } : {}) };
      summary.errors.push({ id: job.asset.id, file: job.name, message: err.message });
      if (job.kind === 'raw') {
        if (err instanceof MoveDeleteError) {
          // 文件已经正确送达，只是源文件没删掉——记成 failed 是漏报，
          // 摄影师会以为要重新导一次，实际上重导只会撞名生成一份 _1 副本。
          row(job.asset, job.name, path.relative(destRoot, err.deliveredPath),
            'moved-copy-ok-delete-failed', err.message);
        } else {
          row(job.asset, job.name, '', 'failed', err.message);
        }
      }
    }

    summary.files.push(result);
    // 文件已完成的结果先持久化，再报进度；写历史失败不能伪装成照片复制失败。
    await onFile?.(result);

    done++;
    onProgress?.({
      done, total: jobs.length, currentFile: job.name,
      skipped: summary.skipped, renamed: summary.renamed, errors: summary.errors.length,
    });
  }

  if (summary.canceled) {
    // 取消之后还没轮到的收藏 RAW 也要出行——否则取消路径下的 manifest 只覆盖前半截，
    // 摄影师无法区分"这张没被处理"和"这张被漏记了"。
    for (const pending of jobs.slice(cursor)) {
      const result = { id: pending.asset.id, dir: pending.asset.dir, name: pending.name,
        kind: pending.kind, status: 'canceled', message: '任务被取消，这个文件没有被处理' };
      summary.files.push(result);
      await onFile?.(result);
      if (pending.kind === 'raw') {
        row(pending.asset, pending.name, '', 'canceled', '任务被取消，这个文件没有被处理');
      }
    }
  }

  // 取消时**更要**写记录：move 模式下取消，前面那些源 RAW 已经被删掉了，而 summary
  // 只活在浏览器的 React state 里，刷新一下就没了。取消恰恰是最需要留下一份
  // "到底动了哪些文件"的路径，旧实现却偏偏是唯一不写记录的那一条。
  if (manifest) {
    const header = csvRow(MANIFEST_HEADER);
    summary.records.push(await writeRecordFile(
      destRoot, 'manifest.csv',
      '\uFEFF' + header + manifestRows.map(csvRow).join(''),   // BOM 让 Excel 正确识别 UTF-8
    ));
    summary.records.push(await writeRecordFile(destRoot, 'rejected.txt', rejected.join('\n') + '\n'));
  }

  return summary;
}
