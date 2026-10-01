import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventLog } from './EventLog';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function evt(i: number, extra: Record<string, unknown> = {}) {
  return { ts: 1000 + i, actor: 'admin', nickname: '新娘小林', action: 'mark.set', assetId: `a${i}`, ...extra };
}

function parseQuery(path: string) {
  const [, qs] = path.split('?');
  return Object.fromEntries(new URLSearchParams(qs ?? ''));
}

describe('EventLog', () => {
  it('没有选中分享时提示去左侧选择，不发请求', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<EventLog shareId={null} />);
    expect(screen.getByText(/先在左侧选一条分享/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('加载并按时间倒序渲染事件', async () => {
    const events = [evt(2), evt(1), evt(0)];
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ events, total: 3, offset: 0, limit: 50 }),
    })));
    render(<EventLog shareId="sh_1" />);
    // 用 `selector: 'td'` 把断言限定在表格单元格里——"动作"过滤下拉框里
    // 本来就有一个文本是 "mark.set" 的 <option>，不排除掉的话这里会数错；
    // 三条记录本身就有三个匹配，所以等待也要用 queryAllByText 而不是单数版本
    // （单数的 find/getByText 遇到多个匹配会直接抛错，等不到"稳定"这一刻）。
    await waitFor(() => expect(screen.queryAllByText('mark.set', { selector: 'td' })).toHaveLength(3));
    expect(screen.getAllByText('新娘小林', { selector: 'td' })).toHaveLength(3);
  });

  it('界面上任何位置都不显示令牌', async () => {
    // 令牌照规矩根本不该出现在服务端下发的事件里（redactTokens 早在写日志
    // 那一步就把它挡掉了），但这里仍然要证明：即便某条记录意外带了一个
    // token 字段，"详情"列的 JSON.stringify 也会原样把它印出来给管理员看，
    // 所以这条用例断言的是一个更根本的事实——没有任何事件字段叫 token。
    const events = [evt(0, { note: 'ok' })];
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ events, total: 1, offset: 0, limit: 50 }),
    })));
    const { container } = render(<EventLog shareId="sh_1" />);
    await screen.findByText('mark.set', { selector: 'td' });
    expect(container.textContent).not.toMatch(/[A-Za-z0-9_-]{43}/); // 令牌是 43 字符 base64url
  });

  it('按 actor 过滤会带上查询参数重新请求', async () => {
    const fetchMock = vi.fn(async (path: string) => ({
      ok: true, json: async () => ({ events: [], total: 0, offset: 0, limit: 50 }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(<EventLog shareId="sh_1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('操作者'), 'u_1');

    await waitFor(() => {
      const last = fetchMock.mock.calls.at(-1)![0] as string;
      expect(parseQuery(last).actor).toBe('u_1');
    });
  });

  it('按 action 过滤与 actor 过滤叠加，而不是互相覆盖', async () => {
    const fetchMock = vi.fn(async (path: string) => ({
      ok: true, json: async () => ({ events: [], total: 0, offset: 0, limit: 50 }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(<EventLog shareId="sh_1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('操作者'), 'u_1');
    await user.selectOptions(screen.getByLabelText('动作'), 'user.role-change');

    await waitFor(() => {
      const last = fetchMock.mock.calls.at(-1)![0] as string;
      const q = parseQuery(last);
      expect(q.actor).toBe('u_1');
      expect(q.action).toBe('user.role-change');
    });
  });

  it('日志表分页不丢行：加载更多累加而不是替换', async () => {
    const page1 = Array.from({ length: 2 }, (_, i) => evt(i));
    const page2 = Array.from({ length: 2 }, (_, i) => evt(i + 2));
    const fetchMock = vi.fn(async (path: string) => {
      const q = parseQuery(path);
      const offset = Number(q.offset ?? '0');
      return {
        ok: true,
        json: async () => ({
          events: offset === 0 ? page1 : page2,
          total: 4,
          offset,
          limit: 2,
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<EventLog shareId="sh_1" />);
    await waitFor(() => expect(screen.getAllByText('mark.set', { selector: 'td' })).toHaveLength(2));

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /加载更多/ }));

    await waitFor(() => expect(screen.getAllByText('mark.set', { selector: 'td' })).toHaveLength(4));
    // 全部加载完之后"加载更多"按钮消失，不留一个点了也没反应的死按钮。
    await waitFor(() => expect(screen.queryByRole('button', { name: /加载更多/ })).toBeNull());
  });

  it('切换过滤条件会重置分页回到第一页', async () => {
    const fetchMock = vi.fn(async (path: string) => {
      const q = parseQuery(path);
      return {
        ok: true,
        json: async () => ({
          events: q.actor === 'u_9' ? [] : [evt(0)],
          total: q.actor === 'u_9' ? 0 : 5,
          offset: Number(q.offset ?? '0'),
          limit: 50,
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<EventLog shareId="sh_1" />);
    await screen.findByRole('button', { name: /加载更多/ });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('操作者'), 'u_9');

    await waitFor(() => {
      const last = fetchMock.mock.calls.at(-1)![0] as string;
      expect(parseQuery(last).offset).toBe('0');
    });
  });

  it('CSV 导出链接携带当前过滤条件', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ events: [], total: 0, offset: 0, limit: 50 }),
    })));
    render(<EventLog shareId="sh_1" />);
    await waitFor(() => {});

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('动作'), 'user.join');

    await waitFor(() => {
      const link = screen.getByRole('link', { name: /导出 CSV/ }) as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe('/api/admin/shares/sh_1/events.csv?action=user.join');
    });
  });

  it('提示文案说明了 actor 语义的坑：管理员对某成员的操作 actor 记为 admin', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ events: [], total: 0, offset: 0, limit: 50 }),
    })));
    render(<EventLog shareId="sh_1" />);
    await waitFor(() => {});
    expect(screen.getByText(/admin/)).toBeTruthy();
  });
});
