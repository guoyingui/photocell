/**
 * 贡献表（规格 §1.2–1.4）。
 *
 * 形状是 `{ [assetId]: { [userId]: { mark, at } } }`，**每人每张只留最后一次**。
 * 完整历史在审计日志里，那才是它该待的地方；留在这里只会让文件随着选片
 * 时长无限增长，而且对「她收藏了哪些」这个唯一要回答的问题毫无帮助。
 *
 * 有效标记（`marks`）从这张表求得：`at` 最大的那条赢。标记时结果和改造前
 * 一模一样（后写的 at 最大）；**取消时会回退到上一个人那一票**——那是这套
 * 设计唯一改变的现有行为，也是它存在的理由。
 *
 * 全部是纯函数：不读盘、不产生副作用、时间由调用方注入。
 */

const VALID_MARKS = new Set(['pick', 'reject']);

function isPlainObject(obj) {
  return obj !== null && typeof obj === 'object' && Object.getPrototypeOf(obj) === Object.prototype;
}

/**
 * 求有效标记。
 *
 * 平局（同一毫秒内两个人各写一次）按 userId 字典序取大的。没有这条规则，
 * 同一份 contrib 在不同的 `Object.entries` 顺序下会求出两个不同的答案，
 * 而那个顺序取决于 JSON 的字段书写次序——一个谁也不会去核对的隐式依赖。
 */
export function evaluate(entry) {
  if (!isPlainObject(entry)) return null;
  let best = null;
  for (const [by, v] of Object.entries(entry)) {
    if (!isPlainObject(v)) continue;
    if (best === null || v.at > best.at || (v.at === best.at && by > best.by)) {
      best = { by, mark: v.mark, at: v.at };
    }
  }
  return best;
}

/**
 * 写入一票，返回**新的** entry（不改传进来的那个）。
 * `mark` 为 null 表示取消——删掉这个人的条目，而不是写 `{mark: null}`：
 * 筛选器只有「收藏 / 排除 / 未标记」三个值可筛，null 筛不出来，
 * 而「她取消了」和「她没碰过」对这三个值来说是同一件事。
 *
 * 整条空了返回 null，调用方据此把这个 assetId 整个从表里删掉。
 */
export function setContribution(entry, by, mark, at) {
  const next = isPlainObject(entry) ? { ...entry } : {};
  if (mark === null || mark === undefined) delete next[by];
  else next[by] = { mark, at };
  return Object.keys(next).length === 0 ? null : next;
}

/**
 * 旧文件回填（规格 §1.4）。
 *
 * 没归属的算 `admin`——那些文件夹是单机选的，标记本来就是摄影师自己按的。
 * `at` 缺失时用 0：任何后来的改动都会赢过它。
 */
export function backfill(marks, marksMeta) {
  const contrib = {};
  const meta = isPlainObject(marksMeta) ? marksMeta : {};
  for (const [id, mark] of Object.entries(marks ?? {})) {
    if (!VALID_MARKS.has(mark)) continue;
    const m = isPlainObject(meta[id]) ? meta[id] : {};
    const by = typeof m.by === 'string' && m.by !== '' ? m.by : 'admin';
    const at = typeof m.at === 'number' && Number.isFinite(m.at) ? m.at : 0;
    contrib[id] = { [by]: { mark, at } };
  }
  return contrib;
}

/**
 * `showPeerMarks: false` 时，访客 `userId` 看到的标记（规格 §2.1）。
 * 自己的优先于摄影师的；别的客户那一票一律看不见。
 */
export function visibleMark(entry, userId) {
  if (!isPlainObject(entry)) return null;
  const mine = entry[userId];
  if (isPlainObject(mine)) return mine.mark;
  const admin = entry.admin;
  if (isPlainObject(admin)) return admin.mark;
  return null;
}

/**
 * 读取时的归一。**任何形状的坏数据都只退化成"少一些条目"，绝不抛**——
 * 升级不该让摄影师昨天的选片打不开（与 store.js 的 sanitizeMarksMeta 同一条规矩）。
 */
export function sanitizeContrib(field) {
  const clean = {};
  if (!isPlainObject(field)) return clean;
  for (const [id, entry] of Object.entries(field)) {
    if (!isPlainObject(entry)) continue;
    const kept = {};
    for (const [by, v] of Object.entries(entry)) {
      if (by === '' || !isPlainObject(v)) continue;
      if (!VALID_MARKS.has(v.mark)) continue;
      if (typeof v.at !== 'number' || !Number.isFinite(v.at)) continue;
      kept[by] = { mark: v.mark, at: v.at };
    }
    if (Object.keys(kept).length > 0) clean[id] = kept;
  }
  return clean;
}
