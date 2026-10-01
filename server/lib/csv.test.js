import { describe, it, expect } from 'vitest';
import { csvCell, csvRow } from './csv.js';

// 反向解析 csvCell 的输出：去掉外层引号并把两个双引号还原成一个，
// 得到 Excel 实际会拿到的单元格内容——用来验证公式注入是否真的被中和，
// 而不是只看 csvCell 返回的字符串长得像不像加了引号。
function unescapeCsvField(field) {
  if (field.startsWith('"') && field.endsWith('"')) {
    return field.slice(1, -1).replace(/""/g, '"');
  }
  return field;
}

describe('csvCell', () => {
  it('普通值原样输出', () => {
    expect(csvCell('IMG_1234')).toBe('IMG_1234');
  });
  it('含逗号的值加引号', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
  });
  it('含双引号的值转义成两个双引号', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });
  it('含换行的值加引号', () => {
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });
  it('null 与 undefined 输出空串', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
  it('数字转成字符串', () => {
    expect(csvCell(42)).toBe('42');
  });
  it('前导等号会被真正中和成文本，而不只是套上 CSV 引号', () => {
    // 单纯加双引号只是 CSV 转义，解析后 Excel 拿到的还是裸 "=1+1"，仍会执行成公式。
    // 必须验证还原后的实际单元格内容带有强制文本的前导单引号。
    const value = unescapeCsvField(csvCell('=1+1'));
    expect(value).toBe("'=1+1");
    expect(value.startsWith('=')).toBe(false);
  });

  it('加号、@ 开头同样会被中和成文本', () => {
    expect(unescapeCsvField(csvCell('+1+1'))).toBe("'+1+1");
    expect(unescapeCsvField(csvCell('@SUM(A1:A9)'))).toBe("'@SUM(A1:A9)");
  });

  it('纯负数不当公式处理，不加引号也不加单引号', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(-5.5)).toBe('-5.5');
    expect(csvCell('-5')).toBe('-5');
  });

  it('减号开头但不是纯数字时仍按公式中和', () => {
    const value = unescapeCsvField(csvCell('-cmd|/c calc'));
    expect(value).toBe("'-cmd|/c calc");
  });
});

describe('csvRow', () => {
  it('用逗号连接并以 CRLF 结尾', () => {
    expect(csvRow(['a', 'b,c', 1])).toBe('a,"b,c",1\r\n');
  });
});
