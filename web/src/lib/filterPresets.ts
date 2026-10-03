import { normalizeFilters, type FilterState } from './filterState';
import { normalizeSort, type PhotoSort } from './photoSort';

export interface FilterPreset { id: string; name: string; filters: FilterState; sort: PhotoSort }
const keyFor = (scope: string) => `photocull.filter-presets.v1:${scope}`;
export function readPresets(scope: string): FilterPreset[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(keyFor(scope)) ?? '[]');
    if (!Array.isArray(list)) return [];
    const ids = new Set<string>();
    return list.flatMap((item) => {
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 100 || ids.has(item.id)
        || (Array.isArray(item.filters?.matchedIds) && item.filters.matchedIds.length > 5000)
        || typeof item.name !== 'string' || !item.name.trim()) return [];
      ids.add(item.id);
      return [{ id: item.id, name: item.name.trim().slice(0, 40), filters: normalizeFilters(item.filters), sort: normalizeSort(item.sort) }];
    }).slice(0, 20);
  } catch { return []; }
}

function writePresets(scope: string, presets: FilterPreset[]) {
  try { localStorage.setItem(keyFor(scope), JSON.stringify(presets)); }
  catch { throw new Error('浏览器未能保存预设，请检查存储空间或浏览器隐私设置后重试。'); }
  return presets;
}

export function savePreset(scope: string, name: string, filters: FilterState, sort: PhotoSort): FilterPreset[] {
  const title = name.trim();
  if (!title || title.length > 40) throw new Error('请输入 1–40 个字的预设名称。');
  if (filters.matchedIds && filters.matchedIds.length > 5000) throw new Error('文件名清单超过 5000 张，请缩小选区并重新匹配后保存预设。');
  const presets = readPresets(scope);
  if (presets.some((entry) => entry.name.toLocaleLowerCase() === title.toLocaleLowerCase())) throw new Error('已有同名预设，请更换名称。');
  if (presets.length >= 20) throw new Error('当前照片库最多保存 20 个预设，请先删除不用的预设。');
  return writePresets(scope, [...presets, { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    name: title, filters: normalizeFilters(filters), sort: normalizeSort(sort) }]);
}

export function deletePreset(scope: string, id: string) {
  return writePresets(scope, readPresets(scope).filter((preset) => preset.id !== id));
}
