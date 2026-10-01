import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JoinGate } from './JoinGate';
import { useSession } from '../store/session';

// JoinGate 自己只用 lib/api 的三个函数（getJSON/postJSON/setSessionId）。
// 用 vi.hoisted 把替身提到 vi.mock 工厂能看见的地方，和本仓库 ExportPanel.test.tsx
// 的写法保持一致——工厂函数在模块求值早期就跑，直接引用外层的 const 会因为
// 时间顺序拿到 undefined。
//
// 工厂里必须把 lib/api 的**全部**导出给齐：JoinGate 从 Task 16 起会渲染
// GuestApp，那条 import 链会把 store/library 拖进来，而它在模块顶层就调用
// setSessionGoneHandler——少一个导出，整份用例在求值期就炸，一条都跑不到。
const apiMock = vi.hoisted(() => ({
  getJSON: vi.fn(),
  postJSON: vi.fn(),
  setSessionId: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  getJSON: apiMock.getJSON,
  postJSON: apiMock.postJSON,
  setSessionId: apiMock.setSessionId,
  putJSON: vi.fn(() => Promise.resolve({})),
  openStream: vi.fn(() => () => {}),
  withSid: (u: string) => u,
  getSessionId: vi.fn(() => null),
  setSessionGoneHandler: vi.fn(),
}));

