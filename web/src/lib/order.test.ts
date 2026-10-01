import { describe, it, expect } from 'vitest';
import { flatOrder } from './order';
import type { Group } from './bursts';

const g = (key: string, ids: string[]): Group => ({ key, ids });

describe('flatOrder', () => {
  it('全是单张时按组顺序展开', () => {
    expect(flatOrder([g('a', ['a']), g('b', ['b'])], new Set())).toEqual(['a', 'b']);
  });

  it('未展开的连拍组只暴露第一张', () => {
    expect(flatOrder([g('a', ['a', 'a2', 'a3']), g('b', ['b'])], new Set())).toEqual(['a', 'b']);
  });

  it('展开的连拍组暴露全部', () => {
    expect(flatOrder([g('a', ['a', 'a2', 'a3'])], new Set(['a']))).toEqual(['a', 'a2', 'a3']);
  });

  it('展开与未展开混排时顺序正确', () => {
    const groups = [g('a', ['a', 'a2']), g('b', ['b']), g('c', ['c', 'c2', 'c3'])];
    expect(flatOrder(groups, new Set(['c']))).toEqual(['a', 'b', 'c', 'c2', 'c3']);
  });

  it('单张组即使被标记为展开也只出现一次', () => {
    expect(flatOrder([g('a', ['a'])], new Set(['a']))).toEqual(['a']);
  });

  it('空输入返回空数组', () => {
    expect(flatOrder([], new Set())).toEqual([]);
  });
});
