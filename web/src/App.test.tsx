import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { useLibrary } from './store/library';
import { useMarks } from './store/marks';
import { setSession, useSession } from './store/session';
import { useView } from './store/view';

// App 是这一整套 jsdom 组件测试基础设施（Task 1）真正要支撑的东西——
// ExportPanel 的用例只证明"渲染一个孤立组件是可行的"，但 App 会拉出整棵树：
// FolderPicker/DirBrowser/TopBar/Sidebar/Grid（含 @tanstack/react-virtual）等等。
// 这里不断言某个具体修复，只钉一条基线：真正的应用入口在 jsdom 下能挂载、
// 不抛错——如果哪次改动（比如引入了某个只在浏览器里才存在的 API）让它连
// 挂载都做不到，这个用例应该是第一个红的。
vi.mock('./lib/api', () => ({
  getJSON: vi.fn((path: string) => (
    path.includes('/api/fs/roots')
      ? Promise.resolve({ roots: [], home: '/tmp' })
      : Promise.resolve({ path: '/tmp', parent: '/tmp', dirs: [] })
  )),
  postJSON: vi.fn(() => new Promise(() => {})),
  putJSON: vi.fn(),
  openStream: vi.fn(() => () => {}),
  withSid: (u: string) => u,
  setSessionId: vi.fn(),
  getSessionId: vi.fn(() => null),
  setSessionGoneHandler: vi.fn(),
}));

// @tanstack/react-virtual（Grid 用）要 ResizeObserver，jsdom 没有。
// 只有下面那条「打开文件夹之后」的用例会走到 Grid，但替身放在模块级最省事。
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

beforeEach(() => {
  localStorage.clear();
  useLibrary.setState({
    phase: 'idle', root: null, assets: [], metas: new Map(), error: null, errorDetail: null,
    scanFound: 0,
  });
  useMarks.getState().load({});
  setSession({ kind: 'none', user: null, share: null, online: [] });
});

afterEach(() => {
  cleanup();
});

