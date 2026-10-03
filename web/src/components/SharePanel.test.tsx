import { cleanup, render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SharePanel, expiresAtForPreset } from './SharePanel';

// SharePanel 只在本地界面（admin-only 的 `/`）里挂载，打开时会立刻拉
// GET /api/admin/shares 和 GET /api/admin/netaddr。这两个请求、以及新建/
// 撤销/切换新成员开关用到的写请求，在 jsdom + Node 环境下都没有真实网络，
// 所以把 '../lib/api' 整个替身化，行为由各用例按需覆盖——与 ExportPanel.test.tsx
// 同一套约定。
const apiMock = vi.hoisted(() => ({
  getJSON: vi.fn(),
  postJSON: vi.fn(),
  putJSON: vi.fn(),
  patchJSON: vi.fn(),
  deleteJSON: vi.fn(),
  openStream: vi.fn(),
  getSessionId: vi.fn(() => 'sess-1'),
}));

vi.mock('../lib/api', () => ({
  getJSON: apiMock.getJSON,
  postJSON: apiMock.postJSON,
  putJSON: apiMock.putJSON,
  // PATCH（改「允许新成员」）和 DELETE（撤销）以前是 SharePanel 自己造的一份
  // fetch 封装，Task 17 把它们并回了 lib/api.ts。
  patchJSON: apiMock.patchJSON,
  deleteJSON: apiMock.deleteJSON,
  openStream: apiMock.openStream,
  withSid: (u: string) => u,
  setSessionId: vi.fn(),
  getSessionId: apiMock.getSessionId,
  setSessionGoneHandler: vi.fn(),
}));

interface ShareFixture {
  id: string; token: string; root: string; label: string;
  createdAt: number; createdBy?: string; expiresAt: number | null;
  revoked: boolean; allowUserCreation: boolean; defaultRole: 'viewer' | 'editor';
  maxUsers: number | null; showPeerMarks: boolean; userCount: number; online: number;
}

function makeShare(overrides: Partial<ShareFixture> = {}): ShareFixture {
  return {
    id: 'sh_1', token: 'tok_' + 'x'.repeat(39), root: '/Users/photographer/雨婚礼',
    label: '婚礼精选', createdAt: 1000, createdBy: 'admin', expiresAt: null,
    revoked: false, allowUserCreation: true, defaultRole: 'editor',
    maxUsers: null, showPeerMarks: true, userCount: 0, online: 0,
    ...overrides,
  };
}

function mockNetaddr(overrides: Partial<{ share: boolean; port: number | null; addresses: unknown[]; canControl: boolean }> = {}) {
  return { share: false, port: 5183, addresses: [], ...overrides };
}

/** 按 path 分派 getJSON 的两个固定端点，其余按需在各用例里覆盖。 */
function wireGetJSON(shares: ShareFixture[], net: ReturnType<typeof mockNetaddr>) {
  apiMock.getJSON.mockImplementation((path: string) => {
    if (path.includes('/api/admin/netaddr')) return Promise.resolve(net);
    if (path.includes('/api/admin/shares')) return Promise.resolve({ shares });
    return Promise.reject(new Error('unexpected path: ' + path));
  });
}

beforeEach(() => {
  apiMock.getJSON.mockReset();
  apiMock.postJSON.mockReset().mockResolvedValue({ share: makeShare() });
  apiMock.putJSON.mockReset();
  apiMock.patchJSON.mockReset().mockResolvedValue({ ok: true });
  apiMock.deleteJSON.mockReset().mockResolvedValue({ ok: true });
  apiMock.openStream.mockReset().mockImplementation(() => () => {});
});

