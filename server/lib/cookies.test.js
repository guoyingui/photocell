import { describe, it, expect } from 'vitest';
import { parseCookies, serializeCookie } from './cookies.js';

// 控制字符一律用 String.fromCharCode 构造，绝不在源码里键入裸字节：
// 裸控制字符在编辑器里是隐形的，本项目历史上进过仓库四次
// （代码照常工作、测试照常通过，只有 git diff 把文件标成二进制）。
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

describe('parseCookies', () => {
  it.each([[undefined], [null], [''], [123], [{}]])('没有可用的 header（%j）时返回空表', (header) => {
    expect(Object.keys(parseCookies(header))).toEqual([]);
  });

  it('解析出多对键值，并去掉分号后的空白', () => {
    const got = parseCookies('pc_user=abc123;  other=1');
    expect(got.pc_user).toBe('abc123');
    expect(got.other).toBe('1');
  });

  it('值里含 = 时只在第一个 = 处切分（base64 的填充号不能被吃掉）', () => {
    expect(parseCookies('pc_user=YWJj==').pc_user).toBe('YWJj==');
  });

  it('没有 = 的段被丢弃，不会变成 undefined 值', () => {
    const got = parseCookies('flag; pc_user=abc');
    expect(got.pc_user).toBe('abc');
    expect(Object.keys(got)).toEqual(['pc_user']);
  });

  it('重名时取第一个——后面追加的同名 Cookie 不能覆盖前面那个', () => {
    // 影子 Cookie 是一种真实攻击手法：攻击者在更宽的 Domain/Path 上再设一个同名
    // Cookie，指望服务端取到后面那个。取第一个与浏览器的优先顺序一致。
    expect(parseCookies('pc_user=real; pc_user=forged').pc_user).toBe('real');
  });

  it('百分号编码会被还原；编码坏掉时原样返回而不抛错', () => {
    expect(parseCookies('n=a%20b').n).toBe('a b');
    expect(parseCookies('n=100%').n).toBe('100%');
  });

  it('名叫 __proto__ 的 Cookie 不会污染对象原型', () => {
    const got = parseCookies('__proto__=polluted; pc_user=abc');
    expect(got.pc_user).toBe('abc');
    expect({}.pc_user).toBeUndefined();
    expect(Object.prototype.toString.call({})).toBe('[object Object]');
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

describe('serializeCookie', () => {
  it('按计划的字面顺序拼出 Set-Cookie 串', () => {
    expect(serializeCookie('pc_user', 'tok', { httpOnly: true, sameSite: 'Lax', path: '/' }))
      .toBe('pc_user=tok; HttpOnly; SameSite=Lax; Path=/');
  });

  it('maxAge = 0 必须被写出来（清 Cookie 全靠它，不能被当成假值省略）', () => {
    expect(serializeCookie('pc_user', '', { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 0 }))
      .toBe('pc_user=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  });

  it('不给的属性一个都不出现', () => {
    expect(serializeCookie('a', 'b')).toBe('a=b');
  });

  it('值里的 CR/LF 被编码，不可能凭空插出第二条响应头', () => {
    const evil = 'a' + CR + LF + 'Set-Cookie: pc_user=forged';
    const out = serializeCookie('pc_user', evil, { httpOnly: true, path: '/' });
    expect(out).not.toContain(CR);
    expect(out).not.toContain(LF);
    expect(out.startsWith('pc_user=' + encodeURIComponent(evil) + ';')).toBe(true);
  });

  it('值里的分号和逗号被编码，不会被当成属性分隔符', () => {
    const out = serializeCookie('pc_user', 'a;Path=/evil,b', { path: '/' });
    expect(out).toBe('pc_user=a%3BPath%3D%2Fevil%2Cb; Path=/');
  });

  it('serialize 出来的值再 parse 回去与原值相等', () => {
    const value = 'a b;c,d' + CR + LF;
    const line = serializeCookie('pc_user', value, { httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(parseCookies(line.split('; ')[0]).pc_user).toBe(value);
  });

  it.each([
    ['pc user'],
    ['pc;user'],
    ['pc' + CR + 'user'],
    [''],
    [undefined],
  ])('非法 Cookie 名 %j 直接抛错', (name) => {
    expect(() => serializeCookie(name, 'v')).toThrow();
  });

  it.each([
    ['no-leading-slash'],
    ['/a;Domain=evil.test'],
    ['/a' + CR + LF],
  ])('非法 Path %j 直接抛错', (p) => {
    expect(() => serializeCookie('pc_user', 'v', { path: p })).toThrow();
  });

  it('非法 SameSite 直接抛错，不静默降级', () => {
    expect(() => serializeCookie('pc_user', 'v', { sameSite: 'Whatever' })).toThrow();
  });

  it('非整数 maxAge 直接抛错', () => {
    expect(() => serializeCookie('pc_user', 'v', { maxAge: 'forever' })).toThrow();
  });

  it('值必须是字符串', () => {
    expect(() => serializeCookie('pc_user', { toString: () => 'x' })).toThrow();
  });
});
