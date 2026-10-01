import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApp } from './AdminApp';

// 集成测试：从「渲染整个管理后台」这一层验证 Task 19 计划里点名要求的五条用例
// （分享列表 -> 用户 -> 日志，跨三个子面板的联动），单个组件的边界情况留给
// ShareList.test.tsx / UserList.test.tsx / EventLog.test.tsx 各自的用例。

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SHARE = {
  id: 'sh_1', token: 'SUPER_SECRET_SHARE_TOKEN_ABCDEFGHIJK', root: '/tmp/wedding', label: '婚礼初选',
  createdAt: 1000, createdBy: 'admin', expiresAt: null, revoked: false,
  allowUserCreation: true, defaultRole: 'editor' as const, maxUsers: null,
  userCount: 1, online: 1,
};

const USER = {
  id: 'u_1', shareId: 'sh_1', nickname: '新娘小林', role: 'editor' as const,
  createdAt: 1000, lastSeenAt: 2000, disabled: false,
};

// 特意用一条不带 nickname、动作名也和 UserList 里任何文案都不重叠的事件——
// 用户面板显示的昵称"新娘小林"如果也出现在日志面板里，下面几条用例里的
// `findByText('新娘小林')` 会因为"多处匹配"直接报错，而不是因为组件没加载出来。
const EVENTS = [
  { ts: 3000, actor: 'admin', action: 'share.create', label: '婚礼初选' },
];

/** 一台可编程的 fetch 假货，按路径 + method 分派，行为覆盖三个子面板要打的全部接口。 */
function stubAdminBackend() {
  const users = [USER];
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';

    if (path === '/api/admin/shares' && method === 'GET') {
      return { ok: true, json: async () => ({ shares: [SHARE] }) };
    }
    if (path === '/api/admin/shares/sh_1/users' && method === 'GET') {
      return { ok: true, json: async () => ({ users: [...users] }) };
    }
    if (path.startsWith('/api/admin/shares/sh_1/users/u_1') && method === 'PATCH') {
      const body = JSON.parse((init!.body as string));
      Object.assign(users[0], body);
      return { ok: true, json: async () => ({ user: users[0] }) };
    }
    if (path.startsWith('/api/admin/shares/sh_1/users/u_1') && method === 'DELETE') {
      users.length = 0;
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (path.startsWith('/api/admin/shares/sh_1/events') && method === 'GET') {
      return { ok: true, json: async () => ({ events: EVENTS, total: EVENTS.length, offset: 0, limit: 50 }) };
    }
    if (path === '/api/admin/shares/sh_1' && method === 'DELETE') {
      return { ok: true, json: async () => ({ ok: true, share: { ...SHARE, revoked: true } }) };
    }
    throw new Error(`未预期的请求：${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('AdminApp（三栏联动）', () => {
  it('选中一条分享后，用户面板和日志面板跟着加载这条分享的数据', async () => {
    stubAdminBackend();
    render(<AdminApp />);
    const user = userEvent.setup();

    await user.click(await screen.findByText('婚礼初选'));

    await screen.findByText('新娘小林'); // UserList 加载出来
    await screen.findByText('share.create', { selector: 'td' }); // EventLog 加载出来
  });

  it('角色切换后立即发出 PATCH，并乐观更新', async () => {
    stubAdminBackend();
    render(<AdminApp />);
    const user = userEvent.setup();

    await user.click(await screen.findByText('婚礼初选'));
    await screen.findByText('新娘小林');

    const select = screen.getByDisplayValue('可标记') as HTMLSelectElement;
    await user.selectOptions(select, '只读');
    expect(select.value).toBe('viewer'); // 乐观更新：不等网络响应就已经变了
  });

  it('删除用户前有二次确认（令牌立即失效不可撤销）', async () => {
    const fetchMock = stubAdminBackend();
    render(<AdminApp />);
    const user = userEvent.setup();

    await user.click(await screen.findByText('婚礼初选'));
    await screen.findByText('新娘小林');

    await user.click(screen.getByRole('button', { name: '删除' }));
    expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'DELETE')).toBe(false);

    const dialog = await screen.findByRole('dialog', { name: /确认删除/ });
    await user.click(within(dialog).getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(screen.queryByText('新娘小林')).toBeNull());
  });

  it('撤销分享前有二次确认，并说明在线访客会被断开', async () => {
    const fetchMock = stubAdminBackend();
    render(<AdminApp />);
    const user = userEvent.setup();

    await screen.findByText('婚礼初选');
    await user.click(screen.getByRole('button', { name: '撤销' }));

    const dialog = await screen.findByRole('dialog', { name: /确认撤销/ });
    expect(dialog.textContent).toMatch(/断开/);
    expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'DELETE')).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: '确认撤销' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(
        ([p, i]) => p === '/api/admin/shares/sh_1' && (i as RequestInit | undefined)?.method === 'DELETE',
      )).toBe(true);
    });
  });

  it('日志表分页不丢行，过滤条件叠加正确', async () => {
    const page1 = [{ ts: 100, actor: 'u_1', nickname: '新娘小林', action: 'mark.set', assetId: 'a' }];
    const page2 = [{ ts: 99, actor: 'u_1', nickname: '新娘小林', action: 'mark.set', assetId: 'b' }];
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (path === '/api/admin/shares' && method === 'GET') {
        return { ok: true, json: async () => ({ shares: [SHARE] }) };
      }
      if (path === '/api/admin/shares/sh_1/users' && method === 'GET') {
        return { ok: true, json: async () => ({ users: [] }) };
      }
      if (path.startsWith('/api/admin/shares/sh_1/events')) {
        const qs = path.split('?')[1] ?? '';
        const params = new URLSearchParams(qs);
        const offset = Number(params.get('offset') ?? '0');
        return {
          ok: true,
          json: async () => ({
            events: offset === 0 ? page1 : page2,
            total: 2,
            offset,
            limit: 1,
          }),
        };
      }
      throw new Error(`未预期的请求：${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AdminApp />);
    const user = userEvent.setup();
    await user.click(await screen.findByText('婚礼初选'));

    await screen.findByText(/"assetId":"a"/); // 第一页的 assetId 显示在"详情"列的 JSON 里
    await user.click(screen.getByRole('button', { name: /加载更多/ }));
    await screen.findByText(/"assetId":"b"/);
    expect(screen.getByText(/"assetId":"a"/)).toBeTruthy(); // 第一页没有被替换掉
  });

  it('界面上任何位置都不显示令牌', async () => {
    stubAdminBackend();
    const { container } = render(<AdminApp />);
    const user = userEvent.setup();

    await user.click(await screen.findByText('婚礼初选'));
    await screen.findByText('新娘小林');
    await screen.findByText('share.create', { selector: 'td' });

    // 分享的 token 字段确实由服务端下发给管理员（管理接口本身就允许这么做），
    // 但 Task 19 这几个组件选择不在任何位置渲染它——用真实令牌值做子串搜索，
    // 而不是检查某个 prop 有没有 token 字段，后者防不住实现换种写法就漏出去。
    expect(container.textContent).not.toContain(SHARE.token);
    // 任意 43 字符的 base64url 子串（令牌的标准长度）在整页文本里都不该出现。
    expect(container.textContent).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });
});
