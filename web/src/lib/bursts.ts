import type { AssetMeta } from '../types';

export interface BurstItem {
  id: string;
  time: number;
  timeSource: AssetMeta['timeSource'];
  body: string;
}

export interface Group {
  key: string;
  ids: string[];
}

/**
 * 相邻两张合成同组，需同时满足：
 *   1. 时间差 <= 阈值
 *   2. 同一机身（Model+序列号；都缺失时退化为 dir:<目录>）
 *   3. 两端的时间都不是 mtime 回退 —— 文件 mtime 精度不足以判连拍
 *
 * 返回的组覆盖全部输入，单张也是一个长度 1 的组，
 * 这样网格渲染可以统一按「一个格子 = 一个组」处理。
 */
export function groupBursts(items: BurstItem[], thresholdMs: number): Group[] {
  if (items.length === 0) return [];

  const sorted = [...items].sort((a, b) =>
    a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const groups: Group[] = [];
  let current: BurstItem[] = [sorted[0]];

  const joinable = (prev: BurstItem, next: BurstItem) =>
    next.time - prev.time <= thresholdMs &&
    prev.body === next.body &&
    prev.timeSource !== 'mtime' &&
    next.timeSource !== 'mtime';

  for (let i = 1; i < sorted.length; i++) {
    if (joinable(sorted[i - 1], sorted[i])) {
      current.push(sorted[i]);
    } else {
      groups.push({ key: current[0].id, ids: current.map((x) => x.id) });
      current = [sorted[i]];
    }
  }
  groups.push({ key: current[0].id, ids: current.map((x) => x.id) });
  return groups;
}
