export const STAGES = { initial: '初选', retouch: '精修', delivery: '交付' };
export const LABELS = { none: '无标签', red: '红色', yellow: '黄色', green: '绿色', blue: '蓝色', purple: '紫色' };
export const EMPTY_ANNOTATION = { rating: 0, label: 'none', stage: 'initial', keywords: [] };

export function normalizeAnnotation(value) {
  return {
    rating: Number.isInteger(value?.rating) && value.rating >= 0 && value.rating <= 5 ? value.rating : 0,
    label: Object.hasOwn(LABELS, value?.label) ? value.label : 'none',
    stage: Object.hasOwn(STAGES, value?.stage) ? value.stage : 'initial',
    keywords: Array.isArray(value?.keywords) ? [...new Set(value.keywords
      .filter((word) => typeof word === 'string').map((word) => word.trim()).filter(Boolean))].slice(0, 10).map((word) => word.slice(0, 50)) : [],
  };
}

export function matchesAnnotation(value, filters) {
  const entry = normalizeAnnotation(value);
  return (!filters.rating || entry.rating >= Number(filters.rating))
    && (!filters.label || entry.label === filters.label)
    && (!filters.stage || entry.stage === filters.stage)
    && (!filters.keyword || entry.keywords.some((word) => word.toLocaleLowerCase().includes(filters.keyword.trim().toLocaleLowerCase())));
}
