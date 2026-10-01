import { describe, it, expect } from 'vitest';
import { groupBursts, type BurstItem } from './bursts';

const item = (id: string, time: number, body = 'R5|SN1',
              timeSource: BurstItem['timeSource'] = 'exif'): BurstItem =>
  ({ id, time, timeSource, body });

describe('groupBursts', () => {
  it('空输入返回空数组', () => {
    expect(groupBursts([], 1000)).toEqual([]);
  });

  it('单张返回一个长度为 1 的组', () => {
    expect(groupBursts([item('a', 0)], 1000)).toEqual([{ key: 'a', ids: ['a'] }]);
  });

  it('间隔小于阈值且同机身的相邻两张合成一组', () => {
    const groups = groupBursts([item('a', 0), item('b', 500)], 1000);
    expect(groups).toEqual([{ key: 'a', ids: ['a', 'b'] }]);
  });

  it('间隔恰好等于阈值仍算同组', () => {
    expect(groupBursts([item('a', 0), item('b', 1000)], 1000)[0].ids).toEqual(['a', 'b']);
  });

  it('间隔超过阈值则分开', () => {
    const groups = groupBursts([item('a', 0), item('b', 1001)], 1000);
    expect(groups.map((g) => g.ids)).toEqual([['a'], ['b']]);
  });

  it('链式合并：a-b 近、b-c 近，三张合成一组', () => {
    const groups = groupBursts([item('a', 0), item('b', 400), item('c', 800)], 500);
    expect(groups).toHaveLength(1);
    expect(groups[0].ids).toEqual(['a', 'b', 'c']);
  });

  it('不同机身即使时间重合也不合并', () => {
    const groups = groupBursts([item('a', 0, 'R5|SN1'), item('b', 10, 'Z9|SN2')], 1000);
    expect(groups.map((g) => g.ids)).toEqual([['a'], ['b']]);
  });

  it('时间戳完全相同且同机身仍合并', () => {
    expect(groupBursts([item('a', 500), item('b', 500)], 1000)[0].ids).toEqual(['a', 'b']);
  });

  it('timeSource 为 mtime 的照片永不参与合并', () => {
    const groups = groupBursts(
      [item('a', 0, 'R5|SN1', 'mtime'), item('b', 100, 'R5|SN1', 'mtime')], 1000);
    expect(groups.map((g) => g.ids)).toEqual([['a'], ['b']]);
  });

  it('一端是 mtime 也不合并', () => {
    const groups = groupBursts(
      [item('a', 0, 'R5|SN1', 'exif'), item('b', 100, 'R5|SN1', 'mtime')], 1000);
    expect(groups).toHaveLength(2);
  });

  it('createDate 来源可以参与合并', () => {
    const groups = groupBursts(
      [item('a', 0, 'R5|SN1', 'createDate'), item('b', 100, 'R5|SN1', 'createDate')], 1000);
    expect(groups[0].ids).toEqual(['a', 'b']);
  });

  it('乱序输入会先按时间排序', () => {
    const groups = groupBursts([item('c', 900), item('a', 0), item('b', 400)], 500);
    expect(groups[0].ids).toEqual(['a', 'b', 'c']);
  });

  it('时间相同时按 id 稳定排序', () => {
    const groups = groupBursts([item('b', 100), item('a', 100)], 0);
    expect(groups[0].ids).toEqual(['a', 'b']);
  });

  it('阈值为 0 时只有时间完全相同的才合并', () => {
    const groups = groupBursts([item('a', 100), item('b', 100), item('c', 101)], 0);
    expect(groups.map((g) => g.ids)).toEqual([['a', 'b'], ['c']]);
  });

  it('跨天的两张不会因为阈值大而误合并', () => {
    const day = 86_400_000;
    const groups = groupBursts([item('a', 0), item('b', day)], 5000);
    expect(groups).toHaveLength(2);
  });

  it('每个输入项都恰好出现在一个组里', () => {
    const items = Array.from({ length: 50 }, (_, i) => item(`x${i}`, i * 300));
    const groups = groupBursts(items, 500);
    const flat = groups.flatMap((g) => g.ids);
    expect(flat).toHaveLength(50);
    expect(new Set(flat).size).toBe(50);
  });

  it('组的 key 是组内第一张的 id', () => {
    const groups = groupBursts([item('a', 0), item('b', 100)], 1000);
    expect(groups[0].key).toBe('a');
  });
});
