import path from 'node:path';
import exifr from 'exifr';
import pLimit from 'p-limit';
import { assertWithin } from './safepath.js';

const EXIF_PICK = [
  'DateTimeOriginal', 'SubSecTimeOriginal', 'CreateDate', 'Orientation',
  'Model', 'BodySerialNumber', 'ISO', 'FNumber', 'ExposureTime', 'FocalLength',
];

function toTime(value) {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function subSecMs(value) {
  if (value === undefined || value === null) return 0;
  const digits = String(value).replace(/\D/g, '').slice(0, 3);
  if (!digits) return 0;
  return Number(digits.padEnd(3, '0'));
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 纯函数：把 exifr 的原始输出归一化成 AssetMeta（不含 id）。 */
export function normalizeMeta(raw, fallbackMtimeMs, dir) {
  const r = raw || {};
  let time = toTime(r.DateTimeOriginal);
  let timeSource = 'exif';
  if (time !== null) {
    time += subSecMs(r.SubSecTimeOriginal);
  } else {
    time = toTime(r.CreateDate);
    timeSource = 'createDate';
  }
  if (time === null) {
    time = fallbackMtimeMs;
    timeSource = 'mtime';
  }

  const orientation =
    Number.isInteger(r.Orientation) && r.Orientation >= 1 && r.Orientation <= 8 ? r.Orientation : 1;

  const body = r.Model
    ? `${r.Model}|${r.BodySerialNumber ?? ''}`
    : r.BodySerialNumber
      ? `|${r.BodySerialNumber}`
      : `dir:${dir}`;

  return {
    time, timeSource, orientation, body,
    iso: num(r.ISO), fNumber: num(r.FNumber),
    exposureTime: num(r.ExposureTime), focalLength: num(r.FocalLength),
  };
}

/**
 * 并发读取全部资产的元数据。只解析 EXIF 段，不解码像素。
 * 优先 JPG，纯 RAW 尝试读取容器的 EXIF；无法读取时退化到 mtime。
 */
export async function readAllMeta(root, assets, { concurrency = 8, onBatch } = {}) {
  const limit = pLimit(concurrency);
  const out = new Array(assets.length);
  let pending = [];

  await Promise.all(assets.map((asset, i) => limit(async () => {
    let raw = null;
    const filename = asset.jpg ?? asset.raws?.[0];
    if (filename) {
      const reader = new exifr.Exifr({ pick: EXIF_PICK, translateValues: false });
      try {
        const abs = await assertWithin([root], path.join(root, ...asset.dir.split('/').filter(Boolean), filename));
        await reader.read(abs);
        raw = await reader.parse();
      } catch {
        raw = null; // 损坏或无 EXIF：静默退化，不阻断整场扫描
      } finally {
        await reader.file?.close?.();
      }
    }
    // 兜底时间源：有 JPG 就用 JPG 的 mtime，没有 JPG（孤儿 RAW）就用扫描时记下的
    // 第一个 RAW 的 mtime。以前这里恒取 jpgMtimeMs，孤儿 RAW 因此 time=0，
    // 在按时间排序的网格里整批堆到最前面，日期一律显示 1970。
    const fallbackMtimeMs = asset.jpg ? asset.jpgMtimeMs : (asset.rawMtimeMs ?? 0);
    out[i] = { id: asset.id, ...normalizeMeta(raw, fallbackMtimeMs, asset.dir) };
    if (onBatch) {
      pending.push(out[i]);
      if (pending.length >= 200) { onBatch(pending); pending = []; }
    }
  })));

  if (onBatch && pending.length) onBatch(pending);
  return out;
}
