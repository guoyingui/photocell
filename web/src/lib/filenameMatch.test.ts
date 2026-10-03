import { describe, expect, it } from 'vitest';
import { matchFilenames, parseFilenameList, resolveFilenameMatches } from './filenameMatch';
import type { Asset } from '../types';

const asset = (id: string, dir: string, stem: string): Asset => ({ id, dir, stem, raws: [`${stem}.CR3`], jpg: `${stem}.JPG`, jpgMtimeMs: 1, jpgSize: 1 });
const assets = [asset('a', 'day1', 'IMG_0001'), asset('b', 'day2', 'IMG_0001'), asset('c', '', 'IMG_0002')];

describe('文件名清单读取', () => {
  it('读取 BOM、空行、CRLF 和不带扩展名的多行清单', () => {
    expect(parseFilenameList('\uFEFFIMG_0001.JPG\r\n\r\nday2/IMG_0002\r\n').rows).toEqual([['IMG_0001.JPG'], ['day2/IMG_0002']]);
  });
  it('CSV 自动识别文件名列，并保留引号内的逗号、换行和转义引号', () => {
    const parsed = parseFilenameList('备注,文件名\n"客户说：好看","a,b.JPG"\n备注,"带""引号.JPG"\n备注,"换\n行.JPG"');
    expect(parsed.defaultColumn).toBe(1);
    expect(parsed.columns).toEqual(['备注', '文件名']);
    expect(parsed.rows.map((row) => row[1])).toEqual(['a,b.JPG', '带"引号.JPG', '换\n行.JPG']);
  });
  it('Excel 粘贴保留列选择，导出清单优先匹配 rawFile 列', () => {
    expect(parseFilenameList('编号\t文件名\t备注\n1\tIMG_0001.JPG\tA,B').rows[0]).toEqual(['1', 'IMG_0001.JPG', 'A,B']);
    expect(parseFilenameList('assetId,mark,rawFile,jpgFile\nid,pick,IMG.CR3,IMG.JPG').defaultColumn).toBe(2);
    expect(parseFilenameList('001,IMG.JPG\n002,OTHER.JPG').rows).toHaveLength(2);
  });
  it('拒绝损坏、过长和超限清单，不将截断内容当作完整清单', () => {
    expect(() => parseFilenameList('文件名,备注\n"IMG.JPG,未闭合')).toThrow('引号未闭合');
    expect(() => parseFilenameList('"IMG.JPG"x')).toThrow('引号格式');
    expect(() => parseFilenameList('x'.repeat(2 * 1024 * 1024 + 1))).toThrow('过大');
    expect(() => parseFilenameList(Array(5001).fill('IMG.JPG').join('\n'))).toThrow('5000');
    expect(parseFilenameList(['文件名', ...Array(5000).fill('IMG.JPG')].join('\n')).rows).toHaveLength(5000);
  });
});

describe('照片匹配与冲突', () => {
  it('精确匹配大小写、主名和相对路径，不把编号子串或错误目录当匹配', () => {
    const matches = matchFilenames(['img_0001.jpg', 'day2\\IMG_0001', './day1/IMG_0001.CR3', '0001', 'wrong/IMG_0001.JPG'], assets, new Set());
    expect(matches.map((entry) => entry.candidates.map((value) => value.id))).toEqual([['a', 'b'], ['b'], ['a'], [], []]);
  });
  it('隐藏照片不匹配；重复行及 RAW/JPG 配对去重，同名必须确认或跳过', () => {
    const matches = matchFilenames(['IMG_0001', 'IMG_0002.JPG', 'IMG_0002.CR3', 'IMG_0002.JPG', 'gone.JPG'], assets, new Set());
    expect(resolveFilenameMatches(matches, {})).toEqual({ ids: ['c'], missing: 1, conflicts: 1, skipped: 0 });
    expect(resolveFilenameMatches(matches, { 0: 'b' }).ids).toEqual(['b', 'c']);
    expect(resolveFilenameMatches(matches, { 0: null })).toEqual({ ids: ['c'], missing: 1, conflicts: 0, skipped: 1 });
    expect(resolveFilenameMatches(matches, { 0: 'not-a-candidate' }).conflicts).toBe(1);
    expect(matchFilenames(['day1/IMG_0001.JPG'], assets, new Set(['a']))[0].candidates).toEqual([]);
  });
  it('空单元格保留原始行号，Unicode 等价名字能匹配', () => {
    const matches = matchFilenames(['', 'e\u0301.JPG'], [asset('e', '', 'é')], new Set());
    expect(matches[0].row).toBe(1); expect(matches[0].candidates[0].id).toBe('e');
    expect(() => matchFilenames(['x'.repeat(2001)], assets, new Set())).toThrow('过长');
  });
});
