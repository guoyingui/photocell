import { describe, it, expect, vi } from 'vitest';
import { createBlobCache } from './blobCache';

describe('createBlobCache', () => {
  it('存进去能取出来', () => {
    const c = createBlobCache(3);
    c.set('a', 'blob:a');
    expect(c.get('a')).toBe('blob:a');
    expect(c.has('a')).toBe(true);
  });

  it('未存过的 key 返回 undefined', () => {
    expect(createBlobCache(3).get('nope')).toBeUndefined();
  });

  it('超出容量时淘汰最久未使用的并 revoke', () => {
    const revoke = vi.fn();
    const c = createBlobCache(2, revoke);
    c.set('a', 'blob:a');
    c.set('b', 'blob:b');
    c.set('c', 'blob:c');
    expect(c.has('a')).toBe(false);
    expect(revoke).toHaveBeenCalledWith('blob:a');
    expect(c.size).toBe(2);
  });

  it('get 会把条目提为最新，改变淘汰顺序', () => {
    const revoke = vi.fn();
    const c = createBlobCache(2, revoke);
    c.set('a', 'blob:a');
    c.set('b', 'blob:b');
    c.get('a');              // a 变成最新，b 成为最久未用
    c.set('c', 'blob:c');
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
    expect(revoke).toHaveBeenCalledWith('blob:b');
  });

  it('重复 set 同一 key 时 revoke 旧值', () => {
    const revoke = vi.fn();
    const c = createBlobCache(3, revoke);
    c.set('a', 'blob:old');
    c.set('a', 'blob:new');
    expect(revoke).toHaveBeenCalledWith('blob:old');
    expect(c.get('a')).toBe('blob:new');
    expect(c.size).toBe(1);
  });

  it('clear 会 revoke 全部条目', () => {
    const revoke = vi.fn();
    const c = createBlobCache(5, revoke);
    c.set('a', 'blob:a');
    c.set('b', 'blob:b');
    c.clear();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(c.size).toBe(0);
  });

  it('容量为 1 时每次 set 都淘汰上一个', () => {
    const revoke = vi.fn();
    const c = createBlobCache(1, revoke);
    c.set('a', 'blob:a');
    c.set('b', 'blob:b');
    expect(c.size).toBe(1);
    expect(revoke).toHaveBeenCalledWith('blob:a');
  });

  it('滚过远超容量的条目后内存占用保持恒定', () => {
    const revoke = vi.fn();
    const c = createBlobCache(100, revoke);
    for (let i = 0; i < 3000; i++) c.set(`k${i}`, `blob:${i}`);
    expect(c.size).toBe(100);
    expect(revoke).toHaveBeenCalledTimes(2900);   // 泄漏就是这里对不上
  });

  describe('非法 capacity 在构造时就拒绝', () => {
    // 负数：淘汰循环 `map.size > capacity` 在 map 已空后依然为真，会死循环。
    // 这里只断言 createBlobCache(-1) 本身同步抛出——如果修复错了，
    // 这条断言不会失败，而是让整个测试进程挂起，看不到失败输出。
    it('负数抛出', () => {
      expect(() => createBlobCache(-1)).toThrow(RangeError);
    });

    it('零抛出', () => {
      expect(() => createBlobCache(0)).toThrow(RangeError);
    });

    // NaN 与任何数比较都是 false，会让淘汰循环永不触发，缓存无限增长。
    it('NaN 抛出', () => {
      expect(() => createBlobCache(NaN)).toThrow(RangeError);
    });

    it('非整数抛出', () => {
      expect(() => createBlobCache(1.5)).toThrow(RangeError);
    });

    it('非 number 类型抛出', () => {
      expect(() => createBlobCache('3' as unknown as number)).toThrow(RangeError);
    });

    it('合法容量（正整数）不抛出', () => {
      expect(() => createBlobCache(1)).not.toThrow();
    });
  });
});
