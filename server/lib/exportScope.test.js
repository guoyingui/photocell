import { describe, expect, it } from 'vitest';
import { resolveExportScope } from '../../shared/exportScope.js';

const assets = [{ id: 'A', dir: '' }, { id: 'B', dir: 'day2' }, { id: 'C', dir: 'day2' }];
const data = {
  marks: { A: 'pick', B: 'reject' }, hidden: ['C'],
  contrib: { A: { bride: { mark: 'pick', at: 1 } }, B: { bride: { mark: 'pick', at: 1 }, admin: { mark: 'reject', at: 2 } } },
};
const picks = (scope) => {
  const result = resolveExportScope(assets, data, scope);
  return result.assets.filter((asset) => result.marks[asset.id] === 'pick').map((asset) => asset.id);
};

describe('导出范围', () => {
  it('旧请求仍导出全库最终收藏', () => expect(picks()).toEqual(['A']));
  it('客户收藏保留被其他人改判的照片', () => {
    expect(picks({ kind: 'client', clientId: 'bride' })).toEqual(['A', 'B']);
    expect(data.marks.B).toBe('reject');
  });
  it('当前筛选同时遵守目录、标签和客户', () => {
    expect(picks({ kind: 'filtered', dir: 'day2', tab: 'pick', clientId: 'bride' })).toEqual(['B']);
    expect(picks({ kind: 'filtered', tab: 'reject' })).toEqual([]);
    expect(picks({ kind: 'filtered', tab: 'hidden' })).toEqual([]);
  });
  it('手动选择不要求收藏，去重且不修改标记', () => {
    expect(picks({ kind: 'selection', assetIds: ['B', 'B'] })).toEqual(['B']);
    expect(data.marks.B).toBe('reject');
  });
  it.each([null, { kind: 'unknown' }, { kind: 'client' }, { kind: 'filtered', tab: 'bad' },
    { kind: 'selection', assetIds: [] }, { kind: 'selection', assetIds: ['../other'] }])(
    '无效范围不能退回导出全库：%j', (scope) => {
      expect(() => picks(scope)).toThrow();
      try { picks(scope); } catch (err) { expect(err.status).toBe(400); }
    },
  );
});
