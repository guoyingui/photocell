import path from 'node:path';
import sharp from 'sharp';
import pLimit from 'p-limit';
import { readJson, writeJson, withFileLock } from './jsonstore.js';
import { marksDir } from './store.js';
import { getThumb } from './thumbs.js';

/**
 * 相似照片：用缩略图算 64 位差值哈希（dHash），把画面接近的照片聚成组。
 *
 * 为什么不是「按拍摄时间找连拍」：连拍分组只能看见同一次快门附近、
 * 同一机身拍的照片。换机位、换镜头、隔几秒再补一张、或者同一批素材
 * 从两张卡各导入一次，时间分组都看不见。摄影师真正要剔除的重复，
 * 往往正是这些「看起来几乎一样」的照片。
 *
 * 为什么是 dHash 而不是平均哈希：平均哈希只看整体明暗，逆光/欠曝的
 * 两张照片都可能落成同一个 0；dHash 比较相邻像素的明暗关系，对整体
 * 亮度变化不敏感，对构图差异更敏感，正好符合「同一场景换曝光」的直觉。
 *
 * 局限（README 里也写了，不能靠一句「智能」把它藏起来）：
 * - 只读缩略图，不重新解码 RAW 像素；纯 RAW 用的是内嵌 JPEG 预览。
 * - 比较的是 9×8 的灰度结构，颜色、表情细节、焦点是否在眼睛上都不在其中。
 * - 阈值是一个主观偏好，不存在对所有拍摄都正确的值；界面给三档并允许重扫。
 * - 近似边界的照片可能漏掉或误并，最终仍由摄影师在组内确认。
 */

export const SIMILAR_DEFAULT_THRESHOLD = 8;
export const SIMILAR_MAX_THRESHOLD = 24;
/** 一次最多分析多少张。再大就不是「等几秒」而是「等几分钟」了。 */
export const SIMILAR_MAX_ASSETS = 20000;

const HASH_RE = /^[0-9a-f]{16}$/;
const CACHE_VERSION = 1;
const CACHE_FILE = 'similar.json';
const HASH_CONCURRENCY = 4;

/** 64 位里 1 的个数。按字节查表，比 BigInt 循环快得多，也更容易测。 */
const POPCOUNT = Uint8Array.from({ length: 256 }, (_, value) => {
  let n = value;
  n -= (n >> 1) & 0x55;
  n = (n & 0x33) + ((n >> 2) & 0x33);
  return (n + (n >> 4)) & 0x0f;
});

export function isHash(value) {
  return typeof value === 'string' && HASH_RE.test(value);
}

/** 两个 64 位哈希的汉明距离（0–64）。格式不合法时直接抛错，不静默当成 0。 */
export function hammingDistance(a, b) {
  if (!isHash(a) || !isHash(b)) throw new TypeError('相似哈希必须是 16 位十六进制字符串');
  let distance = 0;
  for (let i = 0; i < 16; i += 2) {
    distance += POPCOUNT[Number.parseInt(a.slice(i, i + 2), 16) ^ Number.parseInt(b.slice(i, i + 2), 16)];
  }
  return distance;
}

/** 一次算好的 64 位哈希，拆成两个 32 位整数供聚类内层循环使用。 */
function hashParts(hash) {
  return [Number.parseInt(hash.slice(0, 8), 16), Number.parseInt(hash.slice(8, 16), 16)];
}

/** 32 位整数里 1 的个数（SWAR）。比按字节查表快，聚类要跑上百万次。 */
function popcount32(value) {
  let x = value >>> 0;
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function partsDistance(a, b) {
  return popcount32(a[0] ^ b[0]) + popcount32(a[1] ^ b[1]);
}

export function clampThreshold(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return SIMILAR_DEFAULT_THRESHOLD;
  return Math.min(SIMILAR_MAX_THRESHOLD, Math.max(0, Math.round(n)));
}

/**
 * 从 9×8 的灰度像素算 dHash。返回 16 位十六进制；画面过于平坦时返回 null。
 *
 * 9 列产生 8 个「左边比右边亮」的布尔值，8 行正好 64 位。
 * 平坦画面（纯黑、纯白、镜头盖、大面积纯色背景）的相邻像素差几乎都是 0，
 * 任何两张都会算出同一个 0 哈希——把它们收进相似组既没有信息量，还会
 * 让「相似照片」里出现一屏毫不相干的纯色图。阈值取 1.0 的方差是很低的，
 * 正常照片远远高于它。
 */
export function hashPixels(data) {
  const width = 9;
  const height = 8;
  const total = width * height;
  if (!data || data.length < total) return null;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < total; i++) {
    const value = data[i];
    sum += value;
    sumSq += value * value;
  }
  const mean = sum / total;
  if (sumSq / total - mean * mean < 1) return null;

  let hash = '';
  for (let y = 0; y < height; y++) {
    let byte = 0;
    for (let x = 0; x < width - 1; x++) {
      byte = (byte << 1) | (data[y * width + x] > data[y * width + x + 1] ? 1 : 0);
    }
    hash += byte.toString(16).padStart(2, '0');
  }
  return hash;
}

