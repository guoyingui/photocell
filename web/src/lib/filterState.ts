import { LABELS, STAGES, type AnnotationFilters } from '../../../shared/annotations.js';
import type { OpinionFilter } from '../../../shared/opinions.js';
import type { FilterTab, PhotoFilters, ReviewFilter } from '../types';
import { META_FIELDS, formatMeta } from './photoFilters';

export interface FilterState {
  tab: FilterTab;
  dirFilter: string | null;
  clientFilter: string | null;
  photoFilters: PhotoFilters;
  reviewFilter: ReviewFilter;
  opinionFilter: OpinionFilter;
  annotationFilters: AnnotationFilters;
  matchedIds: string[] | null;
}

export function emptyFilters(): FilterState {
  return { tab: 'all', dirFilter: null, clientFilter: null,
    photoFilters: { query: '', iso: '', fNumber: '', exposureTime: '', focalLength: '' },
    reviewFilter: 'all', opinionFilter: 'all',
    annotationFilters: { rating: '', label: '', stage: '', keyword: '' }, matchedIds: null };
}

const text = (value: unknown, max = 1000) => typeof value === 'string' ? value.slice(0, max) : '';
const choice = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? value as T : fallback;

/** 浏览器存储同样需要校验；访客不能通过旧预设带入摄影师专属筛选。 */
export function normalizeFilters(value: unknown, admin = true): FilterState {
  const source = value && typeof value === 'object' ? value as Partial<FilterState> : {};
  const photoFilters = emptyFilters().photoFilters;
  photoFilters.query = text(source.photoFilters?.query);
  for (const { key } of META_FIELDS) {
    const raw = source.photoFilters?.[key];
    photoFilters[key] = raw === 'missing' ? raw
      : typeof raw === 'string' && Number.isFinite(Number(raw)) && Number(raw) > 0 ? raw.slice(0, 40) : '';
  }
  return {
    tab: choice(source.tab, admin ? ['all', 'pick', 'reject', 'none', 'hidden'] : ['all', 'pick', 'reject', 'none'], 'all'),
    dirFilter: typeof source.dirFilter === 'string' ? source.dirFilter.slice(0, 2000) : null,
    clientFilter: admin && typeof source.clientFilter === 'string' ? source.clientFilter.slice(0, 200) : null,
    photoFilters,
    reviewFilter: choice(source.reviewFilter, ['all', 'unseen', 'seen', 'undecided'], 'all'),
    opinionFilter: admin ? choice(source.opinionFilter, ['all', 'common', 'conflict', 'multiPick'], 'all') : 'all',
    annotationFilters: {
      rating: choice(source.annotationFilters?.rating, ['', '1', '2', '3', '4', '5'], ''),
      label: choice(source.annotationFilters?.label, ['', ...Object.keys(LABELS)], ''),
      stage: choice(source.annotationFilters?.stage, ['', ...Object.keys(STAGES)], ''),
      keyword: text(source.annotationFilters?.keyword),
    },
    matchedIds: Array.isArray(source.matchedIds)
      ? [...new Set(source.matchedIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 2000))].slice(0, 5000) : null,
  };
}

export interface FilterChip { key: string; label: string; patch: Partial<FilterState> }
export function filterChips(filters: FilterState, names: Map<string, string> = new Map()): FilterChip[] {
  const chips: FilterChip[] = [];
  const tabs = { all: '全部', pick: '收藏', reject: '排除', none: '未标记', hidden: '已隐藏' };
  if (filters.tab !== 'all') chips.push({ key: 'tab', label: `标记：${tabs[filters.tab]}`, patch: { tab: 'all' } });
  if (filters.dirFilter !== null) chips.push({ key: 'dir', label: `目录：${filters.dirFilter || '根目录'}`, patch: { dirFilter: null } });
  if (filters.clientFilter !== null) chips.push({ key: 'client', label: `成员：${filters.clientFilter === 'admin' ? '摄影师' : names.get(filters.clientFilter) ?? '已离开的成员'}`, patch: { clientFilter: null } });
  if (filters.photoFilters.query.trim()) chips.push({ key: 'query', label: `文件名：${filters.photoFilters.query}`, patch: { photoFilters: { ...filters.photoFilters, query: '' } } });
  for (const { key, label } of META_FIELDS) {
    const value = filters.photoFilters[key];
    if (value) chips.push({ key, label: `${label}：${value === 'missing' ? '未知' : formatMeta(key, Number(value))}`, patch: { photoFilters: { ...filters.photoFilters, [key]: '' } } });
  }
  const reviews = { all: '全部', unseen: '还没看', seen: '已看过', undecided: '看过但未标记' };
  if (filters.reviewFilter !== 'all') chips.push({ key: 'review', label: `浏览：${reviews[filters.reviewFilter]}`, patch: { reviewFilter: 'all' } });
  const opinions = { all: '全部意见', common: '共同收藏', conflict: '收藏与排除有争议', multiPick: '至少两人收藏' };
  if (filters.opinionFilter !== 'all') chips.push({ key: 'opinion', label: opinions[filters.opinionFilter], patch: { opinionFilter: 'all' } });
  const annotations = filters.annotationFilters;
  const labels: Record<keyof AnnotationFilters, string> = { rating: `至少 ${annotations.rating} 星`,
    label: `标签：${LABELS[annotations.label as keyof typeof LABELS]}`, stage: `阶段：${STAGES[annotations.stage as keyof typeof STAGES]}`, keyword: `关键词：${annotations.keyword}` };
  for (const key of Object.keys(annotations) as (keyof AnnotationFilters)[]) {
    if (annotations[key].trim()) chips.push({ key, label: labels[key], patch: { annotationFilters: { ...annotations, [key]: '' } } });
  }
  if (filters.matchedIds !== null) chips.push({ key: 'matched', label: `文件名清单：${filters.matchedIds.length} 个目标`, patch: { matchedIds: null } });
  return chips;
}
