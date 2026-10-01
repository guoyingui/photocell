import { describe, it, expect } from 'vitest';
import { createRateLimiter } from './ratelimit.js';

// 时钟从外面注入：靠真实 sleep 去测 60 秒的窗口既慢又不稳。
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

describe('createRateLimiter', () => {
  it('hit() 返回"这一次是否放行"：前 max 次 true，第 max+1 次 false', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ windowMs: 60_000, max: 20, now });
    for (let i = 0; i < 20; i++) {
      expect(limiter.hit('1.2.3.4')).toBe(true);
    }
    expect(limiter.hit('1.2.3.4')).toBe(false);
    expect(limiter.hit('1.2.3.4')).toBe(false);
  });

  it('不同 key 互不影响', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2, now });
    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('a')).toBe(false);
    expect(limiter.hit('b')).toBe(true);
  });

  it('窗口滑过去之后重新放行', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2, now });
    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('a')).toBe(false);
    now.advance(60_000);
    expect(limiter.hit('a')).toBe(true);
  });

  it('是滑动窗口，不是固定窗口：窗口边界处不给双倍额度', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2, now });
    now.advance(59_000);
    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('a')).toBe(true);
    // 固定窗口在 t=60s 换窗，会在这里再给 2 次额度——那正是猜 token 最值钱的一段。
    now.advance(2_000);
    expect(limiter.hit('a')).toBe(false);
    // 最早那两条真正滑出窗口之后才恢复
    now.advance(58_100);
    expect(limiter.hit('a')).toBe(true);
  });

  it('被拦下的尝试也计入窗口：一直敲就一直被关着', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, now });
    expect(limiter.hit('a')).toBe(true);
    now.advance(30_000);
    expect(limiter.hit('a')).toBe(false);   // 这一次也被记下来
    now.advance(31_000);                    // 第一条已经过期，但 30s 那条还在
    expect(limiter.hit('a')).toBe(false);
  });

  it('reset() 清空全部计数', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, now });
    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('a')).toBe(false);
    limiter.reset();
    expect(limiter.hit('a')).toBe(true);
  });

  it('reset(key) 只清一个 key', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, now });
    limiter.hit('a');
    limiter.hit('b');
    limiter.reset('a');
    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('b')).toBe(false);
  });

  it('key 不是可用字符串时按拒绝处理，绝不当成"没有限流"放行', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 20, now: fakeClock() });
    expect(limiter.hit(undefined)).toBe(false);
    expect(limiter.hit('')).toBe(false);
    expect(limiter.hit(null)).toBe(false);
  });

  it('key 数量很多时不会无限堆积', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ windowMs: 1_000, max: 5, now });
    for (let i = 0; i < 5000; i++) limiter.hit(`ip-${i}`);
    now.advance(2_000);
    limiter.hit('trigger-sweep');
    expect(limiter.size()).toBeLessThan(100);
  });

  it.each([
    [{ windowMs: 0, max: 5 }],
    [{ windowMs: -1, max: 5 }],
    [{ windowMs: 60_000, max: -1 }],
    [{ windowMs: 60_000 }],
    [{ max: 5 }],
    [undefined],
  ])('参数不合法 %j 时直接抛错', (opts) => {
    expect(() => createRateLimiter(opts)).toThrow();
  });
});
