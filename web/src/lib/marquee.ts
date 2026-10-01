/** 框选矩形。坐标相对视口（getBoundingClientRect 同一套）。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 把按下点和当前点收成左上 + 宽高，方向无所谓。 */
export function normRect(x0: number, y0: number, x1: number, y1: number): Rect {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  return { x, y, w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

export function intersects(a: Rect, b: { left: number; top: number; width: number; height: number }): boolean {
  return a.x < b.left + b.width
    && a.x + a.w > b.left
    && a.y < b.top + b.height
    && a.y + a.h > b.top;
}

/** 框选结束后吞掉随后那次 click，避免拖完又把选区塌成一格。 */
let swallowNextClick = false;
export function armClickSwallow(): void { swallowNextClick = true; }
export function consumeClickSwallow(): boolean {
  const v = swallowNextClick;
  swallowNextClick = false;
  return v;
}

/** 走过这么多像素才算拖，否则当成点击。 */
export const MARQUEE_THRESHOLD = 4;

export function farEnough(x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  return dx * dx + dy * dy >= MARQUEE_THRESHOLD * MARQUEE_THRESHOLD;
}

/** 当前 DOM 里与矩形相交的缩略图 id。虚拟列表只挂得上可见的格子。 */
export function collectIdsInRect(root: ParentNode, rect: Rect): string[] {
  const ids: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('.thumb[data-id]')) {
    if (intersects(rect, el.getBoundingClientRect())) {
      const id = el.dataset.id;
      if (id) ids.push(id);
    }
  }
  return ids;
}
