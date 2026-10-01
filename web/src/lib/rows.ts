import type { Group } from './bursts';

export type Row =
  | { kind: 'grid'; groups: Group[] }
  | { kind: 'expanded'; group: Group };

/** 把组切成行；展开的连拍组独占一整行。 */
export function buildRows(groups: Group[], cols: number, expanded: Set<string>): Row[] {
  const out: Row[] = [];
  let bucket: Group[] = [];
  const flush = () => { if (bucket.length) { out.push({ kind: 'grid', groups: bucket }); bucket = []; } };

  for (const group of groups) {
    if (group.ids.length > 1 && expanded.has(group.key)) {
      flush();
      out.push({ kind: 'expanded', group });
    } else {
      bucket.push(group);
      if (bucket.length === cols) flush();
    }
  }
  flush();
  return out;
}

/**
 * 虚拟列表的行标识。必须是内容派生的，不能用行号。
 *
 * 行高不等（展开的连拍行比普通行矮）+ measureElement 缓存量出来的实际高度，
 * 如果键是行号，那么展开一个组、切一次筛选、拖一下阈值滑块之后，同一个行号
 * 对应的已经是另一批内容了，虚拟列表却会拿旧行号的缓存高度去摆位——表现就是
 * 快速滚动或拖动滚动条时行与行之间跳动、留白。
 *
 * 组的 key 在一次分组结果里唯一，且一个组只会出现在一行里（要么被塞进某个 bucket，
 * 要么独占一行展开），所以"这一行的第一个组的 key"足以唯一标识一行；两种行加不同
 * 前缀，避免同一个组展开前后拿到同一个键（那正是需要重新测量的时刻）。
 */
export function rowKey(row: Row): string {
  return row.kind === 'expanded' ? `exp:${row.group.key}` : `grid:${row.groups[0].key}`;
}
