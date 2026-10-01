import { describe, it, expect } from 'vitest';
import { clampScale, clampPan, zoomAt, ZOOM_MIN, ZOOM_MAX, FIT } from './lightboxZoom';

const viewport = { w: 1000, h: 800 };

describe('clampScale', () => {
  it('钳制在 0.5 到 8 之间', () => {
    expect(clampScale(0.1)).toBe(ZOOM_MIN);
    expect(clampScale(100)).toBe(ZOOM_MAX);
    expect(clampScale(2.5)).toBe(2.5);
  });

  it('非有限值回落到贴合', () => {
    expect(clampScale(NaN)).toBe(FIT);
    expect(clampScale(Infinity)).toBe(ZOOM_MAX);
  });
});

describe('clampPan', () => {
  it('贴合或更小时平移一律归零', () => {
    // 图片没有超出视口，平移没有任何意义；允许它反而会让图片飘走。
    expect(clampPan({ x: 300, y: 200 }, 1, viewport)).toEqual({ x: 0, y: 0 });
    expect(clampPan({ x: 300, y: 200 }, 0.6, viewport)).toEqual({ x: 0, y: 0 });
  });

  it('放大之后允许在溢出范围内平移', () => {
    // 2× 时图片是 2000×1600，溢出量各 500 / 400，所以平移上限就是这两个数。
    expect(clampPan({ x: 200, y: 100 }, 2, viewport)).toEqual({ x: 200, y: 100 });
  });

  it('超出溢出范围的平移被钳到边界，图片不会被完全拖出视口', () => {
    expect(clampPan({ x: 9999, y: -9999 }, 2, viewport)).toEqual({ x: 500, y: -400 });
  });
});

describe('zoomAt', () => {
  it('以视口正中为中心放大时不产生平移', () => {
    const next = zoomAt({ scale: 1, pan: { x: 0, y: 0 } }, 2, { x: 500, y: 400 }, viewport);
    expect(next.scale).toBe(2);
    expect(next.pan).toEqual({ x: 0, y: 0 });
  });

  it('以偏离中心的点放大时，那个点在屏幕上的位置保持不动', () => {
    // 这是"缩放中心跟随指针"的定义。做不到这一点的话，鼠标指着一张脸滚轮放大，
    // 放大出来的是别的地方，用户得再拖回来。
    const pointer = { x: 700, y: 400 };
    const next = zoomAt({ scale: 1, pan: { x: 0, y: 0 } }, 2, pointer, viewport);
    // 指针相对中心偏 +200；放大 2 倍后该点会跑到 +400，所以要往回补 -200。
    expect(next.pan.x).toBe(-200);
    expect(next.pan.y).toBe(0);
  });

  it('缩放回到贴合时平移一并归零', () => {
    const next = zoomAt({ scale: 2, pan: { x: 300, y: 200 } }, 0.5, { x: 500, y: 400 }, viewport);
    expect(next.scale).toBe(1);
    expect(next.pan).toEqual({ x: 0, y: 0 });
  });

  it('放大到上限之后再滚也不会越界', () => {
    const next = zoomAt({ scale: ZOOM_MAX, pan: { x: 0, y: 0 } }, 4, { x: 500, y: 400 }, viewport);
    expect(next.scale).toBe(ZOOM_MAX);
  });
});
