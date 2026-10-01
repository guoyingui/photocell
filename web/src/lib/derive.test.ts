import { describe, it, expect } from 'vitest';
import {
  filterAssets, assetsInDir, toBurstItems, dirCounts, dirRejected, groupMarkSummary,
  filterGroups, countByTab, NO_MARKS,
  filterGroupsByClient, countByTabForClient, barMembers,
} from './derive';
import { groupBursts } from './bursts';
import type { Asset, AssetMeta, FilterTab, Mark } from '../types';

const asset = (id: string, dir = '', jpg: string | null = 'x.JPG'): Asset => ({
  id, dir, stem: id.split('/').pop()!, raws: ['x.CR3'], jpg,
  jpgSize: 10, jpgMtimeMs: 5000,
});

const assets = [asset('A'), asset('cam-a/B', 'cam-a'), asset('cam-a/C', 'cam-a'), asset('D')];
const marks = { A: 'pick', 'cam-a/B': 'reject', 'cam-a/C': 'pick' } as const;
// 稳定的空隐藏集，给"这一步跟隐藏无关"的调用点用——同一份用意的 NO_MARKS 已经
// 从 derive.ts 导出，但隐藏集只在这个新签名里出现，没必要为测试专门从生产代码
// 里再导出一个常量，这里本地建一份就够。
const NO_HIDDEN = new Set<string>();

describe('filterAssets', () => {
  it('all 返回全部', () => {
    expect(filterAssets(assets, marks, 'all', null, NO_HIDDEN)).toHaveLength(4);
  });
  it('pick 只返回收藏', () => {
    expect(filterAssets(assets, marks, 'pick', null, NO_HIDDEN).map((a) => a.id)).toEqual(['A', 'cam-a/C']);
  });
  it('reject 只返回排除', () => {
    expect(filterAssets(assets, marks, 'reject', null, NO_HIDDEN).map((a) => a.id)).toEqual(['cam-a/B']);
  });
  it('none 只返回未标记', () => {
    expect(filterAssets(assets, marks, 'none', null, NO_HIDDEN).map((a) => a.id)).toEqual(['D']);
  });
  it('目录过滤与 tab 正交叠加', () => {
    expect(filterAssets(assets, marks, 'pick', 'cam-a', NO_HIDDEN).map((a) => a.id)).toEqual(['cam-a/C']);
  });
  it('目录过滤只匹配该层，不含更深的子目录', () => {
    const deep = [...assets, asset('cam-a/sub/E', 'cam-a/sub')];
    expect(filterAssets(deep, {}, 'all', 'cam-a', NO_HIDDEN).map((a) => a.id)).toEqual(['cam-a/B', 'cam-a/C']);
  });
  it('根目录过滤用空串', () => {
    expect(filterAssets(assets, {}, 'all', '', NO_HIDDEN).map((a) => a.id)).toEqual(['A', 'D']);
  });
});

describe('toBurstItems', () => {
  it('有元数据时用 EXIF 时间与机身', () => {
    const metas = new Map<string, AssetMeta>([['A', {
      id: 'A', time: 111, timeSource: 'exif', orientation: 1, body: 'R5|SN',
      iso: null, fNumber: null, exposureTime: null, focalLength: null,
    }]]);
    expect(toBurstItems([asset('A')], metas)[0])
      .toEqual({ id: 'A', time: 111, timeSource: 'exif', body: 'R5|SN' });
  });

  it('元数据未到时用 jpgMtimeMs 兜底且标为 mtime', () => {
    const item = toBurstItems([asset('cam-a/B', 'cam-a')], new Map())[0];
    expect(item).toEqual({ id: 'cam-a/B', time: 5000, timeSource: 'mtime', body: 'dir:cam-a' });
  });

  it('兜底项因为 timeSource 是 mtime，不会被误分进连拍组', () => {
    // A、B 的兜底 body 相同（同为根目录）、时间也相同（同一个 jpgMtimeMs），
    // 如果 mtime 保护失效，groupBursts 会把它们并成一组——这才是本用例真正要守住的行为。
    const items = toBurstItems([asset('A'), asset('B')], new Map());
    expect(items.every((i) => i.timeSource === 'mtime')).toBe(true);
    const groups = groupBursts(items, 1000);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.ids)).toEqual([['A'], ['B']]);
  });
});

describe('dirCounts', () => {
  it('按目录统计并按目录名排序', () => {
    expect(dirCounts(assets, NO_HIDDEN)).toEqual([
      { dir: '', count: 2 },
      { dir: 'cam-a', count: 2 },
    ]);
  });
  it('空输入返回空数组', () => {
    expect(dirCounts([], NO_HIDDEN)).toEqual([]);
  });
});

