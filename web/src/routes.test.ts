import { describe, expect, it } from 'vitest';
import { routeFor, tokenFor } from './routes';

// 这个文件只测 routeFor/tokenFor 两个纯函数，刻意不 render 任何组件——
// 所以留在 .test.ts（node 环境）里就够了，不需要 jsdom。routes.tsx 里的
// Router/占位组件是给 main.tsx 用的胶水，Task 15/16/19 换上真正界面之后
// 会有自己的渲染测试。

describe('routeFor（三条入口 + notfound）', () => {
  it.each([
    ['/', 'local'],
    ['/s/abc123', 'guest'],
    ['/admin', 'admin'],
    ['/s/', 'notfound'],     // 缺 token
    ['/unknown', 'notfound'],
  ] as const)('%s -> %s', (path, want) => {
    expect(routeFor(path)).toBe(want);
  });
});

describe('tokenFor', () => {
  it('token 从路径里原样取出，不做解码猜测', () => {
    expect(tokenFor('/s/a-b_c')).toBe('a-b_c'); // base64url 含 - 和 _
  });

  it('非访客路径返回 null', () => {
    expect(tokenFor('/')).toBeNull();
    expect(tokenFor('/admin')).toBeNull();
    expect(tokenFor('/unknown')).toBeNull();
  });

  it('/s/ 缺 token 时返回 null', () => {
    expect(tokenFor('/s/')).toBeNull();
  });
});
