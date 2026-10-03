import type { Asset } from '../types';

export const FILE_LIST_LIMIT = 5000;
export const FILE_LIST_BYTES = 2 * 1024 * 1024;
const HEADER_NAMES = ['filename', '文件名', '照片文件名', '相对路径', 'rawfile', 'jpgfile', 'file', 'name', '名称', 'assetid'];
const headerName = (value: string) => value.trim().toLocaleLowerCase().replace(/[ _-]/g, '');

/** TXT / CSV / Excel 粘贴的制表符表格；CSV 引号内的分隔符、换行保持为文件名内容。 */
export function parseFilenameList(input: string, headerOverride?: boolean) {
  if (input.length > FILE_LIST_BYTES) throw new Error('清单过大，请分批导入，每批不超过 2 MB、5000 行。');
  const source = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let quoted = false, delimiter = '', commas = 0, tabs = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted) {
      if (char === ',') commas++;
      if (char === '\t') tabs++;
      if (char === '\n' && (commas || tabs)) break;
    }
  }
  delimiter = tabs ? '\t' : commas ? ',' : '';
  const rows: string[][] = [];
  let row: string[] = [], cell = '', closed = false;
  quoted = false;
  const pushCell = () => { row.push(cell.trim()); cell = ''; closed = false;
    if (row.length > 100) throw new Error('表格列数过多，请只保留文件名等必要列后导入。'); };
  const pushRow = () => { pushCell(); if (row.some(Boolean)) rows.push(row); row = [];
    if (rows.length > FILE_LIST_LIMIT + 1) throw new Error('一次最多匹配 5000 行，请拆分清单。'); };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else cell += char;
    } else if (char === delimiter) pushCell();
    else if (char === '\n') pushRow();
    else if (char === '"' && !cell.trim() && !closed) { cell = ''; quoted = true; }
    else if (closed && char.trim()) throw new Error('CSV 引号格式不正确，请检查文件名列的双引号。');
    else if (!closed) cell += char;
  }
  if (quoted) throw new Error('CSV 引号未闭合，请检查清单后重新匹配。');
  pushRow();
  const first = rows[0] ?? [];
  const header = first.map(headerName);
  const autoColumn = HEADER_NAMES.map((name) => header.indexOf(name)).find((index) => index >= 0) ?? -1;
  const hasHeader = headerOverride ?? (autoColumn >= 0 && rows.length > 1);
  const data = hasHeader ? rows.slice(1) : rows;
  if (data.length > FILE_LIST_LIMIT) throw new Error('一次最多匹配 5000 行，请拆分清单。');
  const count = Math.max(1, ...rows.map((entry) => entry.length));
  return { rows: data, hasHeader, columns: Array.from({ length: count }, (_, index) => hasHeader ? first[index] || `第 ${index + 1} 列` : `第 ${index + 1} 列`),
    defaultColumn: Math.max(0, autoColumn) };
}

const normalizeName = (name: string) => name.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').normalize('NFC').toLocaleLowerCase();
export interface FilenameMatch { row: number; input: string; candidates: Asset[] }

/** 精确匹配名字或相对路径；RAW/JPG 配对只算一张，同名跨目录必须由用户消歧。 */
export function matchFilenames(names: string[], assets: Asset[], hidden: ReadonlySet<string>): FilenameMatch[] {
  const index = new Map<string, Map<string, Asset>>();
  for (const asset of assets) {
    if (hidden.has(asset.id)) continue;
    for (const name of [asset.stem, ...asset.raws, ...(asset.jpg ? [asset.jpg] : [])]) {
      for (const key of new Set([normalizeName(name), normalizeName([asset.dir, name].filter(Boolean).join('/'))])) {
        let entries = index.get(key);
        if (!entries) { entries = new Map(); index.set(key, entries); }
        entries.set(asset.id, asset);
      }
    }
  }
  return names.flatMap((name, row) => {
    const input = name.trim();
    if (!input) return [];
    if (input.length > 2000) throw new Error(`第 ${row + 1} 行文件名过长，请检查是否选择了正确的列。`);
    return [{ row, input, candidates: [...(index.get(normalizeName(input))?.values() ?? [])] }];
  });
}

export function resolveFilenameMatches(matches: FilenameMatch[], choices: Record<number, string | null>) {
  const ids = new Set<string>();
  let missing = 0, conflicts = 0, skipped = 0;
  for (const match of matches) {
    if (!match.candidates.length) { missing++; continue; }
    const chosen = choices[match.row];
    if (chosen === null) { skipped++; continue; }
    if (chosen !== undefined) {
      if (match.candidates.some((asset) => asset.id === chosen)) ids.add(chosen);
      else conflicts++;
    } else if (match.candidates.length === 1) ids.add(match.candidates[0].id);
    else conflicts++;
  }
  return { ids: [...ids], missing, conflicts, skipped };
}