describe('filterGroups — 先分组、后按 tab 过滤（I15）', () => {
  // 一串真正的连拍：五张，每张间隔 200ms，同机身，时间都来自 EXIF。
  const burstAssets = ['s0', 's1', 's2', 's3', 's4'].map((id) => asset(id));
  const burstMetas = new Map<string, AssetMeta>(burstAssets.map((a, i) => [a.id, {
    id: a.id, time: 1000 + i * 200, timeSource: 'exif', orientation: 1, body: 'R5|SN',
    iso: null, fNumber: null, exposureTime: null, focalLength: null,
  }]));
  // 只收藏首尾两张——它们相隔 800ms，但中间三张没被收藏。
  const burstMarks: Record<string, Mark> = { s0: 'pick', s4: 'pick' };

  it('分组不再被 marks 切断：收藏视图里同一串连拍仍然是一组', () => {
    // 旧管线：先按 tab 过滤资产再分组。中间三张被过滤掉之后，s0 和 s4 之间
    // 空出 800ms > 阈值 300ms，一串连拍在收藏视图里碎成两组。
    const oldPipeline = groupBursts(
      toBurstItems(filterAssets(burstAssets, burstMarks, 'pick', null, NO_HIDDEN), burstMetas), 300);
    expect(oldPipeline).toHaveLength(2);

    // 新管线：分组只看 (assets, metas, threshold)，marks 只决定组里还剩谁。
    const grouped = groupBursts(toBurstItems(burstAssets, burstMetas), 300);
    expect(grouped).toHaveLength(1);
    const visible = filterGroups(grouped, burstMarks, 'pick', NO_HIDDEN);
    expect(visible).toHaveLength(1);
    expect(visible[0].ids).toEqual(['s0', 's4']);
  });

  it('组的 key 保持不变，切 tab 不会让已展开的连拍组失去展开状态', () => {
    const grouped = groupBursts(toBurstItems(burstAssets, burstMetas), 300);
    expect(filterGroups(grouped, burstMarks, 'pick', NO_HIDDEN)[0].key).toBe(grouped[0].key);
  });

  it('全部 tab 原样返回同一个数组引用（下游 memo 不会因为切回全部而重算）', () => {
    const grouped = groupBursts(toBurstItems(burstAssets, burstMetas), 300);
    expect(filterGroups(grouped, burstMarks, 'all', NO_HIDDEN)).toBe(grouped);
  });

  it('一个成员都不剩的组被丢掉，全员留下的组保持原引用', () => {
    const groups = [
      { key: 'a', ids: ['a'] },
      { key: 'b', ids: ['b1', 'b2'] },
    ];
    const marks: Record<string, Mark> = { b1: 'pick', b2: 'pick' };
    const out = filterGroups(groups, marks, 'pick', NO_HIDDEN);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(groups[1]);   // 没被裁剪的组不重新分配对象
  });

  it('none 只留未标记的成员', () => {
    const groups = [{ key: 'g', ids: ['x', 'y', 'z'] }];
    expect(filterGroups(groups, { x: 'pick', y: 'reject' }, 'none', NO_HIDDEN)[0].ids).toEqual(['z']);
  });

  it('reject 只留被排除的成员', () => {
    const groups = [{ key: 'g', ids: ['x', 'y', 'z'] }];
    expect(filterGroups(groups, { x: 'pick', y: 'reject' }, 'reject', NO_HIDDEN)[0].ids).toEqual(['y']);
  });
});

describe('countByTab', () => {
  // 签名多了 hidden 参数、返回值多了 hidden 字段（Task 16）——这三条断言的
  // 预期值都补了 `hidden: 0`：夹具里没有隐藏的照片，所以补的是"确实没有"，
  // 不是放宽断言。真正验隐藏计数的用例在下面的「隐藏」describe 里。
  it('一趟遍历给出五个 tab 的数量', () => {
    expect(countByTab(assets, marks, NO_HIDDEN)).toEqual({ all: 4, pick: 2, reject: 1, none: 1, hidden: 0 });
  });

  it('结果与四次 filterAssets 完全一致', () => {
    for (const tab of ['all', 'pick', 'reject', 'none'] as const) {
      expect(countByTab(assets, marks, NO_HIDDEN)[tab])
        .toBe(filterAssets(assets, marks, tab, null, NO_HIDDEN).length);
    }
  });

  it('空标记表时全部算未标记', () => {
    expect(countByTab(assets, {}, NO_HIDDEN)).toEqual({ all: 4, pick: 0, reject: 0, none: 4, hidden: 0 });
  });
});