afterEach(() => {
  // @testing-library/react 在没开 test.globals 的项目里探测不到全局 afterEach，
  // 不会自动注册卸载——上一条用例的 DOM 会一直挂在 jsdom 的 document 上，
  // 下一条用例的查询就会在两份重叠的表单里卡住（ExportPanel.test.tsx 踩过这个坑）。
  cleanup();
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 计划 Task 18 给出的四条用例
// ─────────────────────────────────────────────────────────────────────────────

describe('界面分享开关与二维码', () => {
  it('本机主动开启后才显示地址与二维码，关闭后隐藏链接', async () => {
    const addresses = [{ address: '192.168.1.5', family: 'IPv4', interface: 'en0' }];
    wireGetJSON([makeShare()], mockNetaddr({ canControl: true, addresses }));
    apiMock.putJSON.mockResolvedValueOnce(mockNetaddr({ canControl: true, share: true, port: 5184, addresses }))
      .mockResolvedValueOnce(mockNetaddr({ canControl: true, share: false, addresses }));
    render(<SharePanel open onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '开启局域网分享' }));
    const radio = await screen.findByRole('radio', { name: '192.168.1.5' }); fireEvent.click(radio);
    expect(screen.getByText(`http://192.168.1.5:5184/s/${makeShare().token}`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '二维码' }));
    expect(screen.getByRole('img', { name: '分享链接二维码' }).getAttribute('src')).toBe('/api/admin/share-qr?id=sh_1&address=192.168.1.5');
    fireEvent.click(screen.getByRole('button', { name: '关闭局域网分享' }));
    await screen.findByRole('button', { name: '开启局域网分享' }); expect(screen.queryByRole('img', { name: '分享链接二维码' })).toBeNull();
    expect(apiMock.putJSON.mock.calls).toEqual([['/api/admin/network', { enabled: true }], ['/api/admin/network', { enabled: false }]]);
  });
  it('开启失败保持未分享状态并展示失败原因', async () => {
    wireGetJSON([], mockNetaddr({ canControl: true })); apiMock.putJSON.mockRejectedValueOnce(new Error('分享端口被占用'));
    render(<SharePanel open onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '开启局域网分享' }));
    await screen.findByText('分享端口被占用'); expect(screen.getByRole('button', { name: '开启局域网分享' })).toBeTruthy();
  });
});

