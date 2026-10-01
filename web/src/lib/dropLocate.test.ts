import { describe, it, expect } from 'vitest';
import { locate, folderNameFromDrop } from './dropLocate';

describe('locate', () => {
  const recent = ['/Users/guoyg/照片/婚礼-小林', '/Volumes/CARD/DCIM'];
  const listed = [
    { name: '婚礼-小林', path: '/Users/guoyg/备份/婚礼-小林' },
    { name: '写真', path: '/Users/guoyg/备份/写真' },
  ];

  it('命中最近打开优先于命中当前目录', () => {
    // 最近打开是一条完整的绝对路径，用户上次就是从那儿开的；
    // 当前目录里的同名文件夹只是碰巧叫这个名字。
    expect(locate('婚礼-小林', recent, listed)).toEqual({
      kind: 'recent', path: '/Users/guoyg/照片/婚礼-小林',
    });
  });

  it('最近打开没有时退到当前目录的子目录', () => {
    expect(locate('写真', recent, listed)).toEqual({
      kind: 'listed', path: '/Users/guoyg/备份/写真',
    });
  });

  it('都没命中时返回 none', () => {
    expect(locate('从没见过的文件夹', recent, listed)).toEqual({ kind: 'none' });
  });

  it('Windows 路径的 basename 也认得出来', () => {
    expect(locate('婚礼', ['D:\\照片\\婚礼'], [])).toEqual({
      kind: 'recent', path: 'D:\\照片\\婚礼',
    });
  });

  it('最近打开里有多条同名时取最靠前的那条（MRU 顺序即优先级）', () => {
    const dup = ['/a/婚礼', '/b/婚礼'];
    expect(locate('婚礼', dup, [])).toEqual({ kind: 'recent', path: '/a/婚礼' });
  });
});

/** 造一个够用的假 DataTransfer。只实现 items 那一条路径。 */
function fakeDT(entries: ({ name: string; isDirectory: boolean } | null)[]): DataTransfer {
  return {
    items: entries.map((e) => ({
      webkitGetAsEntry: () => e,
    })),
  } as unknown as DataTransfer;
}

describe('folderNameFromDrop', () => {
  it('拖入一个文件夹时取它的名字', () => {
    expect(folderNameFromDrop(fakeDT([{ name: '婚礼-小林', isDirectory: true }])))
      .toEqual({ name: '婚礼-小林' });
  });

  it('拖入文件而不是文件夹时给出提示', () => {
    expect(folderNameFromDrop(fakeDT([{ name: 'IMG_0001.CR2', isDirectory: false }])))
      .toEqual({ error: '请拖入文件夹，不是文件' });
  });

  it('拖入多个文件夹时只取第一个，并说清楚', () => {
    // 静默忽略其余的会让用户以为程序没反应。
    expect(folderNameFromDrop(fakeDT([
      { name: '婚礼', isDirectory: true },
      { name: '写真', isDirectory: true },
    ]))).toEqual({ name: '婚礼', notice: '一次只能打开一个文件夹，已按「婚礼」定位' });
  });

  it('拿不到任何 entry 时给出提示', () => {
    // 浏览器没给 webkitGetAsEntry，或者拖的是一段文本。
    expect(folderNameFromDrop(fakeDT([null]))).toEqual({ error: '没能识别拖入的内容，请改用下面的目录浏览器' });
  });

  it('空的 DataTransfer 也不抛', () => {
    expect(folderNameFromDrop(fakeDT([]))).toEqual({ error: '没能识别拖入的内容，请改用下面的目录浏览器' });
  });

  it('当浏览器没实现 webkitGetAsEntry 方法时不崩', () => {
    // 某些浏览器或拖拽方式可能不支持 webkitGetAsEntry，
    // 这时 item 就没有这个方法。?.() 会返回 undefined，需要 ?? null 转成 null
    // 然后被 filter 过滤掉，最后返回 error 而不是抛异常。
    const dtNoMethod = {
      items: [{ kind: 'file' }] // 这个 item 没有 webkitGetAsEntry 方法
    } as unknown as DataTransfer;
    expect(folderNameFromDrop(dtNoMethod)).toEqual({ error: '没能识别拖入的内容，请改用下面的目录浏览器' });
  });
});