describe('NO_MARKS', () => {
  it('是一个稳定的空标记表：用它做目录过滤时依赖数组里不会混进 marks', () => {
    expect(NO_MARKS).toEqual({});
    expect(filterAssets(assets, NO_MARKS, 'all', 'cam-a', NO_HIDDEN).map((a) => a.id))
      .toEqual(['cam-a/B', 'cam-a/C']);
  });
});

describe('groupMarkSummary', () => {
  it('统计组内收藏与排除数', () => {
    expect(groupMarkSummary(['A', 'cam-a/B', 'cam-a/C'], marks))
      .toEqual({ picked: 2, rejected: 1, total: 3 });
  });
  it('全未标记时计数为 0', () => {
    expect(groupMarkSummary(['D'], marks)).toEqual({ picked: 0, rejected: 0, total: 1 });
  });
});

describe('assetsInDir —— 连拍分组这条路径拿不到 marks（G1）', () => {
  it('与 filterAssets(assets, NO_MARKS, "all", dir) 逐项等价', () => {
    for (const dir of [null, 'cam-a', '', 'nope']) {
      expect(assetsInDir(assets, dir).map((a) => a.id))
        .toEqual(filterAssets(assets, NO_MARKS, 'all', dir, NO_HIDDEN).map((a) => a.id));
    }
  });

  it('签名里没有 marks —— 只接受 2 个参数', () => {
    // 这条断言看着琐碎，但它守的正是复审实测出来的那个缺口：
    // 原本这里写的是 filterAssets(assets, NO_MARKS, 'all', dirFilter)，
    // 把 NO_MARKS 换成 marks（也就是 I15 的确切回退）之后全套测试仍然全绿——
    // 挡在回退前面的只有一个常量的名字。现在挡在前面的是形参个数。
    expect(assetsInDir.length).toBe(2);
  });

  it('dirFilter 为 null 时原样返回（不复制、不重排）', () => {
    expect(assetsInDir(assets, null)).toBe(assets);
  });
});

describe('dirRejected', () => {
  // 文件顶部已有的夹具：
  //   assets = [asset('A'), asset('cam-a/B', 'cam-a'), asset('cam-a/C', 'cam-a'), asset('D')]
  //   marks  = { A: 'pick', 'cam-a/B': 'reject', 'cam-a/C': 'pick' }
  it('只数 reject，不数 pick 和未标记', () => {
    expect(dirRejected(assets, marks, NO_HIDDEN)).toEqual(new Map([['cam-a', 1]]));
  });

  // 约定：一张都没排除的目录**不建条目**。判据 `get(dir) === count` 因此不会
  // 把"没有条目"误判成"全排除"——count 恒 >= 1，而 get 返回 undefined。
  it('一张都没排除的目录不出现在结果里', () => {
    expect(dirRejected(assets, marks, NO_HIDDEN).has('')).toBe(false);
  });

  it('同一目录里多张被排除时累加', () => {
    const all = { 'cam-a/B': 'reject', 'cam-a/C': 'reject' } as const;
    expect(dirRejected(assets, all, NO_HIDDEN)).toEqual(new Map([['cam-a', 2]]));
  });

  it('跨目录不串味', () => {
    const mixed = { A: 'reject', 'cam-a/B': 'reject' } as const;
    expect(dirRejected(assets, mixed, NO_HIDDEN)).toEqual(new Map([['', 1], ['cam-a', 1]]));
  });

  it('没有资产时是空 Map', () => {
    expect(dirRejected([], marks, NO_HIDDEN)).toEqual(new Map());
  });

  it('没有任何标记时是空 Map', () => {
    expect(dirRejected(assets, NO_MARKS, NO_HIDDEN)).toEqual(new Map());
  });
});