describe('关闭按钮', () => {
  it('标题行右侧有固定的关闭按钮', async () => {
    const onClose = vi.fn();
    wireGetJSON([], mockNetaddr());
    const { container } = render(<SharePanel open onClose={onClose} />);
    await screen.findByText(/这个链接就是密码/);
    const head = container.querySelector('.share-head') as HTMLElement;
    expect(head).toBeTruthy();
    expect(head.querySelector('h2')?.textContent).toBe('分享');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('风险提示', () => {
  it('面板里出现「链接即密码」的风险提示', async () => {
    wireGetJSON([], mockNetaddr());
    render(<SharePanel open onClose={() => {}} />);
    expect(await screen.findByText(/这个链接就是密码，拿到的人都能进/)).toBeTruthy();
  });
});

describe('未开启 --share 时的提示', () => {
  it('未开启 --share 时提示需要重启并给出命令，而不是给一个连不上的 localhost 链接', async () => {
    // 故意让服务端仍然探测到了地址（分享面板收到的和真实的 netaddr 响应一致：
    // shareMode=false 时 lanAddresses() 照常返回，不为空）——用来证明"没开
    // --share 时不给链接"这条判断真的看的是 share 这个字段，不是"地址列表
    // 是不是空的"。同时喂一条已有分享，确认它不会被拼成一条假链接。
    wireGetJSON(
      [makeShare({ label: '客户 A' })],
      mockNetaddr({ share: false, addresses: [{ address: '192.168.1.5', family: 'IPv4', interface: 'en0' }] }),
    );
    const { container } = render(<SharePanel open onClose={() => {}} />);

    await screen.findByText(/尚未开启局域网分享/);
    // 命令本身必须原样出现，客户不能只看到一句"请重启"却不知道该敲什么。
    expect(screen.getByText('npm start -- --share')).toBeTruthy();

    // 不给一条连不上的分享链接：不出现"复制链接"这个动作，也不出现
    // 拼好的 /s/<token> 路径——哪怕已经有一条分享、哪怕探测到了地址。
    // （文案里解释"为什么 http://127.0.0.1 打不开"允许提到这个前缀本身，
    // 那是说明文字，不是一条可点的链接，所以断言精确到 /s/ 这个访客路径。）
    expect(screen.queryByText(/复制链接/)).toBeNull();
    expect(container.querySelector('.share-link-text')).toBeNull();
    expect(container.textContent).not.toContain('/s/');
    // 地址选择器（正常分享模式下才会出现）也不应该被渲染出来。
    expect(screen.queryByRole('heading', { name: /选择.*网络地址/ })).toBeNull();
  });
});

describe('多网卡地址候选', () => {
  it('多网卡时列出全部候选地址，不自动选一个', async () => {
    // 复刻真实场景（终审实测过的这台机器）：3 个 IPv4 + 7 个 IPv6，
    // 分布在好几张网卡上，多数 IPv6 是会轮换的临时地址。
    const addresses = [
      { address: '192.168.1.5', family: 'IPv4', interface: 'en0' },
      { address: '192.168.56.1', family: 'IPv4', interface: 'en1' },
      { address: '10.0.0.8', family: 'IPv4', interface: 'utun0' },
      { address: '2001:db8:1::aaaa', family: 'IPv6', interface: 'en0' },
      { address: '2001:db8:1::bbbb', family: 'IPv6', interface: 'en0' },
      { address: '2001:db8:1::cccc', family: 'IPv6', interface: 'en0' },
      { address: '2001:db8:2::1111', family: 'IPv6', interface: 'en1' },
      { address: '2001:db8:2::2222', family: 'IPv6', interface: 'en1' },
      { address: 'fd00::1', family: 'IPv6', interface: 'utun0' },
      { address: 'fd00::2', family: 'IPv6', interface: 'utun1' },
    ];
    wireGetJSON([makeShare()], mockNetaddr({ share: true, port: 5183, addresses }));
    const { container } = render(<SharePanel open onClose={() => {}} />);

    await screen.findByRole('heading', { name: /选择.*网络地址/ });

    // 服务端返回的每一个地址都必须出现在 DOM 里——前端不能替人过滤掉任何一个，
    // 哪怕是折叠在 <details> 里的 IPv6（jsdom 的文本查询不受视觉折叠影响）。
    for (const a of addresses) {
      expect(container.textContent).toContain(a.address);
    }

    // 全部候选都是单选框，且没有一个是默认选中的——"不自动挑一个" 是硬要求，
    // 不是"挑一个看起来最常用的"。
    const radios = container.querySelectorAll('input[type="radio"]');
    expect(radios.length).toBe(addresses.length);
    expect(Array.from(radios).some((r) => (r as HTMLInputElement).checked)).toBe(false);

    // 没有选定地址之前，复制链接不该出现一个可用的 URL。
    expect(container.textContent).not.toMatch(/http:\/\/192\.168/);
  });
});

describe('有效期预设换算', () => {
  it('有效期预设换算正确（24 小时 = now + 86400000）', () => {
    const now = 1_700_000_000_000;
    expect(expiresAtForPreset('24h', now)).toBe(now + 86_400_000);
    expect(expiresAtForPreset('7d', now)).toBe(now + 7 * 86_400_000);
    expect(expiresAtForPreset('30d', now)).toBe(now + 30 * 86_400_000);
    expect(expiresAtForPreset('never', now)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 补充：四个闸门（有效期 / 撤销 / 人数上限 / 关闭新成员）必须是面板里
// 可操作的控件，不能只是文档里提到过。
// ─────────────────────────────────────────────────────────────────────────────

describe('四个闸门都在面板里可操作', () => {
  it('新建表单包含有效期预设、人数上限、允许新成员开关；已有分享可以撤销', async () => {
    wireGetJSON([makeShare({ label: '客户 A' })], mockNetaddr({ share: false }));
    render(<SharePanel open onClose={() => {}} />);

    await screen.findByText('客户 A');

    expect(screen.getByLabelText(/有效期/)).toBeTruthy();
    expect(screen.getByLabelText(/人数上限/)).toBeTruthy();
    expect(screen.getByLabelText(/允许新成员加入/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '撤销' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '关闭新成员' })).toBeTruthy();
  });

  it('新建分享时把有效期预设换算成的 expiresAt 传给服务端', async () => {
    wireGetJSON([], mockNetaddr());
    render(<SharePanel open onClose={() => {}} />);
    await screen.findByRole('heading', { name: '新建分享' });

    const label = screen.getByLabelText(/^标签/) as HTMLInputElement;
    fireEvent.change(label, { target: { value: '客户 B' } });

    const presetSelect = screen.getByLabelText(/有效期/) as HTMLSelectElement;
    fireEvent.change(presetSelect, { target: { value: '24h' } });

    fireEvent.click(screen.getByRole('button', { name: '新建分享' }));

    await vi.waitFor(() => expect(apiMock.postJSON).toHaveBeenCalled());
    const [path, body] = apiMock.postJSON.mock.calls[0];
    expect(path).toBe('/api/admin/shares');
    expect(body).toMatchObject({ label: '客户 B', defaultRole: 'editor', allowUserCreation: true, maxUsers: null });
    expect(typeof body.expiresAt).toBe('number');
  });

  it('撤销需要二次确认，确认前不会发出请求', async () => {
    wireGetJSON([makeShare({ label: '客户 C' })], mockNetaddr());
    render(<SharePanel open onClose={() => {}} />);
    await screen.findByText('客户 C');

    const row = screen.getByText('客户 C').closest('.share-row') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '撤销' }));

    // 点一次"撤销"只应该弹出二次确认，不能已经把链接撤掉了——在线的客户
    // 会当场被断开，这一步没有回头路。用不重叠的文案分别定位提示语和确认
    // 按钮，避免 "确定撤销" 这个词同时出现在提示语和按钮上导致查询有歧义。
    expect(within(row).getByText(/在线访客会立即被断开/)).toBeTruthy();
    expect(within(row).getByRole('button', { name: '确定撤销' })).toBeTruthy();
    // DELETE 并回 lib/api.ts 之后（Task 17），"有没有真的发出去"终于是可断言的了。
    expect(apiMock.deleteJSON).not.toHaveBeenCalled();

    fireEvent.click(within(row).getByRole('button', { name: '确定撤销' }));
    await vi.waitFor(() => expect(apiMock.deleteJSON).toHaveBeenCalledWith('/api/admin/shares/sh_1'));
  });

  it('切换"允许新成员"走 PATCH，且只改这一个字段', async () => {
    wireGetJSON([makeShare({ label: '客户 D', allowUserCreation: true })], mockNetaddr());
    render(<SharePanel open onClose={() => {}} />);
    await screen.findByText('客户 D');

    fireEvent.click(screen.getByRole('button', { name: '关闭新成员' }));

    await vi.waitFor(() => expect(apiMock.patchJSON).toHaveBeenCalledWith(
      '/api/admin/shares/sh_1', { allowUserCreation: false }));
  });

  it('新建时带上 showPeerMarks，默认公开', async () => {
    // 默认值必须和服务端 createShare 的默认值是同一个口径。这里勾的是
    // "默认勾上"这件事本身——表单默认不勾的话，摄影师什么都没动，
    // 建出来的分享却是「客户互相看不见」，和他之前建的每一条都不一样。
    wireGetJSON([], mockNetaddr());
    render(<SharePanel open onClose={() => {}} />);
    await screen.findByText('已有的分享');

    fireEvent.click(screen.getByRole('button', { name: '新建分享' }));

    await vi.waitFor(() => expect(apiMock.postJSON).toHaveBeenCalled());
    expect(apiMock.postJSON.mock.calls[0][1]).toMatchObject({ showPeerMarks: true });
  });

  it('取消勾选后新建的分享是不公开的', async () => {
    // 只验默认值的话，一个把 showPeerMarks 写死成 true 的实现照样全绿——
    // 而那正好让这个复选框变成一个点得动、但什么也不改变的摆设。
    wireGetJSON([], mockNetaddr());
    render(<SharePanel open onClose={() => {}} />);
    await screen.findByText('已有的分享');

    fireEvent.click(screen.getByLabelText('让客户看到彼此的选片标记'));
    fireEvent.click(screen.getByRole('button', { name: '新建分享' }));

    await vi.waitFor(() => expect(apiMock.postJSON).toHaveBeenCalled());
    expect(apiMock.postJSON.mock.calls[0][1]).toMatchObject({ showPeerMarks: false });
  });

  it('切换"公开客户标记"走 PATCH，且只改这一个字段', async () => {
    wireGetJSON([makeShare({ label: '客户 E', showPeerMarks: true })], mockNetaddr());
    render(<SharePanel open onClose={() => {}} />);
    await screen.findByText('客户 E');

    fireEvent.click(screen.getByRole('button', { name: '隐藏客户标记' }));

    await vi.waitFor(() => expect(apiMock.patchJSON).toHaveBeenCalledWith(
      '/api/admin/shares/sh_1', { showPeerMarks: false }));
  });

  it('已经隐藏的那条，按钮文案是「公开客户标记」', async () => {
    // 按钮文案是这个开关在界面上唯一的状态显示。写死成一个文案的实现
    // 能让上面那条通过，但摄影师永远看不出这条分享此刻是哪一边。
    wireGetJSON([makeShare({ label: '客户 F', showPeerMarks: false })], mockNetaddr());
    render(<SharePanel open onClose={() => {}} />);
    await screen.findByText('客户 F');

    expect(screen.getByRole('button', { name: '公开客户标记' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '隐藏客户标记' })).toBeNull();
  });
});
