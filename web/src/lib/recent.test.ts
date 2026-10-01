import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetRecent, readRecent, rememberRecent } from './recent';

/**
 * 这个文件跑在 **node** 环境（vitest.config.js 把 `web/src/**\/*.test.ts` 分给了
 * `environment: 'node'` 那个 project），而 node 22 默认没有 `localStorage`
 * —— 要 `--experimental-webstorage` 才有。所以桩由测试自己提供。
 *
 * 用真的桩而不是 vi.mock 掉整个模块：这一组要验的恰恰是"读到脏数据 / 写不进去
 * 的时候会发生什么"，把 Storage 换成替身才测得到那些分支。
 */
class FakeStorage {
  map = new Map<string, string>();
  throwOnSet = false;
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void {
    if (this.throwOnSet) throw new Error('QuotaExceededError');
    this.map.set(k, v);
  }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
  key(): string | null { return null; }
  get length(): number { return this.map.size; }
}

const KEY = 'photocull.recent';
const g = globalThis as unknown as Record<string, unknown>;
let store: FakeStorage;

const seed = (value: unknown) => { store.map.set(KEY, JSON.stringify(value)); };

beforeEach(() => {
  store = new FakeStorage();
  g.localStorage = store;
});

afterEach(() => {
  delete g.localStorage;
});

describe('readRecent', () => {
  it('没存过时返回空列表', () => {
    expect(readRecent()).toEqual([]);
  });

  it('存的不是合法 JSON 时返回空列表，不抛', () => {
    store.map.set(KEY, '{这不是 JSON');
    expect(readRecent()).toEqual([]);
  });

  it('存的不是数组时返回空列表', () => {
    seed({ a: 1 });
    expect(readRecent()).toEqual([]);
  });

  // localStorage 里的内容任何人用开发者工具都能改，而这个函数的签名声称
  // 返回 string[]。数组里混进别的类型时必须滤掉，否则那句声明就是谎话。
  it('滤掉数组里的非字符串元素', () => {
    seed(['/a', 42, null, '/b', { p: '/c' }]);
    expect(readRecent()).toEqual(['/a', '/b']);
  });
});

describe('rememberRecent', () => {
  it('新路径置顶', () => {
    seed(['/a', '/b']);
    expect(rememberRecent('/c')).toEqual(['/c', '/a', '/b']);
  });

  it('已经在列表里的路径被提到最前面，不重复出现', () => {
    seed(['/a', '/b', '/c']);
    expect(rememberRecent('/c')).toEqual(['/c', '/a', '/b']);
  });

  it('超过 8 条时丢掉最旧的', () => {
    seed(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(rememberRecent('9')).toEqual(['9', '1', '2', '3', '4', '5', '6', '7']);
  });

  it('真的写进了 localStorage', () => {
    rememberRecent('/a');
    expect(JSON.parse(store.map.get(KEY)!)).toEqual(['/a']);
  });
});

describe('forgetRecent', () => {
  it('只删掉全等的那一条，其余顺序不变', () => {
    seed(['/a', '/b', '/c']);
    expect(forgetRecent('/b')).toEqual(['/a', '/c']);
    expect(JSON.parse(store.map.get(KEY)!)).toEqual(['/a', '/c']);
  });

  it('删一个不在列表里的路径，列表不变', () => {
    seed(['/a', '/b']);
    expect(forgetRecent('/zzz')).toEqual(['/a', '/b']);
  });

  it('删光之后是空列表', () => {
    seed(['/a']);
    expect(forgetRecent('/a')).toEqual([]);
  });
});

describe('写不进去的时候', () => {
  // 隐私模式、配额超限。记住"最近打开"是锦上添花，不能因此挡住打开流程，
  // 所以异常一律吞掉；但**返回值照常是新列表**，界面这一刻是对的。
  // 代价是刷新之后这次改动会消失，这是已知的取舍。
  it('rememberRecent 不抛，并照常返回新列表', () => {
    seed(['/a']);
    store.throwOnSet = true;
    expect(() => rememberRecent('/b')).not.toThrow();
    expect(rememberRecent('/b')).toEqual(['/b', '/a']);
  });

  it('forgetRecent 不抛，并照常返回新列表', () => {
    seed(['/a', '/b']);
    store.throwOnSet = true;
    expect(forgetRecent('/a')).toEqual(['/b']);
  });
});
