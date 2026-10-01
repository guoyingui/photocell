import { describe, it, expect } from 'vitest';
import { buildRows, rowKey } from './rows';
import type { Group } from './bursts';

const single = (id: string): Group => ({ key: id, ids: [id] });
const burst = (id: string, n: number): Group => ({
  key: id, ids: Array.from({ length: n }, (_, i) => `${id}-${i}`),
});

describe('buildRows', () => {
  it('按列数装桶', () => {
    const rows = buildRows([single('a'), single('b'), single('c')], 2, new Set());
    expect(rows).toEqual([
      { kind: 'grid', groups: [single('a'), single('b')] },
      { kind: 'grid', groups: [single('c')] },
    ]);
  });

  it('展开的连拍组独占一行，并把当前的桶先冲掉', () => {
    const g = burst('b', 3);
    const rows = buildRows([single('a'), g, single('c')], 3, new Set(['b']));
    expect(rows.map((r) => r.kind)).toEqual(['grid', 'expanded', 'grid']);
  });

  it('只有一张的组即使在 expanded 里也不展开', () => {
    const rows = buildRows([single('a')], 3, new Set(['a']));
    expect(rows).toEqual([{ kind: 'grid', groups: [single('a')] }]);
  });

  it('空输入返回空数组', () => {
    expect(buildRows([], 4, new Set())).toEqual([]);
  });
});

describe('rowKey — 虚拟列表的行标识', () => {
  it('一次分组结果里的行键互不相同', () => {
    const groups = [single('a'), burst('b', 3), single('c'), single('d'), burst('e', 2)];
    const rows = buildRows(groups, 2, new Set(['b']));
    const keys = rows.map(rowKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('内容没变的行，在别的组展开、行号整体后移之后仍然拿到同一个键', () => {
    // 这正是行号做键会出错的场景：行高不等（展开行更矮）+ measureElement 缓存，
    // 行号一移位，旧行号量出来的高度就会被套到新内容上，滚动时行与行之间跳动。
    const groups = [single('a'), burst('b', 3), single('c'), single('d')];
    const before = buildRows(groups, 2, new Set());
    const after = buildRows(groups, 2, new Set(['b']));

    // [a,b] [c,d]  →  [a] exp(b) [c,d]：装着 c、d 的那一行从第 1 行挪到了第 2 行
    expect(before[1]).toEqual(after[2]);
    expect(before.indexOf(before[1])).not.toBe(after.indexOf(after[2]));
    expect(rowKey(before[1])).toBe(rowKey(after[2]));
  });

  it('同一个组展开前后拿到不同的键（这时候本来就该重新测量）', () => {
    const g = burst('b', 3);
    const collapsed = buildRows([g], 3, new Set());
    const expanded = buildRows([g], 3, new Set(['b']));
    expect(rowKey(collapsed[0])).not.toBe(rowKey(expanded[0]));
  });
});