describe('App smoke（jsdom 环境基线）', () => {
  it('未打开文件夹时渲染文件夹选择器，不抛错', async () => {
    render(<App />);
    const heading = await screen.findByRole('heading', { name: '选择照片文件夹' });
    expect(heading.textContent).toBe('选择照片文件夹');
  });

  // useKeyboard 的写门禁是**默认拒绝**的（session.canWrite() 对 kind:'none'
  // 返回 false）。`/` 这条入口在服务端是 requireAdmin 的，本地界面必须自己
  // 报到，否则单机流程连 P/X 都按不动——而那种坏法没有任何报错，只是按键
  // 静静地不起作用。
  it('渲染出来即把 session 声明成 admin，单机流程仍然可写', async () => {
    expect(useSession.getState().canWrite()).toBe(false);

    render(<App />);
    await screen.findByRole('heading', { name: '选择照片文件夹' });

    expect(useSession.getState().kind).toBe('admin');
    expect(useSession.getState().canWrite()).toBe(true);
  });

  // Task 17：摄影师这一侧也要看得见谁在线——分享出去之后，"现在有没有人在看"
  // 是他最想知道的一件事，而这条信息只能来自 SSE 的 presence 事件。
  it('打开文件夹之后渲染在线成员条', async () => {
    setSession({
      online: [
        { id: 'admin', nickname: '摄影师', role: 'admin' },
        { id: 'u_1', nickname: '新娘小林', role: 'editor' },
      ],
    });
    useLibrary.setState({ phase: 'ready', root: '/tmp/A' });

    render(<App />);

    expect(await screen.findByRole('list', { name: '成员' })).toBeTruthy();
    expect(screen.getByText('新娘小林')).toBeTruthy();
  });

  it('没人在线时不渲染成员条（单机流程界面不变）', async () => {
    useLibrary.setState({ phase: 'ready', root: '/tmp/A' });
    render(<App />);
    await screen.findByRole('button', { name: /选择文件夹/ });
    expect(screen.queryByRole('list', { name: '成员' })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 20：扫描进度。开库不再阻塞扫描（Task 12）之后，读卡器上那几十秒里
// 界面必须有东西在动——否则"正在扫描…"这句静止的话跟卡死无法区分。
// ─────────────────────────────────────────────────────────────────────────────

describe('扫描进度条', () => {
  it('扫描阶段显示累计数量', async () => {
    useLibrary.setState({ phase: 'scanning', scanFound: 1234 });
    const { container } = render(<App />);
    await screen.findByRole('heading', { name: '选择照片文件夹' });

    const bar = container.querySelector('.scan-progress') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.textContent).toContain('1234');
  });

  // scan.found 是**文件**数，不是资产数：一对 RAW+JPG 是两个文件、一个资产
  // （server/lib/scan.js 的 onBatch 契约）。文案说成"张"的话，一场 3000 张的
  // 婚礼会显示成"已扫描 6000 张"——数字看着很正常，只是不对。
  it('文案说的是文件数，不是照片张数', async () => {
    useLibrary.setState({ phase: 'scanning', scanFound: 6000 });
    const { container } = render(<App />);
    await screen.findByRole('heading', { name: '选择照片文件夹' });

    const bar = container.querySelector('.scan-progress') as HTMLElement;
    expect(bar.textContent).toContain('个文件');
    expect(bar.textContent).not.toContain('张');
  });

  it('扫描完成后进度条消失', async () => {
    useLibrary.setState({ phase: 'ready', root: '/tmp/A', scanFound: 1234 });
    const { container } = render(<App />);
    await screen.findByRole('button', { name: /选择文件夹/ });
    expect(container.querySelector('.scan-progress')).toBeNull();
  });

  it('还没开始打开时没有进度条', async () => {
    const { container } = render(<App />);
    await screen.findByRole('heading', { name: '选择照片文件夹' });
    expect(container.querySelector('.scan-progress')).toBeNull();
  });

  it('扫描失败时退回选择器并显示原因', async () => {
    useLibrary.setState({
      phase: 'idle', error: '扫描文件夹时出错（ENOSPC），请重试', errorDetail: null,
    });
    const { container } = render(<App />);
    await screen.findByRole('heading', { name: '选择照片文件夹' });

    expect(container.querySelector('.scan-progress')).toBeNull();
    expect(container.querySelector('.picker-error')?.textContent).toContain('ENOSPC');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 22：按人筛选真的接进了网格。
//
// derive 层那几个纯函数测得再全，也证明不了 App 调用了它们——把 App.tsx 里
// 那个三元换回无条件的 filterGroups，derive.test.ts 全绿。这一组钉的就是接线。
// ─────────────────────────────────────────────────────────────────────────────

describe('按人筛选接进网格', () => {
  const asset = (id: string) => ({
    id, dir: '', stem: id, raws: [`${id}.CR3`], jpg: `${id}.JPG`, jpgSize: 1, jpgMtimeMs: 1,
  });

  beforeEach(() => {
    useLibrary.setState({
      phase: 'ready', root: '/tmp/A',
      assets: [asset('IMG_1'), asset('IMG_2')], metas: new Map(),
    });
    // IMG_1 是新娘收藏的，IMG_2 只有摄影师碰过。
    useMarks.getState().load(
      { IMG_1: 'pick', IMG_2: 'reject' }, undefined, undefined,
      {
        IMG_1: { u_bride: { mark: 'pick', at: 2 } },
        IMG_2: { admin: { mark: 'reject', at: 1 } },
      },
    );
  });

  // 网格本身是虚拟化的，jsdom 里量不出高度、一个格子都渲染不出来。
  // 但「这个视图下没有照片」那句空状态渲染得出来，而它恰好是最强的判据：
  // 判据换没换，看的就是同一组数据下这句话在不在。
  const isEmpty = () => document.querySelector('.grid-empty') !== null;

  it('按新娘筛 +「排除」页签是空的——她只收藏过，没排除过', async () => {
    // 不接线的话走的是有效标记：IMG_2 的有效标记就是 reject，会显示出来。
    useView.getState().setClientFilter('u_bride');
    useView.getState().setTab('reject');
    render(<App />);
    await screen.findByRole('button', { name: /选择文件夹/ });
    expect(isEmpty()).toBe(true);
  });

  it('按新娘筛 +「收藏」页签不是空的', async () => {
    // 和上一条配对：只有上一条的话，一个「筛了人就什么都不显示」的错误实现
    // 也能全绿。
    useView.getState().setClientFilter('u_bride');
    useView.getState().setTab('pick');
    render(<App />);
    await screen.findByRole('button', { name: /选择文件夹/ });
    expect(isEmpty()).toBe(false);
  });

  it('筛一个谁都不是的人，网格是空的', async () => {
    useView.getState().setClientFilter('u_nobody');
    render(<App />);
    await screen.findByRole('button', { name: /选择文件夹/ });
    expect(isEmpty()).toBe(true);
  });

  it('「全部」那一格改叫「XX 碰过的」，计数也跟着换口径', async () => {
    // 筛了人之后「全部」不再等于整库。不改文案的话，那一格叫「全部」、
    // 数字却比库里少，没人解释得清。
    useSession.setState({ roster: [{ id: 'u_bride', nickname: '新娘' }] });
    useView.getState().setClientFilter('u_bride');
    render(<App />);

    const tab = await screen.findByRole('button', { name: /新娘碰过的/ });
    expect(tab.textContent).toContain('1');
    expect(screen.queryByRole('button', { name: /^全部/ })).toBeNull();
  });
});