/** 构造一个形状与真实 ApiError 一致的拒绝值：Error 实例 + status + 其余字段。 */
function apiError(status: number, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

const INFO_OK = Object.freeze({
  label: '婚礼初选给新人',
  assetCountHint: 1284,
  allowUserCreation: true,
  requiresNickname: true,
  expiresAt: null,
});

const JOIN_OK = Object.freeze({
  sessionId: 'sess-1',
  user: { id: 'u_1', nickname: '新娘小林', role: 'editor' as const },
  share: { label: '婚礼初选给新人' },
  assetCount: 1284,
  warnings: [],
  skippedFiles: [],
  settings: {},
  marksRecovered: false,
});

/** 大多数用例都需要 resume 以 401 need-join 收场（正常路径：没有 Cookie），
 *  只有"回访恢复"那一条要让它成功。 */
function rejectResumeWithNeedJoin(path: string) {
  if (path.endsWith('/resume')) return Promise.reject(apiError(401, '', { error: 'need-join' }));
  throw new Error('unexpected call: ' + path);
}

beforeEach(() => {
  apiMock.getJSON.mockReset();
  apiMock.postJSON.mockReset();
  apiMock.setSessionId.mockReset();
  useSession.setState({ kind: 'none', user: null, share: null, online: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('链接无效', () => {
  it('整页阻断，且不显示昵称表单', async () => {
    apiMock.getJSON.mockRejectedValue(apiError(404, '链接不存在或已失效', { error: 'invalid-link' }));

    render(<JoinGate token="dead-token" />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('链接不存在或已失效');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /加入/ })).toBeNull();
    // 不该因为链接无效就去尝试 resume——info 都拿不到，没有 share 可谈。
    expect(apiMock.postJSON).not.toHaveBeenCalled();
  });
});

describe('昵称建号', () => {
  it('昵称被占用时内联报错，且保留已输入内容', async () => {
    apiMock.getJSON.mockResolvedValue(INFO_OK);
    apiMock.postJSON.mockImplementation((path: string) => {
      if (path.endsWith('/resume')) return rejectResumeWithNeedJoin(path);
      return Promise.reject(apiError(409, '这个昵称已经有人在用了，换一个吧', { error: 'nickname-taken' }));
    });

    const user = userEvent.setup();
    render(<JoinGate token="tok-1" />);

    const input = await screen.findByRole('textbox');
    await user.type(input, '新娘小林');
    await user.click(screen.getByRole('button', { name: /加入/ }));

    await screen.findByText('这个昵称已经有人在用了，换一个吧');
    expect((input as HTMLInputElement).value).toBe('新娘小林');
  });

  it.each([
    ['creation-off', 403, '这条链接已停止接纳新成员', /已停止接纳新成员/],
    ['full', 403, '参与人数已达上限', /人数已达上限/],
    ['rate-limited', 429, '尝试过于频繁，请稍后再试', /尝试过于频繁/],
  ])('%s 显示 %s', async (code, status, serverMessage, expectRe) => {
    apiMock.getJSON.mockResolvedValue(INFO_OK);
    apiMock.postJSON.mockImplementation((path: string) => {
      if (path.endsWith('/resume')) return rejectResumeWithNeedJoin(path);
      return Promise.reject(apiError(status, serverMessage, { error: code }));
    });

    const user = userEvent.setup();
    render(<JoinGate token="tok-1" />);

    const input = await screen.findByRole('textbox');
    await user.type(input, '路人甲');
    await user.click(screen.getByRole('button', { name: /加入/ }));

    await screen.findByText(expectRe);
  });
});

describe('回访', () => {
  it('带有效 Cookie 时跳过昵称表单直接进入', async () => {
    apiMock.getJSON.mockResolvedValue(INFO_OK);
    apiMock.postJSON.mockImplementation((path: string) => {
      if (path.endsWith('/resume')) return Promise.resolve(JOIN_OK);
      throw new Error('unexpected call: ' + path);
    });

    render(<JoinGate token="tok-1"><div>访客选片界面占位</div></JoinGate>);

    await screen.findByText('访客选片界面占位');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(useSession.getState().kind).toBe('user');
    expect(useSession.getState().user?.nickname).toBe('新娘小林');
    expect(apiMock.setSessionId).toHaveBeenCalledWith('sess-1');
  });
});

describe('加入之后', () => {
  it('渲染访客选片界面，而不是一句"即将呈现"的占位', async () => {
    apiMock.getJSON.mockImplementation((path: string) => {
      if (path.includes('/api/share/')) return Promise.resolve(INFO_OK);
      // 照片一直在路上：GuestApp 停在自己的载入态，不必拖起整个网格。
      return new Promise(() => {});
    });
    apiMock.postJSON.mockImplementation((path: string) => {
      if (path.endsWith('/resume')) return Promise.resolve(JOIN_OK);
      throw new Error('unexpected call: ' + path);
    });

    // 不传 children —— 走的正是真实入口那条路径。
    render(<JoinGate token="tok-1" />);

    await screen.findByText('正在载入照片…');
    // 占位界面不会去拉这一场的照片；这一条才是"接上了"的实证。
    expect(apiMock.getJSON).toHaveBeenCalledWith('/api/library/assets');
  });
});

describe('提交中', () => {
  it('禁用按钮，避免重复建号', async () => {
    apiMock.getJSON.mockResolvedValue(INFO_OK);
    let resolveJoin: ((v: typeof JOIN_OK) => void) | null = null;
    apiMock.postJSON.mockImplementation((path: string) => {
      if (path.endsWith('/resume')) return rejectResumeWithNeedJoin(path);
      return new Promise((resolve) => { resolveJoin = resolve; });
    });

    const user = userEvent.setup();
    // 传 children：这一条测的是"提交中按钮禁用"，不需要把整棵选片树
    // （Grid + 虚拟列表 + 缩略图）拖起来。
    render(<JoinGate token="tok-1"><div>访客选片界面占位</div></JoinGate>);

    const input = await screen.findByRole('textbox');
    await user.type(input, '路人甲');
    const button = screen.getByRole('button', { name: /加入/ });

    await user.click(button);
    // 没有装 @testing-library/jest-dom，用原生 DOM 属性断言 disabled 状态。
    expect((button as HTMLButtonElement).disabled).toBe(true);

    resolveJoin!(JOIN_OK);
    await waitFor(() => expect(useSession.getState().kind).toBe('user'));
  });
});
