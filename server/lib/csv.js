export function csvCell(value) {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  // Excel 会把以 = + @ 开头的单元格当公式执行；纯负数（如 "-5"）不算公式，
  // 但 "-" 开头的非纯数字字符串（如 "-cmd|..."）同样可能被当公式，也要防。
  // 光给字段套双引号只是 CSV 的分隔符转义机制，解析后 Excel 拿到的还是裸的
  // "=1+1"，一样会被当公式执行——必须在值前面加一个字面单引号强制文本模式，
  // 双引号只是顺带把这个单引号安全地放进字段里（值里可能还有逗号等需要转义）。
  const isFormulaLike = /^[=+@]/.test(raw) || (raw.startsWith('-') && !/^-\d+(\.\d+)?$/.test(raw));
  const s = isFormulaLike ? `'${raw}` : raw;
  if (isFormulaLike || /[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export const csvRow = (values) => values.map(csvCell).join(',') + '\r\n';
