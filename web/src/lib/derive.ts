import type { Asset, AssetMeta, FilterTab, Mark } from '../types';
import type { BurstItem, Group } from './bursts';

type Marks = Record<string, Mark | undefined>;

/** 给"这一步跟标记无关"的调用点用的空标记表，保证 memo 依赖数组里不会混进 marks。 */
export const NO_MARKS: Marks = {};

/**
 * 只按目录筛选，与标记无关。
 *
 * 存在的理由是**签名本身**：连拍分组必须只依赖 (assets, metas, threshold, dirFilter)，
 * 一旦把 marks 也算进那个 memo，每按一次 P/X 就要对整库重跑
 * filterAssets ×5 + toBurstItems + groupBursts（含一次全量排序）+ flatOrder + Grid 的 rows。
 *
 * 这条路径原本写的是 `filterAssets(assets, NO_MARKS, 'all', dirFilter)`，
 * 并被当成「结构性保证」。那是假的：filterAssets 的第二个形参就是 marks，
 * 把 NO_MARKS 换成 marks 是一次单词替换，全套测试照样全绿——复审实测过。
 * 挡在回退前面的只有一个常量的名字。
 *
 * 现在它拿不到 marks 了：不是因为约定，而是因为函数签名里没有这个参数。
 */
export function assetsInDir(assets: Asset[], dirFilter: string | null): Asset[] {
  return dirFilter === null ? assets : assets.filter((a) => a.dir === dirFilter);
}

export function filterAssets(
  assets: Asset[], marks: Marks, tab: FilterTab, dirFilter: string | null,
  hidden: ReadonlySet<string>,
): Asset[] {
  return assets.filter((a) => {
    if (dirFilter !== null && a.dir !== dirFilter) return false;
    // 「已隐藏」是一个独立的视图，不和标记正交：隐藏的照片必然未标记
    // （不变量 2），所以这个 tab 下不需要再看 marks。
    if (tab === 'hidden') return hidden.has(a.id);
    if (hidden.has(a.id)) return false;
    const mark = marks[a.id];
    if (tab === 'all') return true;
    if (tab === 'none') return mark === undefined;
    return mark === tab;
  });
}

/**
 * 元数据是后台陆续到达的。还没到的资产用文件 mtime 兜底，
 * 并把 timeSource 标成 'mtime' —— groupBursts 会因此拒绝把它们并进连拍组，
 * 所以「元数据加载途中」不会出现错误的分组闪烁。
 */
export function toBurstItems(assets: Asset[], metas: Map<string, AssetMeta>): BurstItem[] {
  return assets.map((a) => {
    const meta = metas.get(a.id);
    if (meta) {
      return { id: a.id, time: meta.time, timeSource: meta.timeSource, body: meta.body };
    }
    return { id: a.id, time: a.jpgMtimeMs, timeSource: 'mtime' as const, body: `dir:${a.dir}` };
  });
}

