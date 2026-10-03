import type { Annotation } from '../../../shared/annotations.js';
import type { Asset, AssetMeta } from '../types';
import type { Group } from './bursts';

export const SORT_OPTIONS = {
  'time-asc': '拍摄时间 · 从早到晚', 'time-desc': '拍摄时间 · 从晚到早',
  'name-asc': '文件名 · 正序', 'name-desc': '文件名 · 倒序',
  'rating-desc': '星级 · 从高到低', 'rating-asc': '星级 · 从低到高',
};
export type PhotoSort = keyof typeof SORT_OPTIONS;
export const normalizeSort = (value: unknown): PhotoSort => typeof value === 'string' && Object.hasOwn(SORT_OPTIONS, value) ? value as PhotoSort : 'time-asc';
const names = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

/** 先在组内排序，再按首张排列组；始终保留分组 key，避免展开状态失效。 */
export function sortPhotoGroups(groups: Group[], assets: Asset[], metas: Map<string, AssetMeta>, annotations: Record<string, Annotation>, sort: PhotoSort): Group[] {
  if (sort === 'time-asc') return groups;
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const direction = sort.endsWith('-desc') ? -1 : 1;
  const time = (id: string) => metas.get(id)?.time ?? byId.get(id)?.jpgMtimeMs ?? 0;
  const compare = (a: string, b: string) => {
    const left = byId.get(a), right = byId.get(b);
    const value = sort.startsWith('time-') ? time(a) - time(b)
      : sort.startsWith('rating-') ? (annotations[a]?.rating ?? 0) - (annotations[b]?.rating ?? 0)
        : names.compare(left?.stem ?? a, right?.stem ?? b);
    return direction * value || direction * names.compare(left?.dir ?? '', right?.dir ?? '') || (a < b ? -1 : a > b ? 1 : 0);
  };
  return groups.map((group) => ({ key: group.key, ids: [...group.ids].sort(compare) }))
    .sort((a, b) => compare(a.ids[0], b.ids[0]));
}
