import fs from 'node:fs/promises';
import path from 'node:path';

export const RAW_EXTS = new Set([
  'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf',
  'rw2', 'pef', 'ptx', 'dng', '3fr', 'fff', 'iiq', 'x3f', 'mrw', 'kdc',
  'dcr', 'erf', 'mef', 'mos', 'srw', 'rwl', 'gpr',
]);

export const JPG_EXTS = new Set(['jpg', 'jpeg', 'jpe']);

const SKIP_DIR_NAMES = new Set(['__MACOSX', '.Trashes', '$RECYCLE.BIN', 'System Volume Information']);
const SKIP_DIR_PATTERNS = [/\.lrdata$/i, /^Lightroom Previews/i, /\.lrcat-data$/i];

export const MAX_DEPTH = 8;

/** 光看文件名判断它是不是一张照片（软链接不能 stat，只有名字可用）。 */
function isPhotoName(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return RAW_EXTS.has(ext) || JPG_EXTS.has(ext);
}

function shouldSkipDir(name) {
  if (name.startsWith('.')) return true;           // 含 .photocull
  if (SKIP_DIR_NAMES.has(name)) return true;
  return SKIP_DIR_PATTERNS.some((re) => re.test(name));
}

/** 纯函数：把文件条目配对成资产表。 */
export function pairEntries(entries) {
  const warnings = [];
  let skippedFiles = 0;
  /** @type {Map<string, any>} */
  const byKey = new Map();

  for (const entry of entries) {
    const posix = entry.path.split(path.sep).join('/');
    const slash = posix.lastIndexOf('/');
    const dir = slash === -1 ? '' : posix.slice(0, slash);
    const name = slash === -1 ? posix : posix.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    if (dot <= 0) { skippedFiles++; continue; }

    const ext = name.slice(dot + 1).toLowerCase();
    const isRaw = RAW_EXTS.has(ext);
    const isJpg = JPG_EXTS.has(ext);
    if (!isRaw && !isJpg) { skippedFiles++; continue; }

    const stem = name.slice(0, dot);
    const key = `${dir}/${stem.toLowerCase()}`;   // 目录名保持大小写敏感；/ 不会出现在文件名分量里，故不会碰撞
    let asset = byKey.get(key);
    if (!asset) {
      asset = {
        id: dir ? `${dir}/${stem}` : stem,
        // rawMtimeMs：没有 JPG 的孤儿 RAW 唯一的时间来源。以前这种资产的
        // jpgMtimeMs 恒为 0，normalizeMeta 拿它当兜底 mtime，于是整批孤儿 RAW
        // 的 time 都是 0——按时间排序时全部堆在网格最前面，日期显示 1970。
        dir, stem, raws: [], jpg: null, jpgSize: 0, jpgMtimeMs: 0, rawMtimeMs: 0,
      };
      byKey.set(key, asset);
    }

    if (isRaw) {
      asset.raws.push(name);
      if (asset.rawMtimeMs === 0) asset.rawMtimeMs = entry.mtimeMs;   // 第一个 RAW 的 mtime 作兜底
    } else if (asset.jpg === null) {
      asset.jpg = name;
      asset.jpgSize = entry.size;
      asset.jpgMtimeMs = entry.mtimeMs;
    } else {
      const [keep, drop] = [asset.jpg, name].sort();
      if (keep !== asset.jpg) {
        asset.jpg = name; asset.jpgSize = entry.size; asset.jpgMtimeMs = entry.mtimeMs;
      }
      warnings.push(`${asset.id} 有多个 JPG，使用 ${keep}，忽略 ${drop}`);
    }
  }

  const assets = [...byKey.values()];
  for (const a of assets) a.raws.sort();
  assets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { assets, warnings, skippedFiles };
}

/** 递归遍历，不跟随符号链接。
 * @param {string} root
 * @param {object} opts
 * @param {number} opts.maxDepth
 * @param {number} opts.batchSize - 多少文件后触发 onBatch 回调（默认 500）
 * @param {(count: number) => void} opts.onBatch
 */
export async function walk(root, { maxDepth = MAX_DEPTH, batchSize = 500, onBatch } = {}) {
  const entries = [];
  const warnings = [];
  let sinceBatch = 0;
  let symlinkedPhotos = 0;

  async function visit(absDir, relDir, depth) {
    let dirents;
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      warnings.push(`无法读取目录 ${relDir || '.'}：${err.code}`);
      return;
    }
    for (const d of dirents) {
      const abs = path.join(absDir, d.name);
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      if (d.isSymbolicLink()) {
        // 符号链接一律不跟随（防成环、防越界）。但一张软链接过来的照片被完全静默地
        // 丢掉，正是规格里说的"最不可接受的失败模式"——至少要让它出现在
        // "已跳过 N 个非照片文件"那个数字里，摄影师才有机会发现张数对不上。
        if (isPhotoName(d.name)) symlinkedPhotos++;
        continue;
      }
      if (d.isDirectory()) {
        if (shouldSkipDir(d.name)) continue;
        if (depth >= maxDepth) {
          warnings.push(`已达深度上限，跳过 ${rel} 及其子目录`);
          continue;
        }
        await visit(abs, rel, depth + 1);
      } else if (d.isFile()) {
        if (d.name.startsWith('._')) continue; // macOS AppleDouble
        try {
          const st = await fs.stat(abs);
          entries.push({ path: rel, size: st.size, mtimeMs: st.mtimeMs });
          if (onBatch && ++sinceBatch >= batchSize) { onBatch(entries.length); sinceBatch = 0; }
        } catch (err) {
          warnings.push(`无法读取文件 ${rel}：${err.code}`);
        }
      }
    }
  }

  await visit(root, '', 0);
  if (onBatch && sinceBatch > 0) onBatch(entries.length);
  return { entries, warnings, symlinkedPhotos };
}

export async function scanFolder(root, opts = {}) {
  const { entries, warnings: walkWarnings, symlinkedPhotos } = await walk(root, opts);
  const { assets, warnings, skippedFiles } = pairEntries(entries);
  // 被跳过的软链接照片也算进"已跳过"，否则它们既不在资产表里也不在任何计数里。
  return {
    assets,
    warnings: [...walkWarnings, ...warnings],
    skippedFiles: skippedFiles + symlinkedPhotos,
  };
}