export function dirCounts(assets: Asset[], hidden: ReadonlySet<string>): { dir: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const a of assets) {
    if (hidden.has(a.id)) continue;
    counts.set(a.dir, (counts.get(a.dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => a.dir.localeCompare(b.dir, 'zh'));
}

/**
 * 每个目录里有几张被标成「排除」。**只为至少有一张的目录建条目**，取不到即 0。
 *
 * 单独一趟遍历，而不是让调用方对每个目录各扫一遍全库：Sidebar 为了判断
 * "这个目录是不是已经全排除了"必须订阅 marks，于是每按一次 P/X 它都会重渲染。
 * O(assets × dirs) 在三千张、二十个目录的库上就是每次按键六万次比较；
 * 这里是一次 O(assets)，和 TopBar 的 countByTab 同一个量级。
 *
 * 与 dirCounts 用同一个判据（`a.dir` **全等**，不做前缀归并），两处必须一致——
 * 一个按全等数总数、另一个按前缀数排除数，会得出"永远不可能全排除"的结论。
 */
export function dirRejected(
  assets: Asset[], marks: Marks, hidden: ReadonlySet<string>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of assets) {
    if (hidden.has(a.id)) continue;
    if (marks[a.id] === 'reject') out.set(a.dir, (out.get(a.dir) ?? 0) + 1);
  }
  return out;
}

/**
 * 按 tab 过滤已经分好的组，而不是先按 tab 过滤资产再分组。
 *
 * 分组是 (assets, metas, threshold, dirFilter) 的纯函数，跟 marks 无关；把 marks
 * 塞进分组那一步的 memo 依赖里，意味着每按一次 P/X 都要对整库重跑
 * filterAssets + toBurstItems + groupBursts（含一次全量排序）+ flatOrder。
 * 这是"打了几十张之后感觉发涩"的直接来源。
 *
 * 顺带修正了一个语义问题：先过滤再分组时，一串连拍里没被收藏的中间几张会把这串
 * 连拍从中间切断，收藏视图里同一串连拍会碎成好几组。先分组再过滤则保持成一组。
 *
 * key 一律保留原组的 key，这样 expanded 里记着的展开状态不会因为切 tab 而失效。
 */
export function filterGroups(
  groups: Group[], marks: Marks, tab: FilterTab, hidden: ReadonlySet<string>,
): Group[] {
  // 隐藏集为空且 tab 是 all 时引用不变，下游 memo 不会因为切回全部而重算。
  if (tab === 'all' && hidden.size === 0) return groups;
  const keep = (id: string) => {
    if (tab === 'hidden') return hidden.has(id);
    if (hidden.has(id)) return false;
    if (tab === 'all') return true;
    return tab === 'none' ? marks[id] === undefined : marks[id] === tab;
  };

  const out: Group[] = [];
  for (const group of groups) {
    const ids = group.ids.filter(keep);
    if (ids.length === 0) continue;
    out.push(ids.length === group.ids.length ? group : { key: group.key, ids });
  }
  return out;
}

/** 五个 tab 的数量一次遍历算完。 */
export function countByTab(
  assets: Asset[], marks: Marks, hidden: ReadonlySet<string>,
): Record<FilterTab, number> {
  const out: Record<FilterTab, number> = { all: 0, pick: 0, reject: 0, none: 0, hidden: 0 };
  for (const a of assets) {
    if (hidden.has(a.id)) { out.hidden++; continue; }
    out.all++;
    const mark = marks[a.id];
    if (mark === 'pick') out.pick++;
    else if (mark === 'reject') out.reject++;
    else out.none++;
  }
  return out;
}

export function groupMarkSummary(ids: string[], marks: Marks) {
  let picked = 0;
  let rejected = 0;
  for (const id of ids) {
    if (marks[id] === 'pick') picked++;
    else if (marks[id] === 'reject') rejected++;
  }
  return { picked, rejected, total: ids.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// 客户维度
// ─────────────────────────────────────────────────────────────────────────────

export type Contrib = Record<string, Record<string, { mark: Mark; at: number }> | undefined>;

/**
 * 客户维度下「这张照片该不该出现」。**是这一层唯一的判据**，
 * filterGroupsByClient 和 countByTabForClient 都从它派生——两处各写一份的话，
 * 会出现「页签上写着 12 张、点进去只有 9 张」这种没法解释的分歧。
 *
 * - 全部 = 他碰过的（`contrib[id][who]` 存在）
 * - 收藏 / 排除 = **他那一票**是 pick / reject，哪怕后来被别人改掉了。
 *   这正是「新娘收藏过哪些」这个问题的答案；按有效标记筛的话，
 *   一张被妈妈改过的照片就再也查不到新娘曾经收藏过它。
 * - 未标记 = 他没碰过的
 *
 * **筛了人之后「全部」不再等于整库**，而是等于「收藏 + 排除」。这不是 bug：
 * 如果「全部」不受筛选影响，这个入口就是个摆设。数字对不上的疑虑由文案消解——
 * 筛了人之后那个 tab 显示成「XX 碰过的 N」，不再叫「全部」。
 *
 * 「已隐藏」**忽略 who**：隐藏是摄影师的操作，没有客户维度。不忽略的话，
 * 计数说有 5 张、点进去空空如也——因为隐藏的照片必然未标记（不变量 2），
 * 任何人的 contrib 里都不会有它们。
 */
function keepForClient(
  id: string, contrib: Contrib, who: string, tab: FilterTab, hidden: ReadonlySet<string>,
): boolean {
  if (tab === 'hidden') return hidden.has(id);
  if (hidden.has(id)) return false;
  const mine = contrib[id]?.[who];
  if (tab === 'none') return mine === undefined;
  if (mine === undefined) return false;
  if (tab === 'all') return true;
  return mine.mark === tab;
}

/**
 * 按某个人的贡献筛选连拍组。形状与 filterGroups 完全一致（同样保持引用不变的
 * 优化、同样丢掉空组），换掉的只有判据。
 */
export function filterGroupsByClient(
  groups: Group[], contrib: Contrib, who: string, tab: FilterTab,
  hidden: ReadonlySet<string>,
): Group[] {
  const out: Group[] = [];
  for (const group of groups) {
    const ids = group.ids.filter((id) => keepForClient(id, contrib, who, tab, hidden));
    if (ids.length === 0) continue;
    out.push(ids.length === group.ids.length ? group : { key: group.key, ids });
  }
  return out;
}

/** 客户维度下五个 tab 的数量。一次遍历算完，判据与 filterGroupsByClient 同源。 */
export function countByTabForClient(
  assets: Asset[], contrib: Contrib, who: string, hidden: ReadonlySet<string>,
): Record<FilterTab, number> {
  const out: Record<FilterTab, number> = { all: 0, pick: 0, reject: 0, none: 0, hidden: 0 };
  for (const a of assets) {
    if (hidden.has(a.id)) { out.hidden++; continue; }
    const mine = contrib[a.id]?.[who];
    if (mine === undefined) { out.none++; continue; }
    out.all++;
    if (mine.mark === 'pick') out.pick++;
    else out.reject++;
  }
  return out;
}

/**
 * 成员条上该显示谁。
 *
 * **在线的一律显示，而且直接取 online 里那一份**，不从 roster 过滤：roster 是
 * admin-only 的（见 session.ts 的 loadRoster），访客那边永远是空数组——
 * 从 roster 过滤会让每一个访客的成员条整个消失。
 *
 * 离线的只在 contrib 里确实有过标记时才留下。这样一条用久了的分享不会被十几个
 * 从没动过手的受邀者撑长，同时保证「照片上有头像，条上一定找得到这个人」——
 * 照片上那个头像是可点的筛选入口，找不到对应的人就是个死链接。
 *
 * role 只有在线的才有：它来自 presence 快照。离线的人是只读还是可写，此刻既
 * 查不到也不可操作，不显示比显示一个过期的更诚实。
 *
 * 排序：在线的在前，同组内按昵称，让条不会因为谁上下线而整个跳动。
 */
export function barMembers(
  roster: { id: string; nickname: string }[],
  online: { id: string; nickname: string; role?: string }[],
  contrib: Contrib,
): { id: string; nickname: string; isOnline: boolean; role?: string }[] {
  const contributed = new Set<string>();
  for (const perUser of Object.values(contrib)) {
    for (const id of Object.keys(perUser ?? {})) contributed.add(id);
  }

  const out = online.map((u) => ({ ...u, isOnline: true }));
  const seen = new Set(online.map((u) => u.id));
  for (const u of roster) {
    if (seen.has(u.id) || !contributed.has(u.id)) continue;
    out.push({ ...u, isOnline: false });
  }

  return out.sort((a, b) =>
    a.isOnline === b.isOnline ? a.nickname.localeCompare(b.nickname) : (a.isOnline ? -1 : 1));
}
