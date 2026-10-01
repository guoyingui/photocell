import { beforeEach, describe, expect, it } from 'vitest';
import { setSession, useSession } from './session';

beforeEach(() => {
  // 每个用例开始前硬复位，避免前一个用例设过的 kind/user 泄漏过来。
  setSession({ kind: 'none', user: null, share: null, online: [] });
});

describe('canWrite', () => {
  it.each([
    ['admin', null, true],
    ['user', 'viewer', false],
    ['user', 'editor', true],
  ] as const)('kind=%s role=%s -> %s', (kind, role, want) => {
    setSession({
      kind,
      user: role ? { id: 'u1', nickname: '测试用户', role } : null,
    });
    expect(useSession.getState().canWrite()).toBe(want);
  });

  it('kind=none 时为 false（身份尚未确定）', () => {
    expect(useSession.getState().canWrite()).toBe(false);
  });
});

describe('setSession', () => {
  it('是 useSession.setState 的等价写入口，只改传入的字段', () => {
    setSession({ kind: 'admin' });
    expect(useSession.getState().kind).toBe('admin');
    expect(useSession.getState().online).toEqual([]); // 没传的字段保持不变

    setSession({ online: [{ id: 'u1', nickname: '小林', role: 'editor' }] });
    expect(useSession.getState().kind).toBe('admin'); // 上一次设的字段没被这次覆盖掉
    expect(useSession.getState().online).toHaveLength(1);
  });
});
