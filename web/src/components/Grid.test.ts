import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Group } from '../lib/bursts';

// 捕获传给 useVirtualizer 的配置。仓库里没有 DOM 测试环境（vitest 的 environment
// 是 node），所以这里用 SSR 渲染跑一遍组件体：useMemo 会执行，useEffect 不会——
// 对"配置里到底有没有 getItemKey、它算出来的键是什么"这个问题足够了。
const options: Record<string, any>[] = [];
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: Record<string, any>) => {
    options.push(opts);
    return {
      getVirtualItems: () => [],
      getTotalSize: () => 0,
      measureElement: () => {},
    };
  },
}));

import { Grid } from './Grid';

const single = (id: string): Group => ({ key: id, ids: [id] });
const burst = (id: string, n: number): Group => ({
  key: id, ids: Array.from({ length: n }, (_, i) => `${id}-${i}`),
});

beforeEach(() => { options.length = 0; });

describe('Grid 的虚拟列表配置（分诊 h3）', () => {
  it('给虚拟列表配了 getItemKey，而不是让它退回行号', () => {
    renderToStaticMarkup(createElement(Grid, { groups: [single('a'), single('b')] }));
    expect(options).toHaveLength(1);
    expect(typeof options[0].getItemKey).toBe('function');
  });

  it('getItemKey 算出来的是内容派生的键，不同的行互不相同', () => {
    // SSR 下拿不到 ResizeObserver，cols 保持初值 6，所以要 6 个以上的组才会分出多行。
    const groups = [
      ...['a', 'b', 'c', 'd', 'e', 'f'].map(single),
      burst('g', 3), single('h'), single('i'),
    ];
    renderToStaticMarkup(createElement(Grid, { groups }));

    const { count, getItemKey } = options[0];
    expect(count).toBeGreaterThan(1);
    const keys = Array.from({ length: count }, (_, i) => getItemKey(i));
    expect(new Set(keys).size).toBe(keys.length);
    // 行号做键的话这里会是 0/1/2/…，键与内容毫无关系
    expect(keys.every((k: unknown) => typeof k === 'string' && /^(grid|exp):/.test(k as string)))
      .toBe(true);
    // 键跟着内容走：把最后一组去掉，前面几行的键一个都不变
    options.length = 0;
    renderToStaticMarkup(createElement(Grid, { groups: groups.slice(0, -1) }));
    const shorter = Array.from({ length: options[0].count }, (_, i) => options[0].getItemKey(i));
    expect(keys.slice(0, shorter.length)).toEqual(shorter);
  });
});
