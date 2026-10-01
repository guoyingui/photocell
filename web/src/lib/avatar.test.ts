import { describe, expect, it } from 'vitest';
import { avatarColor, avatarInitial } from './avatar';

describe('avatarColor', () => {
  it('同一个 userId 永远得到同一个颜色（稳定派生，不含随机数/时间戳）', () => {
    const id = 'u_2c7b1234';
    const first = avatarColor(id);
    const second = avatarColor(id);
    expect(first).toBe(second);
  });

  it('多次调用（跨"进程"模拟：重新拼同一个字符串）结果仍然一致', () => {
    const a = avatarColor('u_' + 'abc');
    const b = avatarColor('u_abc');
    expect(a).toBe(b);
  });

  it('不同 userId 通常得到不同颜色', () => {
    expect(avatarColor('u_aaa')).not.toBe(avatarColor('u_bbb'));
  });

  it('返回值是一个合法的 hsl() 颜色字符串', () => {
    expect(avatarColor('u_aaa')).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
  });
});

describe('avatarInitial', () => {
  it('取昵称的第一个码点（中文昵称不切半个字）', () => {
    expect(avatarInitial('新娘小林')).toBe('新');
  });

  it('首尾空白被忽略', () => {
    expect(avatarInitial('  伴娘  ')).toBe('伴');
  });

  it('空昵称兜底为 ?', () => {
    expect(avatarInitial('   ')).toBe('?');
  });
});