/** 读一张缩略图算哈希。失败返回 null——一张坏图不该让整次扫描失败。 */
export async function hashFile(file) {
  try {
    const { data } = await sharp(file, { failOn: 'none' })
      .resize(9, 8, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return hashPixels(data);
  } catch (err) {
    console.warn(`[similar] 读取缩略图失败 ${path.basename(file)}: ${err.message}`);
    return null;
  }
}

/**
 * 把已经拿到的哈希按阈值分组。
 *
 * 采用「锚点聚类」而不是单链并查集：每张照片只和组内第一张（锚点）比较。
 * 单链会把 A≈B、B≈C、但 A 和 C 完全不像的三张串成一串，链子越长越离谱；
 * 锚点聚类保证组内每一张都真的接近同一张参考图，代价是边界附近可能
 * 分成相邻两组，对选片来说这比「一屏毫不相干的照片躺在同一组」好解释。
 *
 * items 的顺序由调用方决定（server/routes/similar.js 按拍摄时间排），
 * 所以同一批素材每次扫描的分组是稳定的；锚点也就是组内最早拍的那张。
 */
export function groupSimilar(items, threshold = SIMILAR_DEFAULT_THRESHOLD) {
  const limit = clampThreshold(threshold);
  const valid = (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item.id === 'string' && isHash(item.hash));
  const clusters = [];
  for (const item of valid) {
    const parts = hashParts(item.hash);
    let best = null;
    for (const cluster of clusters) {
      const distance = partsDistance(parts, cluster.anchorParts);
      if (distance <= limit && (best === null || distance < best.distance)) {
        best = { cluster, distance };
      }
    }
    if (best) best.cluster.items.push({ id: item.id, distance: best.distance });
    else clusters.push({ anchor: item, anchorParts: parts, items: [{ id: item.id, distance: 0 }] });
  }

  return clusters
    .filter((cluster) => cluster.items.length > 1)
    .map((cluster) => ({
      key: cluster.items[0].id,
      assetIds: cluster.items.map((item) => item.id),
      distances: Object.fromEntries(cluster.items.map((item) => [item.id, item.distance])),
      maxDistance: Math.max(...cluster.items.map((item) => item.distance)),
    }))
    .sort((a, b) => b.assetIds.length - a.assetIds.length
      || String(a.assetIds[0]).localeCompare(String(b.assetIds[0])));
}

function cachePath(root) {
  return path.join(marksDir(root), CACHE_FILE);
}

/**
 * 哈希缓存：以缩略图 key（路径 + mtime + size + 档位 的 sha1）为键。
 *
 * key 本身就包含了源文件的指纹，所以文件被替换、重新导入或重扫之后，
 * 旧条目自然查不到，不需要额外的失效逻辑。缓存放在 `.photocull/` 里，
 * 和缩略图一样属于派生数据，不进入选片备份；清掉它只会让下次多花几秒。
 *
 * 读取失败（没有文件、JSON 损坏、版本不对）一律当作空缓存，不阻断扫描。
 * 唯一写盘时机是一轮分析结束，失败只记日志：算出来的哈希在这一轮仍然可用。
 */
export function similarState(session) {
  if (!session.similar) {
    session.similar = {
      loaded: false,
      loading: null,
      dirty: false,
      hashes: new Map(),
    };
  }
  return session.similar;
}

export async function loadHashCache(session) {
  const state = similarState(session);
  if (state.loaded) return state;
  if (state.loading) return state.loading;
  state.loading = (async () => {
    try {
      const data = await readJson(cachePath(session.root), null);
      if (data?.version === CACHE_VERSION && data.hashes && typeof data.hashes === 'object'
        && !Array.isArray(data.hashes)) {
        for (const [key, hash] of Object.entries(data.hashes)) {
          if (HASH_RE.test(key) && isHash(hash)) state.hashes.set(key, hash);
        }
      }
    } catch (err) {
      console.warn('[similar] 读取哈希缓存失败，按空缓存继续', err.message);
    } finally {
      state.loaded = true;
      state.loading = null;
    }
    return state;
  })();
  return state.loading;
}

export async function saveHashCache(session) {
  const state = similarState(session);
  if (!state.dirty) return;
  state.dirty = false;
  const file = cachePath(session.root);
  try {
    // 不 mkdir：目录在开库时已经建好，这里递归创建会把一个已经被拔走/删掉的
    // 照片目录重新建出来一个空的 .photocull。写失败就当作这次没缓存。
    await withFileLock(file, async () => {
      await writeJson(file, { version: CACHE_VERSION, hashes: Object.fromEntries(state.hashes) });
    });
  } catch (err) {
    // 缓存写不进去不是扫描失败：这一轮结果已经算出来了，下次重新算而已。
    state.dirty = true;
    console.warn('[similar] 写入哈希缓存失败', err.message);
  }
}

/** 测试用：直接看缓存文件，不经过 session。生产代码不要调用。 */
export const _test = { cachePath, CACHE_VERSION };

const inflight = new Map();
const limit = pLimit(HASH_CONCURRENCY);

/** 取一张照片的哈希：先查缓存，再算缩略图。失败或平坦画面返回 null。 */
export async function ensureHash(session, asset) {
  const key = `${session.root}\u0000${asset.id}`;
  if (inflight.has(key)) return inflight.get(key);
  const job = limit(async () => {
    const thumb = await getThumb(session.root, asset, 'grid');
    if (thumb.placeholder || !thumb.file) return { hash: null, reason: 'no-preview' };
    const state = await loadHashCache(session);
    const cached = state.hashes.get(thumb.key);
    if (isHash(cached)) return { hash: cached, reason: null };
    const hash = await hashFile(thumb.file);
    if (!hash) return { hash: null, reason: 'flat' };
    state.hashes.set(thumb.key, hash);
    state.dirty = true;
    return { hash, reason: null };
  }).finally(() => { inflight.delete(key); });
  inflight.set(key, job);
  return job;
}

/**
 * 批量分析。调用方传入已经按拍摄时间排好的资产，逐张取哈希；
 * `onProgress` 每完成一张调用一次，路由据此向 SSE 发进度。
 *
 * 返回的 items 顺序和传入的 assets 一致，供 groupSimilar 保持锚点稳定。
 */
export async function hashAssets(session, assets, onProgress) {
  await loadHashCache(session);
  const items = [];
  let done = 0;
  let skipped = 0;
  let noPreview = 0;
  let flat = 0;
  // 并发闸门只在 ensureHash 里有一道。这里绝不能再套一层 pLimit：
  // 外层任务占满槽位、每个又在等内层任务拿到槽位，会把整次扫描锁死。
  const jobs = assets.map(async (asset) => {
    // 库已经关掉了（换目录/退出）：不再为它生成新的缩略图。已经排进队列的
    // 任务会很快走完这一支，路由看到 session.aborted 后回 409，也不会写缓存。
    if (session.aborted) { done++; onProgress?.(done, assets.length); return; }
    let result;
    try {
      result = await ensureHash(session, asset);
    } catch (err) {
      // 403 是路径越界，不是这张图的问题，必须让调用方看见。
      if (err?.status === 403) throw err;
      console.warn(`[similar] 分析失败 ${asset.id}: ${err.message}`);
      result = { hash: null, reason: 'error' };
    }
    done++;
    if (result.hash) items.push({ id: asset.id, hash: result.hash });
    else {
      skipped++;
      if (result.reason === 'no-preview') noPreview++;
      if (result.reason === 'flat') flat++;
    }
    onProgress?.(done, assets.length);
  });
  // 这里刻意用 allSettled 再统一抛错：一个 403 不该让其他已经排队的 sharp
  // 任务变成无人等待的孤儿——否则这次请求返回了，后台还在读图。
  const settled = await Promise.allSettled(jobs);
  const failure = settled.find((entry) => entry.status === 'rejected');
  if (failure) throw failure.reason;

  const order = new Map(assets.map((asset, index) => [asset.id, index]));
  items.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { items, skipped, noPreview, flat, analyzed: items.length };
}
