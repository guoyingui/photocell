import { describe, it, expect, beforeEach } from 'vitest';
import { clearThumbCache, __test } from './thumbSource';

describe('clearThumbCache（G2）', () => {
  beforeEach(() => clearThumbCache());

  it('同时清空 blob 缓存和失败集合', () => {
    __test.failed.add('cam-a/IMG_0002');
    expect(__test.failed.size).toBe(1);

    clearThumbCache();

    // 只清 cache 不清 failed 的实现会让这一条变红。终审对 I10 的原话是：
    // 「an id that failed in A renders 无法预览 in B without ever being requested」。
    expect(__test.failed.size).toBe(0);
  });

  it('对空集合调用是幂等的，不抛错', () => {
    expect(() => { clearThumbCache(); clearThumbCache(); }).not.toThrow();
  });
});
