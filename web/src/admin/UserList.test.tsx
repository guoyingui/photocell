import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserList } from './UserList';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const USER_A = {
  id: 'u_a', shareId: 'sh_1', nickname: '新娘小林', role: 'editor' as const,
  createdAt: 1000, lastSeenAt: 2000, disabled: false,
};
const USER_B = {
  id: 'u_b', shareId: 'sh_1', nickname: '伴娘阿珍', role: 'viewer' as const,
  createdAt: 1000, lastSeenAt: 2000, disabled: true,
};

function stubFetch(users: unknown[]) {
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/admin/shares/sh_1/users' && !init) {
      return { ok: true, json: async () => ({ users }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('UserList', () => {
  it('没有选中分享时提示去左侧选择，不发请求', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<UserList shareId={null} />);
    expect(screen.getByText(/先在左侧选一条分享/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('加载并渲染用户列表', async () => {
    stubFetch([USER_A, USER_B]);
    render(<UserList shareId="sh_1" />);
    await screen.findByText('新娘小林');
    expect(screen.getByText('伴娘阿珍')).toBeTruthy();
  });

  it('界面上任何位置都不显示用户令牌', async () => {
    // 服务端 publicUser() 本就不会下发 token 字段，但即便某个上游意外带出了
    // 一个 token 字段，组件也绝不能把它渲染出来——用子串搜索而不是检查
    // props 里有没有 token 字段，后者防不住"字段改名"或者"改用 spread"。
    const withToken = { ...USER_A, token: 'USER_TOKEN_LEAKED_XYZ' };
    stubFetch([withToken]);
    const { container } = render(<UserList shareId="sh_1" />);
    await screen.findByText('新娘小林');
    expect(container.textContent).not.toContain('USER_TOKEN_LEAKED_XYZ');
  });

  it('角色切换后立即发出 PATCH，并乐观更新', async () => {
    const fetchMock = stubFetch([USER_A]);
    render(<UserList shareId="sh_1" />);
    await screen.findByText('新娘小林');

    const select = screen.getByDisplayValue('可标记') as HTMLSelectElement;
    const user = userEvent.setup();
    await user.selectOptions(select, '只读');

    // 乐观更新：不等 PATCH 的响应回来，select 的显示值已经变了。
    expect(select.value).toBe('viewer');

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([p, i]) => p === '/api/admin/shares/sh_1/users/u_a' && (i as RequestInit | undefined)?.method === 'PATCH');
      expect(patchCall).toBeTruthy();
    });
    const [, init] = fetchMock.mock.calls.find(
      ([p, i]) => p === '/api/admin/shares/sh_1/users/u_a' && (i as RequestInit | undefined)?.method === 'PATCH')!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ role: 'viewer' });
  });

  it('PATCH 失败时把角色回滚成失败前的值', async () => {
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/admin/shares/sh_1/users' && !init) {
        return { ok: true, json: async () => ({ users: [USER_A] }) };
      }
      if (init?.method === 'PATCH') {
        return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<UserList shareId="sh_1" />);
    await screen.findByText('新娘小林');
    const select = screen.getByDisplayValue('可标记') as HTMLSelectElement;
    const user = userEvent.setup();
    await user.selectOptions(select, '只读');

    await waitFor(() => expect(select.value).toBe('editor'));
  });

  it('禁用/启用一键切换，不需要二次确认', async () => {
    const fetchMock = stubFetch([USER_A]);
    render(<UserList shareId="sh_1" />);
    await screen.findByText('新娘小林');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /点击禁用/ }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(
        ([p, i]) => p === '/api/admin/shares/sh_1/users/u_a' && (i as RequestInit | undefined)?.method === 'PATCH',
      )).toBe(true);
    });
    const [, init] = fetchMock.mock.calls.find(
      ([p, i]) => p === '/api/admin/shares/sh_1/users/u_a' && (i as RequestInit | undefined)?.method === 'PATCH')!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ disabled: true });
  });

  it('删除用户前有二次确认（令牌立即失效不可撤销）', async () => {
    const fetchMock = stubFetch([USER_A]);
    render(<UserList shareId="sh_1" />);
    const user = userEvent.setup();

    await screen.findByText('新娘小林');
    await user.click(screen.getByRole('button', { name: '删除' }));

    const dialog = await screen.findByRole('dialog', { name: /确认删除/ });
    expect(dialog.textContent).toMatch(/不可撤销|立即失效/);

    expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'DELETE')).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: '确认删除' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(
        ([p, i]) => p === '/api/admin/shares/sh_1/users/u_a' && (i as RequestInit | undefined)?.method === 'DELETE',
      )).toBe(true);
    });
    // 删除成功后这一行从表格里消失。
    await waitFor(() => expect(screen.queryByText('新娘小林')).toBeNull());
  });

  it('删除对话框点取消不会发出请求，这一行还在', async () => {
    const fetchMock = stubFetch([USER_A]);
    render(<UserList shareId="sh_1" />);
    const user = userEvent.setup();

    await screen.findByText('新娘小林');
    await user.click(screen.getByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('dialog', { name: /确认删除/ });
    await user.click(within(dialog).getByRole('button', { name: '取消' }));

    expect(screen.queryByRole('dialog', { name: /确认删除/ })).toBeNull();
    expect(screen.getByText('新娘小林')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
  });
});
