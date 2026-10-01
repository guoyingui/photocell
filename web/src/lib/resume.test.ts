import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPosition, rememberPosition } from './resume';

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());
describe('续选位置', () => {
  it('按目录与身份隔离，重新打开读取最后一次位置', () => {
    rememberPosition('/one', 'A'); rememberPosition('/two', 'B'); rememberPosition('/one', 'C');
    rememberPosition('/one', 'G', 'guest');
    expect(readPosition('/one')).toBe('C'); expect(readPosition('/two')).toBe('B');
    expect(readPosition('/one', 'guest')).toBe('G');
  });
  it('损坏或不可写的本地存储不能阻断选片', () => {
    localStorage.setItem('photocull.positions', 'broken');
    expect(readPosition('/one')).toBeNull();
    vi.stubGlobal('localStorage', { getItem() { throw new Error(); }, setItem() { throw new Error(); } });
    expect(() => rememberPosition('/one', 'A')).not.toThrow();
    expect(readPosition('/one')).toBeNull();
  });
});
