import { describe, it, expect, afterEach, vi } from 'vitest';
import { containingRoot, atRootBoundary, fetchRoots, type FsRoot } from './fsRoots';

const roots: FsRoot[] = [
  { path: '/Users/guoyg', label: 'guoyg' },
  { path: '/Volumes/CARD', label: 'CARD' },
  { path: '/Volumes', label: 'Volumes' },
];

afterEach(() => { vi.unstubAllGlobals(); });

describe('containingRoot', () => {
  it('根自身算在自己之内', () => {
    expect(containingRoot('/Users/guoyg', roots)).toBe('/Users/guoyg');
  });

  it('子目录归到它所在的根', () => {
    expect(containingRoot('/Users/guoyg/Pictures/2026', roots)).toBe('/Users/guoyg');
  });

  it('嵌套的根取最长匹配（外接卷优先于 /Volumes 本身）', () => {
    expect(containingRoot('/Volumes/CARD/DCIM', roots)).toBe('/Volumes/CARD');
    expect(containingRoot('/Volumes/OTHER/DCIM', roots)).toBe('/Volumes');
  });

  it('必须按整段比对，不能用裸 startsWith', () => {
    // /Users/guoyg2 不在 /Users/guoyg 之内；裸 startsWith 会把它误判成同一个根，
    // 于是"上级"按钮在真正的边界上仍然可点，用户点出一个看起来像 bug 的 403。
    expect(containingRoot('/Users/guoyg2', roots)).toBeNull();
    expect(containingRoot('/Users/guoyg2/Pictures', roots)).toBeNull();
  });

  it('不在任何根之内返回 null', () => {
    expect(containingRoot('/etc/ssh', roots)).toBeNull();
    expect(containingRoot('/Users', roots)).toBeNull();
  });

  it('根列表为空时永远是 null', () => {
    expect(containingRoot('/Users/guoyg', [])).toBeNull();
  });
});

describe('atRootBoundary', () => {
  it('站在根上就是边界', () => {
    expect(atRootBoundary('/Users/guoyg', roots)).toBe(true);
    expect(atRootBoundary('/Volumes/CARD', roots)).toBe(true);
  });

  it('根里面的目录不是边界', () => {
    expect(atRootBoundary('/Users/guoyg/Pictures', roots)).toBe(false);
    expect(atRootBoundary('/Volumes/CARD/DCIM', roots)).toBe(false);
  });

  it('嵌套根：外接卷的根之上还有 /Volumes，所以它不是边界', () => {
    // /Volumes/CARD 是最长匹配的根，站在它上面就是边界——即便 /Volumes 也在列表里，
    // 也不该让用户以为还能往上走一层。
    expect(atRootBoundary('/Volumes/CARD', roots)).toBe(true);
    expect(atRootBoundary('/Volumes', roots)).toBe(true);
  });

  it('不在任何根之内时算边界（往上只会更糟）', () => {
    expect(atRootBoundary('/etc/ssh', roots)).toBe(true);
  });
});

describe('fetchRoots', () => {
  it('调用的是服务端早就提供、前端一直没用的 /api/fs/roots', async () => {
    const body = { roots: [{ path: '/Volumes/CARD', label: 'CARD' }], home: '/Users/guoyg' };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK', json: async () => body,
    })));

    await expect(fetchRoots()).resolves.toEqual(body);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/fs/roots');
  });
});

describe('Windows 路径', () => {
  const winRoots: FsRoot[] = [
    { path: 'C:\\', label: 'C:' },
    { path: 'D:\\', label: 'D:' },
  ];

  it('盘上的子目录归到该盘符', () => {
    expect(containingRoot('D:\\照片\\婚礼', winRoots)).toBe('D:\\');
  });

  it('站在盘符根上就是边界', () => {
    expect(atRootBoundary('D:\\', winRoots)).toBe(true);
  });

  it('站在盘上的子目录里不是边界', () => {
    // 这一条是 fsRoots.ts 里那句硬编码 `/` 的直接后果：
    // `D:\` + '/' 拼出来的前缀永远匹配不上 `D:\照片`，于是每一个 Windows
    // 目录都被判成"不属于任何根"，"上级"按钮全程变灰。
    expect(atRootBoundary('D:\\照片', winRoots)).toBe(false);
  });
});
