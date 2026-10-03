import type { Asset, AssetMeta, PhotoFilters, MetaField } from '../types';

export const META_FIELDS: { key: MetaField; label: string }[] = [
  { key: 'iso', label: 'ISO' }, { key: 'fNumber', label: '光圈' },
  { key: 'exposureTime', label: '快门' }, { key: 'focalLength', label: '焦距' },
];

export function formatMeta(field: MetaField, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '未知';
  if (field === 'iso') return String(value);
  if (field === 'fNumber') return `f/${Number(value.toFixed(1))}`;
  if (field === 'focalLength') return `${Number(value.toFixed(1))} mm`;
  const denominator = Math.round(1 / value);
  return value < 1 && Math.abs(denominator * value - 1) < 0.015
    ? `1/${denominator} s` : `${Number(value.toFixed(3))} s`;
}

export function matchesPhoto(asset: Asset, meta: AssetMeta | undefined, filters: PhotoFilters): boolean {
  const query = filters.query.trim().toLocaleLowerCase();
  const names = [asset.id, asset.stem, ...[...asset.raws, asset.jpg ?? '']
    .map((name) => [asset.dir, name].filter(Boolean).join('/'))];
  if (query && !names.some((name) => name.toLocaleLowerCase().includes(query))) return false;
  return META_FIELDS.every(({ key }) => {
    const wanted = filters[key];
    if (!wanted) return true;
    const value = meta?.[key];
    const missing = value == null || !Number.isFinite(value) || value <= 0;
    return wanted === 'missing' ? missing : !missing && value === Number(wanted);
  });
}