describe('隐藏', () => {
  // brief 用的构造辅助函数名是 a(id, dir)；本文件里实际叫 asset(id, dir)，用法一致。
  // 下面 assets/marks 是块作用域局部量，刻意与文件顶部同名的夹具重名（brief 原文
  // 如此）：两者互不相干，本块内的引用一律解析到这里的局部声明。
  const assets = [asset('IMG_1', 'cam-a'), asset('IMG_2', 'cam-a'), asset('IMG_3', 'cam-b')];
  const hidden = new Set(['IMG_2']);

  it('隐藏的照片不进任何普通 tab', () => {
    expect(filterAssets(assets, {}, 'all', null, hidden).map((x) => x.id)).toEqual(['IMG_1', 'IMG_3']);
    expect(filterAssets(assets, {}, 'none', null, hidden).map((x) => x.id)).toEqual(['IMG_1', 'IMG_3']);
  });

  it('「已隐藏」tab 里只有它们', () => {
    expect(filterAssets(assets, {}, 'hidden', null, hidden).map((x) => x.id)).toEqual(['IMG_2']);
  });

  it('「已隐藏」tab 不受目录筛选以外的东西影响，但目录筛选照常生效', () => {
    expect(filterAssets(assets, {}, 'hidden', 'cam-b', hidden)).toEqual([]);
  });

  it('计数里剔除隐藏的，另外单独给出隐藏数', () => {
    const counts = countByTab(assets, { IMG_1: 'pick' }, hidden);
    expect(counts).toEqual({ all: 2, pick: 1, reject: 0, none: 1, hidden: 1 });
  });

  it('左侧目录的总数也要剔除，否则显示 30 张而网格里只有 12 张', () => {
    expect(dirCounts(assets, hidden)).toEqual([
      { dir: 'cam-a', count: 1 },
      { dir: 'cam-b', count: 1 },
    ]);
  });

  it('目录的排除计数同样剔除隐藏的', () => {
    // dirCounts 按剔除后的数算总数，dirRejected 不剔除的话，
    // 「这个目录是不是全排除了」会得出一个永远为真或永远为假的结论。
    const marks = { IMG_1: 'reject' as const, IMG_2: 'reject' as const };
    expect(dirRejected(assets, marks, hidden).get('cam-a')).toBe(1);
  });

  it('连拍组里被隐藏的成员从组里去掉', () => {
    const groups = [{ key: 'g1', ids: ['IMG_1', 'IMG_2'] }];
    expect(filterGroups(groups, {}, 'all', hidden)).toEqual([{ key: 'g1', ids: ['IMG_1'] }]);
  });

  it('整组都被隐藏时这个组整个消失', () => {
    const groups = [{ key: 'g1', ids: ['IMG_2'] }];
    expect(filterGroups(groups, {}, 'all', hidden)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 客户维度（Task 22）
// ─────────────────────────────────────────────────────────────────────────────

describe('客户维度筛选', () => {
  const ids = ['IMG_1', 'IMG_2', 'IMG_3', 'IMG_4'];
  const cAssets = ids.map((id) => asset(id, 'c'));
  const groups = [{ key: 'g', ids }];
  const contrib = {
    IMG_1: { u_bride: { mark: 'pick' as const, at: 1 } },
    IMG_2: { u_bride: { mark: 'reject' as const, at: 2 }, u_mom: { mark: 'pick' as const, at: 9 } },
    IMG_3: { u_mom: { mark: 'pick' as const, at: 3 } },
    // IMG_4 谁都没碰过
  };
  const noHidden = new Set<string>();
  const kept = (who: string, tab: FilterTab, hidden = noHidden) =>
    filterGroupsByClient(groups, contrib, who, tab, hidden).flatMap((g) => g.ids);

  it('「全部」= 他碰过的', () => {
    expect(kept('u_bride', 'all')).toEqual(['IMG_1', 'IMG_2']);
  });

  it('「收藏」= 他那一票是 pick，哪怕后来被别人改掉了', () => {
    // 这正是「新娘收藏过哪些」这个问题的答案。IMG_2 的**有效**标记是妈妈的 pick，
    // 按有效标记筛的话新娘那一票就永远查不到了。
    expect(kept('u_bride', 'pick')).toEqual(['IMG_1']);
    expect(kept('u_mom', 'pick')).toEqual(['IMG_2', 'IMG_3']);
  });

  it('「排除」= 他那一票是 reject', () => {
    expect(kept('u_bride', 'reject')).toEqual(['IMG_2']);
  });

  it('「未标记」= 他没碰过的', () => {
    expect(kept('u_bride', 'none')).toEqual(['IMG_3', 'IMG_4']);
  });

  it('隐藏的照片在任何客户维度下都不出现', () => {
    expect(kept('u_bride', 'all', new Set(['IMG_1']))).toEqual(['IMG_2']);
  });

  it('「已隐藏」页签忽略筛的是谁，直接给隐藏的那些', () => {
    // 隐藏是摄影师的操作，没有客户维度。不忽略的话这个页签在筛人时永远是空的
    // ——隐藏的照片必然未标记（不变量 2），谁的 contrib 里都不会有它们——
    // 而计数那边照样报着 N 张，页签写着 N、点进去空空如也。
    expect(kept('u_bride', 'hidden', new Set(['IMG_3', 'IMG_4']))).toEqual(['IMG_3', 'IMG_4']);
  });

  it('整组都被筛掉时丢掉这个组，不留空壳', () => {
    const two = [{ key: 'g1', ids: ['IMG_1'] }, { key: 'g2', ids: ['IMG_3'] }];
    expect(filterGroupsByClient(two, contrib, 'u_bride', 'all', noHidden))
      .toEqual([{ key: 'g1', ids: ['IMG_1'] }]);
  });

  it('筛了人之后「全部」= 收藏 + 排除，不再等于整库', () => {
    // 看起来像 bug，其实是需求要的东西：如果「全部」不受筛选影响，
    // 这个入口就是个摆设。文案上那个 tab 会改叫「新娘碰过的 N」。
    const counts = countByTabForClient(cAssets, contrib, 'u_bride', noHidden);
    expect(counts.all).toBe(counts.pick + counts.reject);
    expect(counts).toEqual({ all: 2, pick: 1, reject: 1, none: 2, hidden: 0 });
  });

  it('计数与筛选口径一致：每个 tab 的数量等于筛出来的条数', () => {
    // 两处各写一份判据的话，会出现「页签上写着 12 张、点进去只有 9 张」
    // 这种没法解释的分歧。这条把两者钉死在一起。
    const hidden = new Set(['IMG_4']);
    const counts = countByTabForClient(cAssets, contrib, 'u_mom', hidden);
    for (const tab of ['all', 'pick', 'reject', 'none', 'hidden'] as FilterTab[]) {
      expect(kept('u_mom', tab, hidden).length).toBe(counts[tab]);
    }
  });

  it('摄影师自己也能被筛（userId 是字面量 admin）', () => {
    const withAdmin = { IMG_4: { admin: { mark: 'pick' as const, at: 1 } } };
    expect(filterGroupsByClient(groups, withAdmin, 'admin', 'pick', noHidden).flatMap((g) => g.ids))
      .toEqual(['IMG_4']);
  });
});

describe('barMembers', () => {
  const roster = [
    { id: 'u_bride', nickname: '新娘' },
    { id: 'u_mom', nickname: '妈妈' },
    { id: 'u_idle', nickname: '没动过手的' },
  ];
  const contrib = { IMG_1: { u_mom: { mark: 'pick' as const, at: 1 } } };

  it('在线的一律显示，哪怕一张都没标过', () => {
    const out = barMembers(roster, [{ id: 'u_idle', nickname: '没动过手的' }], {});
    expect(out.map((u) => u.id)).toEqual(['u_idle']);
    expect(out[0].isOnline).toBe(true);
  });

  it('离线但标过照片的仍然留在条上', () => {
    // 上报的 bug 的另一半：客户关掉网页之后整条成员条都没了，
    // 而他标过的照片还在，管理员没有任何入口能按他筛。
    const out = barMembers(roster, [], contrib);
    expect(out.map((u) => u.id)).toEqual(['u_mom']);
    expect(out[0].isOnline).toBe(false);
  });

  it('离线且没标过的不显示，条不会被受邀者撑长', () => {
    expect(barMembers(roster, [], {})).toEqual([]);
  });

  it('在线的排在离线的前面', () => {
    const out = barMembers(roster, [{ id: 'u_bride', nickname: '新娘' }], contrib);
    expect(out.map((u) => u.id)).toEqual(['u_bride', 'u_mom']);
  });

  it('roster 是空的时候，在线的人照样显示', () => {
    // roster 是 admin-only 的（session.ts 的 loadRoster 对访客必然失败），
    // 访客那边永远是空数组。从 roster 过滤的实现会让**每一个访客**的成员条
    // 整个消失，而这条条子在访客那一屏本来就是有用的。
    const out = barMembers([], [{ id: 'u_bride', nickname: '新娘', role: 'editor' }], {});
    expect(out.map((u) => u.id)).toEqual(['u_bride']);
    expect(out[0].role).toBe('editor');
  });

  it('contrib 里有坏条目时不抛', () => {
    // 这张表来自网络。Object.keys(undefined) 会直接把整屏炸掉。
    const dirty = { IMG_1: undefined, IMG_2: { u_mom: { mark: 'pick' as const, at: 1 } } };
    expect(barMembers(roster, [], dirty).map((u) => u.id)).toEqual(['u_mom']);
  });
});
