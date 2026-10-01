import type { Group } from './bursts';

/**
 * 键盘遍历顺序必须和眼睛看到的一致：未展开的连拍组在网格里只占一格、
 * 只露出第一张，所以方向键也只应该停在第一张上。
 */
export function flatOrder(groups: Group[], expanded: Set<string>): string[] {
  const out: string[] = [];
  for (const group of groups) {
    if (group.ids.length > 1 && expanded.has(group.key)) out.push(...group.ids);
    else out.push(group.ids[0]);
  }
  return out;
}
