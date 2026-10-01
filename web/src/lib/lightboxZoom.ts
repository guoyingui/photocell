/**
 * 大图的连续缩放（规格 §5.1）。
 *
 * 抽成纯函数是因为「缩放中心跟随指针」这条算得对不对，看渲染结果是看不出来的——
 * 它只在指针偏离画面中心时才和错误实现分道扬镳，而那正是最容易写错、
 * 也最容易被"看着差不多"放过去的一种。
 */

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 8;
/** 贴合视口。1 就是 CSS 里 `object-fit: contain` 的那一档。 */
export const FIT = 1;

export interface Pan { x: number; y: number }
export interface ZoomState { scale: number; pan: Pan }
export interface Viewport { w: number; h: number }

export function clampScale(s: number): number {
  if (!Number.isFinite(s)) return Number.isNaN(s) ? FIT : ZOOM_MAX;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s));
}

/**
 * 把平移钳在「图片还有一部分在视口里」的范围内。
 *
 * scale <= 1 时图片没有超出视口，平移没有任何意义——允许它只会让图片飘走，
 * 而用户没有任何参照能把它拖回来。
 */
export function clampPan(pan: Pan, scale: number, viewport: Viewport): Pan {
  if (scale <= FIT) return { x: 0, y: 0 };
  const overflowX = (viewport.w * scale - viewport.w) / 2;
  const overflowY = (viewport.h * scale - viewport.h) / 2;
  return {
    x: Math.min(overflowX, Math.max(-overflowX, pan.x)),
    y: Math.min(overflowY, Math.max(-overflowY, pan.y)),
  };
}

/**
 * 以 `pointer`（视口坐标）为中心，把当前状态缩放 `factor` 倍。
 *
 * 数学上就一句话：指针相对视口中心的偏移量，在缩放前后要落在屏幕上的同一点。
 * 记指针相对中心的偏移为 d，缩放前该点在图片坐标系里的位置是 (d - pan) / scale，
 * 缩放后要它仍然落在 d 上，于是 pan' = d - (d - pan) * (scale' / scale)。
 */
export function zoomAt(
  state: ZoomState, factor: number, pointer: Pan, viewport: Viewport,
): ZoomState {
  const scale = clampScale(state.scale * factor);
  const ratio = scale / state.scale;
  const dx = pointer.x - viewport.w / 2;
  const dy = pointer.y - viewport.h / 2;
  const pan = {
    x: dx - (dx - state.pan.x) * ratio,
    y: dy - (dy - state.pan.y) * ratio,
  };
  return { scale, pan: clampPan(pan, scale, viewport) };
}
