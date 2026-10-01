export type Mark = 'pick' | 'reject';

export interface Asset {
  id: string;
  dir: string;
  stem: string;
  raws: string[];
  jpg: string | null;
  jpgSize: number;
  jpgMtimeMs: number;
}

export interface AssetMeta {
  id: string;
  time: number;
  timeSource: 'exif' | 'createDate' | 'mtime';
  orientation: number;
  body: string;
  iso: number | null;
  fNumber: number | null;
  exposureTime: number | null;
  focalLength: number | null;
}

export interface Settings {
  burstThresholdMs: number;
  /** 网格里一个格子的像素宽度，120–420。服务端 store.js 负责钳制与迁移。 */
  cellWidth: number;
  sort: 'time' | 'name';
}

/** 与服务端 server/lib/store.js 的 CELL_WIDTH_MIN / MAX 必须一致。 */
export const CELL_WIDTH_MIN = 120;
export const CELL_WIDTH_MAX = 420;

export type FilterTab = 'all' | 'pick' | 'reject' | 'none' | 'hidden';
