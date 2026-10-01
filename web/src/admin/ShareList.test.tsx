import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShareList, shareStatusOf } from './ShareList';

// **每个 .test.tsx 都要 afterEach(cleanup)**：这是 Task 1 定下的 jsdom 组件
// 测试环境的硬性要求，漏掉的话上一个用例挂载的 DOM 会污染下一个用例。
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SHARE_A = {
  id: 'sh_a', token: 'TOKEN_SHARE_A_SECRET', root: '/tmp/a', label: '婚礼初选',
  createdAt: 1000, createdBy: 'admin', expiresAt: null, revoked: false,
  allowUserCreation: true, defaultRole: 'editor' as const, maxUsers: null,
  userCount: 2, online: 1,
};

const SHARE_B = {
  ...SHARE_A, id: 'sh_b', token: 'TOKEN_SHARE_B_SECRET', label: '已撤销的分享',
  revoked: true, userCount: 0, online: 0,
};

function stubFetch(shares: unknown[]) {
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/admin/shares' && (!init || init.method === undefined)) {
      return { ok: true, json: async () => ({ shares }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('shareStatusOf（纯函数，与服务端 shares.js 的 shareStatus 同一套判定）', () => {
  it('未撤销、未过期 -> active', () => {
    expect(shareStatusOf({ revoked: false, expiresAt: null }, 5000)).toBe('active');
  });
  it('到期时刻算过期（>= 判定）', () => {
    expect(shareStatusOf({ revoked: false, expiresAt: 1000 }, 1000)).toBe('expired');
    expect(shareStatusOf({ revoked: false, expiresAt: 1000 }, 999)).toBe('active');
  });
  it('撤销压过过期：两者都成立时仍是 revoked', () => {
    expect(shareStatusOf({ revoked: true, expiresAt: 1000 }, 5000)).toBe('revoked');
  });
});

describe('ShareList', () => {
  it('加载后渲染分享列表，点击一行触发 onSelect', async () => {
    stubFetch([SHARE_A, SHARE_B]);
    const onSelect = vi.fn();
    render(<ShareList selectedId={null} onSelect={onSelect} now={2000} />);

    const rowA = await screen.findByText('婚礼初选');
    const user = userEvent.setup();
    await user.click(rowA);
    expect(onSelect).toHaveBeenCalledWith('sh_a');
  });

  it('已撤销的分享显示"已撤销"状态', async () => {
    stubFetch([SHARE_B]);
    render(<ShareList selectedId={null} onSelect={() => {}} now={2000} />);
    await screen.findByText('已撤销的分享');
    expect(screen.getByText('已撤销')).toBeTruthy();
  });

  it('界面上任何位置都不显示分享令牌', async () => {
    stubFetch([SHARE_A, SHARE_B]);
    const { container } = render(<ShareList selectedId={null} onSelect={() => {}} now={2000} />);
    await screen.findByText('婚礼初选');
    expect(container.textContent).not.toContain('TOKEN_SHARE_A_SECRET');
    expect(container.textContent).not.toContain('TOKEN_SHARE_B_SECRET');
  });

  it('新建分享：填表提交后调用 POST /api/admin/shares，成功后刷新列表', async () => {
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/admin/shares' && init?.method === 'POST') {
        return { ok: true, json: async () => ({ share: { ...SHARE_A, id: 'sh_new' } }) };
      }
      if (path === '/api/admin/shares') {
        return { ok: true, json: async () => ({ shares: [] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ShareList selectedId={null} onSelect={() => {}} now={2000} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /新建分享/ }));
    const rootInput = screen.getByPlaceholderText(/2026-07-26/);
    await user.type(rootInput, '/Users/photographer/Pictures/wedding');
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([p, i]) => p === '/api/admin/shares' && (i as RequestInit | undefined)?.method === 'POST');
      expect(postCall).toBeTruthy();
    });
    const [, init] = fetchMock.mock.calls.find(
      ([p, i]) => p === '/api/admin/shares' && (i as RequestInit | undefined)?.method === 'POST')!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.root).toBe('/Users/photographer/Pictures/wedding');
  });

  it('撤销分享前有二次确认，并说明在线访客会被立即断开', async () => {
    const fetchMock = stubFetch([SHARE_A]);
    render(<ShareList selectedId={null} onSelect={() => {}} now={2000} />);
    const user = userEvent.setup();

    await screen.findByText('婚礼初选');
    await user.click(screen.getByRole('button', { name: '撤销' }));

    const dialog = await screen.findByRole('dialog', { name: /确认撤销/ });
    expect(dialog.textContent).toMatch(/断开/);

    // 确认对话框弹出的这一刻还不能已经发出 DELETE 请求——那就不叫"二次确认"了。
    expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'DELETE')).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: '确认撤销' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(
        ([p, i]) => p === '/api/admin/shares/sh_a' && (i as RequestInit | undefined)?.method === 'DELETE',
      )).toBe(true);
    });
  });

  it('撤销对话框点取消不会发出请求', async () => {
    const fetchMock = stubFetch([SHARE_A]);
    render(<ShareList selectedId={null} onSelect={() => {}} now={2000} />);
    const user = userEvent.setup();

    await screen.findByText('婚礼初选');
    await user.click(screen.getByRole('button', { name: '撤销' }));
    const dialog = await screen.findByRole('dialog', { name: /确认撤销/ });
    await user.click(within(dialog).getByRole('button', { name: '取消' }));

    expect(screen.queryByRole('dialog', { name: /确认撤销/ })).toBeNull();
    expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
  });
});
