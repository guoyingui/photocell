import { describe, expect, it } from 'vitest';
import { collectIdsInRect, farEnough, intersects, MARQUEE_THRESHOLD, normRect } from './marquee';

describe('normRect', () => {
  it('从右下往左上拖，仍然得到左上角 + 正的宽高', () => {
    expect(normRect(10, 20, 4, 8)).toEqual({ x: 4, y: 8, w: 6, h: 12 });
  });
});

describe('intersects', () => {
  const box = { x: 10, y: 10, w: 20, h: 20 };
  it('完全包住算相交', () => {
    expect(intersects(box, { left: 12, top: 12, width: 5, height: 5 })).toBe(true);
  });
  it('只擦到边算相交', () => {
    expect(intersects(box, { left: 29, top: 10, width: 10, height: 10 })).toBe(true);
  });
  it('完全在外面不相交', () => {
    expect(intersects(box, { left: 40, top: 10, width: 5, height: 5 })).toBe(false);
  });
});

describe('farEnough', () => {
  it('小于阈值不算拖', () => {
    expect(farEnough(0, 0, MARQUEE_THRESHOLD - 1, 0)).toBe(false);
  });
  it('达到阈值算拖', () => {
    expect(farEnough(0, 0, MARQUEE_THRESHOLD, 0)).toBe(true);
  });
});

describe('collectIdsInRect', () => {
  it('只收集落在矩形里、带 data-id 的 .thumb', () => {
    const root = {
      querySelectorAll(selector: string) {
        expect(selector).toBe('.thumb[data-id]');
        return [
          { dataset: { id: 'a' }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }) },
          { dataset: { id: 'b' }, getBoundingClientRect: () => ({ left: 50, top: 50, width: 10, height: 10 }) },
        ];
      },
    } as unknown as ParentNode;
    expect(collectIdsInRect(root, { x: 0, y: 0, w: 20, h: 20 })).toEqual(['a']);
  });
});
