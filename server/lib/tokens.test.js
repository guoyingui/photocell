import { describe, it, expect } from 'vitest';
import { newToken, newId, redactTokens } from './tokens.js';

describe('newToken', () => {
  it('长度为 43 字符', () => {
    expect(newToken()).toHaveLength(43);
  });

  it('是 base64url：不含 +、/、=', () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('两次调用不相同', () => {
    expect(newToken()).not.toBe(newToken());
  });
});

describe('newId', () => {
  it('带前缀和下划线', () => {
    expect(newId('sh')).toMatch(/^sh_[A-Za-z0-9_-]+$/);
    expect(newId('u')).toMatch(/^u_[A-Za-z0-9_-]+$/);
  });

  it('两次调用不相同', () => {
    expect(newId('sh')).not.toBe(newId('sh'));
  });
});

describe('redactTokens', () => {
  it('替换顶层字符串', () => {
    const token = 'secret-token-value';
    expect(redactTokens({ token }, [token])).toEqual({ token: '[redacted]' });
  });

  it('替换嵌套对象里的字符串', () => {
    const token = 'secret-token-value';
    const input = { nested: { t: token } };
    expect(redactTokens(input, [token])).toEqual({ nested: { t: '[redacted]' } });
  });

  it('替换数组里的字符串', () => {
    const token = 'secret-token-value';
    const input = { list: ['x', token, 'y'] };
    expect(redactTokens(input, [token])).toEqual({ list: ['x', '[redacted]', 'y'] });
  });

  it('不等于任何已知令牌的字符串原样保留', () => {
    const token = 'secret-token-value';
    const input = { a: 'harmless', b: token };
    expect(redactTokens(input, [token])).toEqual({ a: 'harmless', b: '[redacted]' });
  });

  it('不修改原始对象（深拷贝）', () => {
    const token = 'secret-token-value';
    const input = { nested: { t: token } };
    const result = redactTokens(input, [token]);
    expect(input.nested.t).toBe(token);   // 原对象必须原封不动
    expect(result).not.toBe(input);
    expect(result.nested).not.toBe(input.nested);
  });

  it('保留非字符串类型（数字、布尔、null）', () => {
    const token = 'secret-token-value';
    const input = { n: 42, ok: true, empty: null, t: token };
    expect(redactTokens(input, [token])).toEqual({ n: 42, ok: true, empty: null, t: '[redacted]' });
  });

  it('多个不同令牌同时命中，全部被替换', () => {
    const t1 = 'token-one';
    const t2 = 'token-two';
    const input = { a: t1, b: t2, c: 'safe' };
    expect(redactTokens(input, [t1, t2])).toEqual({ a: '[redacted]', b: '[redacted]', c: 'safe' });
  });

  it('令牌数组为空时原样返回（深拷贝）', () => {
    const input = { a: 'anything' };
    const result = redactTokens(input, []);
    expect(result).toEqual({ a: 'anything' });
    expect(result).not.toBe(input);
  });
});
