import { expect, it } from 'vitest';
import { sortPhotoGroups } from './photoSort';
import { flatOrder } from './order';
import { EMPTY_ANNOTATION } from '../../../shared/annotations.js';
import type { Asset, AssetMeta } from '../types';

const assets: Asset[] = ['IMG_10', 'IMG_2', 'IMG_3'].map((stem, index) => ({ id: stem, stem, dir: '', raws: [], jpg: `${stem}.JPG`, jpgSize: 1, jpgMtimeMs: index + 1 }));
const groups = [{ key: 'burst', ids: ['IMG_10', 'IMG_2'] }, { key: 'single', ids: ['IMG_3'] }];

it('文件名采用自然排序，保留连拍组 key 与原始数据，并同步折叠和展开浏览顺序', () => {
  const sorted = sortPhotoGroups(groups, assets, new Map(), {}, 'name-asc');
  expect(sorted).toEqual([{ key: 'burst', ids: ['IMG_2', 'IMG_10'] }, { key: 'single', ids: ['IMG_3'] }]);
  expect(flatOrder(sorted, new Set())).toEqual(['IMG_2', 'IMG_3']);
  expect(flatOrder(sorted, new Set(['burst']))).toEqual(['IMG_2', 'IMG_10', 'IMG_3']);
  expect(groups[0].ids).toEqual(['IMG_10', 'IMG_2']);
  expect(sortPhotoGroups(groups, assets, new Map(), {}, 'name-desc')[0].ids).toEqual(['IMG_10', 'IMG_2']);
});
it('时间倒序优先 EXIF，缺失时使用文件时间，默认时间正序复用既有分组', () => {
  const metas = new Map([['IMG_10', { time: 100 } as AssetMeta]]);
  expect(sortPhotoGroups(groups, assets, metas, {}, 'time-desc').map((group) => group.key)).toEqual(['burst', 'single']);
  expect(sortPhotoGroups(groups, assets, metas, {}, 'time-asc')).toBe(groups);
});
it('星级排序把缺失星级作为 0，组内同序，排序不引入筛掉的照片', () => {
  const annotations = { IMG_2: { ...EMPTY_ANNOTATION, rating: 5 }, IMG_3: { ...EMPTY_ANNOTATION, rating: 3 } };
  expect(sortPhotoGroups(groups, assets, new Map(), annotations, 'rating-desc')[0].ids).toEqual(['IMG_2', 'IMG_10']);
  expect(sortPhotoGroups([{ key: 'burst', ids: ['IMG_10'] }, groups[1]], assets, new Map(), annotations, 'rating-desc').flatMap((group) => group.ids)).toEqual(['IMG_3', 'IMG_10']);
  expect(sortPhotoGroups(groups, assets, new Map(), annotations, 'rating-asc')[0].ids).toEqual(['IMG_10', 'IMG_2']);
});
