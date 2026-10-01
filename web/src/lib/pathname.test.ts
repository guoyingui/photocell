import { describe, it, expect } from 'vitest';
import { basename, within } from './pathname';

describe('basename', () => {
  it('POSIX 路径取最后一段', () => {
    expect(basename('/Users/guoyg/婚礼')).toBe('婚礼');
  });

  it('Windows 路径取最后一段', () => {
    expect(basename('D:\\婚礼\\小林')).toBe('小林');
  });

  it('末尾的分隔符先剥掉', () => {
    expect(basename('/Users/guoyg/婚礼/')).toBe('婚礼');
    expect(basename('D:\\婚礼\\')).toBe('婚礼');
  });

  it('盘符根返回盘符本身', () => {
    expect(basename('D:\\')).toBe('D:');
  });

  it('混合分隔符按最后出现的那个切', () => {
    expect(basename('D:\\婚礼/小林')).toBe('小林');
  });
});

describe('within', () => {
  it('根自身算在自己之内', () => {
    expect(within('D:\\照片', 'D:\\照片')).toBe(true);
  });

  it('子目录在根之内', () => {
    expect(within('D:\\照片\\婚礼', 'D:\\照片')).toBe(true);
  });

  it('必须按整段比对，D:\\照片2 不在 D:\\照片 之内', () => {
    // 裸 startsWith 会把它误判成同一个根，于是"上级"按钮在真正的边界上
    // 仍然可点，用户点出一个看起来像 bug 的 403。
    expect(within('D:\\照片2', 'D:\\照片')).toBe(false);
    expect(within('D:\\照片2\\婚礼', 'D:\\照片')).toBe(false);
  });

  it('盘符根包住盘上的一切', () => {
    expect(within('D:\\照片\\婚礼', 'D:\\')).toBe(true);
  });

  it('POSIX 根包住一切', () => {
    expect(within('/Users/guoyg', '/')).toBe(true);
  });

  it('不同盘符互不包含', () => {
    expect(within('E:\\照片', 'D:\\')).toBe(false);
  });
});
