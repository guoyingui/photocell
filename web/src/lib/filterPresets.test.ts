import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deletePreset, readPresets, savePreset } from './filterPresets';
import { emptyFilters, normalizeFilters } from './filterState';
import { readWorkspace, useWorkspace } from '../store/workspace';
import { useView } from '../store/view';

let data: Map<string, string>;
beforeEach(() => {
  data = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
  useView.getState().reset(); useWorkspace.setState({ sort: 'time-asc', collapsed: { capture: false, opinions: false, annotations: false }, storageError: '' });
});
afterEach(() => { vi.unstubAllGlobals(); });

it('预设按库和身份隔离，复制条件与排序，不存光标、选区或其他视图方法', () => {
  const filters = { ...emptyFilters(), dirFilter: 'day1', reviewFilter: 'unseen' as const };
  const saved = savePreset('admin:root1', '未看', filters, 'name-desc');
  filters.photoFilters.query = 'changed';
  expect(readPresets('admin:root1')[0].filters.photoFilters.query).toBe('');
  expect(readPresets('admin:root1')[0].sort).toBe('name-desc');
  expect(readPresets('admin:root2')).toEqual([]); expect(readPresets('user:alice')).toEqual([]);
  expect(() => savePreset('admin:root1', ' 未看 ', filters, 'time-asc')).toThrow('同名');
  deletePreset('admin:root1', saved[0].id); expect(readPresets('admin:root1')).toEqual([]);
});
it('损坏存储会降级，保存失败会报错，不谎报成功', () => {
  data.set('photocull.filter-presets.v1:x', 'not-json'); expect(readPresets('x')).toEqual([]);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); } });
  expect(() => savePreset('x', '预设', emptyFilters(), 'time-asc')).toThrow('未能保存');
  useWorkspace.getState().toggleSection('capture');
  expect(useWorkspace.getState().collapsed.capture).toBe(true);
  expect(useWorkspace.getState().storageError).toContain('未能记住');
});
it('过大的匹配范围不能被保存成截断清单，也不能从损坏预设中恢复', () => {
  const filters = { ...emptyFilters(), matchedIds: Array.from({ length: 5001 }, (_, index) => `photo-${index}`) };
  expect(() => savePreset('x', '全部匹配', filters, 'time-asc')).toThrow('超过 5000');
  expect(readPresets('x')).toEqual([]);
  data.set('photocull.filter-presets.v1:x', JSON.stringify([{ id: 'oversize', name: '旧清单', filters }]));
  expect(readPresets('x')).toEqual([]);
});
it('恢复预设不会携带访客无权使用的筛选，空的文件名结果保持为空而非全库', () => {
  const safe = normalizeFilters({ ...emptyFilters(), tab: 'hidden', clientFilter: 'other', opinionFilter: 'common', matchedIds: [] }, false);
  expect(safe.tab).toBe('all'); expect(safe.clientFilter).toBeNull(); expect(safe.opinionFilter).toBe('all');
  useView.getState().openCompare('a', 'b');
  useView.getState().applyFilters(safe);
  expect(useView.getState().matchedIds).toEqual([]); expect(useView.getState().selection.size).toBe(0);
  expect(useView.getState().compare).toBeNull();
  useView.getState().clearFilters(); expect(useView.getState().matchedIds).toBeNull();
});
it('折叠与排序可重新读取；改排序清除旧选区和大图，不改变筛选条件', () => {
  useView.getState().setPhotoFilters({ iso: '800' }); useView.getState().openLightbox('a');
  useWorkspace.getState().toggleSection('annotations'); useWorkspace.getState().setSort('rating-desc');
  expect(readWorkspace()).toEqual({ sort: 'rating-desc', collapsed: { capture: false, opinions: false, annotations: true } });
  expect(useView.getState().lightbox).toBeNull(); expect(useView.getState().selection.size).toBe(0);
  expect(useView.getState().photoFilters.iso).toBe('800');
});
