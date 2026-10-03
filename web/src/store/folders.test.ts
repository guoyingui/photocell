import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFolders, useFolders } from './folders';

let data: Map<string, string>;
beforeEach(() => {
  data = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
  useFolders.getState().reload();
});
afterEach(() => { vi.unstubAllGlobals(); });

it('迁移旧的最近目录，保留最后打开的位置；无效存储不带入相对路径', () => {
  data.set('photocull.recent', JSON.stringify(['/photos/a', '/photos/b', '/photos/a', 4, 'relative', '']));
  expect(readFolders()).toEqual({ roots: ['/photos/a', '/photos/b'], lastRoot: '/photos/a' });
  data.set('photocull.folders.v1', JSON.stringify({ roots: ['/photos/a', 'C:\\Photos', '\\\\NAS\\Photos'], lastRoot: '/missing' }));
  expect(readFolders()).toEqual({ roots: ['/photos/a', 'C:\\Photos', '\\\\NAS\\Photos'], lastRoot: null });
});
it('添加超过旧版 8 个目录仍保留，切换不会重排或丢掉其他目录', () => {
  const roots = Array.from({ length: 12 }, (_, index) => `/photos/${index}`);
  useFolders.getState().add(roots);
  useFolders.getState().opened(roots[8]);
  expect(readFolders()).toEqual({ roots, lastRoot: roots[8] });
  useFolders.getState().add([roots[0]]); expect(useFolders.getState().roots).toEqual(roots);
});
it('真实路径合并旧目录别名，移除当前目录只清除列表和自动恢复目标', () => {
  useFolders.getState().add(['/alias', '/real', '/other']);
  useFolders.getState().opened('/real', '/alias');
  expect(readFolders()).toEqual({ roots: ['/real', '/other'], lastRoot: '/real' });
  useFolders.getState().remove('/real');
  expect(readFolders()).toEqual({ roots: ['/other'], lastRoot: null });
});
it('清空列表后不会从旧的最近记录重新冒出已移除目录', () => {
  data.set('photocull.recent', JSON.stringify(['/old']));
  useFolders.getState().reload(); useFolders.getState().remove('/old');
  expect(readFolders()).toEqual({ roots: [], lastRoot: null });
});
it('浏览器存储失败仍可操作，显示持久化失败提示', () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); } });
  useFolders.getState().add(['/a']);
  expect(useFolders.getState().roots).toEqual(['/a']);
  expect(useFolders.getState().storageError).toContain('未能保存');
});
it('超过容量时明确报错，不静默丢弃已保存的目录', () => {
  useFolders.getState().add(['/existing']);
  expect(() => useFolders.getState().add(Array.from({ length: 100 }, (_, index) => `/photos/${index}`))).toThrow('100');
  expect(readFolders().roots).toEqual(['/existing']);
});
