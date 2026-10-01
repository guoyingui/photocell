import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuestApp } from './GuestApp';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { useView } from '../store/view';
import { setSession } from '../store/session';
import { resetRealtime } from '../lib/realtime';
import type { Role } from '../store/session';
import type { Asset, Settings } from '../types';

// 四个替身都不带实现地声明（实现在 beforeEach 里给）：带了实现的 vi.fn()
// 会把参数类型推成空元组，后面读 mock.calls[0][1] 就过不了 tsc。
const apiMock = vi.hoisted(() => ({
  getJSON: vi.fn(),
  putJSON: vi.fn(),
  postJSON: vi.fn(),
  openStream: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  getJSON: apiMock.getJSON,
  putJSON: apiMock.putJSON,
  postJSON: apiMock.postJSON,
  openStream: apiMock.openStream,
  withSid: (u: string) => u,
  setSessionId: vi.fn(),
  getSessionId: vi.fn(() => null),
  setSessionGoneHandler: vi.fn(),
}));

// 缩略图整条链路（fetch → Blob → createObjectURL）在 jsdom 里既跑不通也不是
// 这里要验的东西。换成一个不出图的替身，网格照常渲染骨架格。
vi.mock('../lib/thumbSource', () => ({
  useThumb: () => ({ url: null, failed: false }),
  reprioritizeThumbs: vi.fn(),
  clearThumbCache: vi.fn(),
  thumbUrl: (id: string) => `/api/thumb?id=${id}`,
  originalUrl: (id: string) => `/api/original?id=${id}`,
}));

// @tanstack/react-virtual 要 ResizeObserver，jsdom 没有。
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const SETTINGS: Settings = { burstThresholdMs: 1000, cellWidth: 210, sort: 'time' };

// mtime 相隔几小时：groupBursts 对 timeSource === 'mtime' 的项本来就拒绝合组，
// 每张各自成组，flatOrder 的顺序就是这三个 id。
const ASSETS: Asset[] = [
  { id: 'IMG_0001', dir: '', stem: 'IMG_0001', raws: ['IMG_0001.CR2'], jpg: 'IMG_0001.JPG', jpgSize: 1, jpgMtimeMs: 1_000_000 },
  { id: 'IMG_0002', dir: '', stem: 'IMG_0002', raws: ['IMG_0002.CR2'], jpg: 'IMG_0002.JPG', jpgSize: 1, jpgMtimeMs: 2_000_000 },
  { id: 'IMG_0003', dir: '', stem: 'IMG_0003', raws: [], jpg: 'IMG_0003.JPG', jpgSize: 1, jpgMtimeMs: 3_000_000 },
];

function asGuest(role: Role) {
  setSession({
    kind: 'user',
    user: { id: 'u_1', nickname: '新娘小林', role },
    share: { label: '婚礼初选给新人' },
    online: [],
  });
}

/**
 * 挂载并等到照片就位（第一个筛选 tab 出现即说明 /assets 与 /marks 都回来了）。
 * 按 title 而不是按「全部」这个名字找：有扫描提示时 Sidebar 也会渲染一个
 * 叫「全部」的目录按钮，按名字找会撞上两个。
 */
async function mountReady(props: { marksRecovered?: boolean } = {}) {
  render(<GuestApp {...props} />);
  await screen.findByTitle('快捷键 1');
}

it('访客使用电脑端对比；只读访客没有标记历史操作', async () => {
  asGuest('editor');
  await mountReady();
  expect(screen.queryByRole('button', { name: '多选' })).toBeNull();
  expect(screen.getByRole('button', { name: '重做' })).toBeTruthy();
  act(() => { asGuest('viewer'); });
  expect(screen.queryByRole('button', { name: '重做' })).toBeNull();
  expect(screen.getByRole('button', { name: '对比' })).toBeTruthy();
});

/** openStream 返回的取消订阅函数。阻断之后必须真的被调用一次。 */
let stopStream: ReturnType<typeof vi.fn>;

beforeEach(() => {
  apiMock.getJSON.mockReset();
  apiMock.putJSON.mockReset().mockResolvedValue({});
  apiMock.postJSON.mockReset().mockResolvedValue({});
  stopStream = vi.fn();
  apiMock.openStream.mockReset().mockImplementation(() => stopStream);
  apiMock.getJSON.mockImplementation((path: string) => {
    if (path === '/api/library/assets') {
      return Promise.resolve({ assets: ASSETS, warnings: [], skippedFiles: 0 });
    }
    if (path === '/api/library/marks') {
      return Promise.resolve({ marks: {}, settings: SETTINGS, marksMeta: {} });
    }
    return Promise.reject(new Error('unexpected GET ' + path));
  });
  useLibrary.setState({
    root: null, assets: [], metas: new Map(), warnings: [], skippedFiles: 0,
    settings: SETTINGS, phase: 'idle', error: null, errorDetail: null, streamError: null,
  });
  useMarks.getState().load({});
  useView.getState().reset();
  setSession({ kind: 'none', user: null, share: null, online: [] });
  resetRealtime();
});

afterEach(() => {
  cleanup();
  resetRealtime();
  vi.clearAllMocks();
});

/** 取出 GuestApp 交给 openStream 的事件回调，并推一帧进去。 */
function emit(event: unknown) {
  const onEvent = apiMock.openStream.mock.calls[0][1] as (e: unknown) => void;
  act(() => { onEvent(event); });
}

/** 取出 openStream 的 onOpen 回调（第三个参数）。 */
function streamOpened() {
  const onOpen = apiMock.openStream.mock.calls[0][2] as (() => void) | undefined;
  act(() => { onOpen?.(); });
}

describe('只读门禁', () => {
  it.each(['p', 'x', 'u'])('viewer 按 %s 不产生任何标记写请求', async (key) => {
    asGuest('viewer');
    await mountReady();
    act(() => { useView.getState().setCursor('IMG_0002'); });

    fireEvent.keyDown(document.body, { key });

    // 「没有按钮可以按」不算门禁 —— P/X/U 本来就没有按钮。断言的是没有请求。
    expect(apiMock.putJSON).not.toHaveBeenCalled();
    expect(useMarks.getState().marks).toEqual({});
  });

  // 对照组：证明上面那条不是因为整个键盘（或整个界面）坏掉了。
  it('editor 按 P 会发出写请求（对照组）', async () => {
    asGuest('editor');
    await mountReady();
    act(() => { useView.getState().setCursor('IMG_0002'); });

    fireEvent.keyDown(document.body, { key: 'p' });

    expect(apiMock.putJSON).toHaveBeenCalledWith(
      '/api/library/marks', { marks: { IMG_0002: 'pick' } });
    expect(useMarks.getState().marks.IMG_0002).toBe('pick');
  });

  it('只读身份会在界面上明说，而不是让按键静静地没反应', async () => {
    asGuest('viewer');
    await mountReady();

    expect(screen.getByText(/只读/).textContent).toContain('不能修改');
  });

  it('可写身份不显示只读提示（对照组）', async () => {
    asGuest('editor');
    await mountReady();

    expect(screen.queryByText(/只读/)).toBeNull();
  });
});

describe('访客界面 = 本地界面减去三块', () => {
  // 这三条都用 editor 身份：如果用 viewer，"某某入口不存在" 可能只是因为
  // 只读把界面整个削掉了，证明不了「访客界面本来就没有这一块」。
  it('不渲染导出入口', async () => {
    asGuest('editor');
    await mountReady();

    expect(screen.queryByRole('button', { name: /导出/ })).toBeNull();
  });

  it('不渲染文件夹选择器与换文件夹入口', async () => {
    asGuest('editor');
    await mountReady();

    expect(screen.queryByRole('heading', { name: '选择照片文件夹' })).toBeNull();
    expect(screen.queryByRole('button', { name: /换文件夹/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /选择文件夹/ })).toBeNull();
    // 摄影师磁盘上的绝对路径一个字都不该出现（join 响应刻意不返回 root）。
    expect(useLibrary.getState().root).toBeNull();
  });

  it('不渲染连拍阈值滑杆（库级设置仅管理员）', async () => {
    asGuest('editor');
    await mountReady();

    // 阈值滑杆是 <input type="range">，无障碍角色是 slider。
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByTitle('相邻两张间隔小于此值即归为一组连拍')).toBeNull();
    // 它改变的是所有人看到的分组，所以连那条写设置的请求都不该存在。
    expect(apiMock.putJSON).not.toHaveBeenCalled();
  });

  // 名字写得比"不发任何管理员请求"更窄，因为后者不是真的：Grid 按规格要求
  // 原封不动复用，而它会防抖上报烘焙优先级（POST /api/library/prioritize，
  // 服务端 requireAdmin）。那条请求会被 403 掉，Grid 自己 .catch(() => {})
  // 吞掉；它不写任何东西也不泄露任何东西，为它去改 Grid 反而违规格。
  it('不碰文件系统、导出、管理接口，也不碰开关库与库级设置', async () => {
    asGuest('editor');
    await mountReady();

    const paths = [
      ...apiMock.getJSON.mock.calls.map((c) => String(c[0])),
      ...apiMock.postJSON.mock.calls.map((c) => String(c[0])),
      ...apiMock.putJSON.mock.calls.map((c) => String(c[0])),
    ];
    for (const p of paths) {
      expect(p).not.toMatch(/\/api\/(fs|export|admin)/);
      expect(p).not.toMatch(/\/api\/library\/(open|close|settings)/);
    }
  });
});

describe('照片就位', () => {
  it('从 /assets 拿 warnings 与 skippedFiles，并把标记先于网格灌进 store', async () => {
    apiMock.getJSON.mockImplementation((path: string) => {
      if (path === '/api/library/assets') {
        return Promise.resolve({ assets: ASSETS, warnings: ['a.txt 读不出来'], skippedFiles: 4 });
      }
      if (path === '/api/library/marks') {
        return Promise.resolve({ marks: { IMG_0001: 'pick' }, settings: SETTINGS, marksMeta: {} });
      }
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    asGuest('viewer');
    await mountReady();

    expect(useLibrary.getState().warnings).toEqual(['a.txt 读不出来']);
    expect(useLibrary.getState().skippedFiles).toBe(4);
    expect(useMarks.getState().marks.IMG_0001).toBe('pick');
    // 别人已经收藏过的那张，进来就该看得见 —— tab 计数是最直接的证据。
    expect(screen.getByRole('button', { name: /收藏 1/ })).toBeTruthy();
  });

  // Task 20：访客也要看得见角标——"这张是谁选的"在多人一起看的时候
  // 恰恰是访客最需要的一条信息。数据只有 /marks 这一个来源。
  it('/marks 里的归属表进 marks store（访客侧的角标数据）', async () => {
    apiMock.getJSON.mockImplementation((path: string) => {
      if (path === '/api/library/assets') {
        return Promise.resolve({ assets: ASSETS, warnings: [], skippedFiles: 0 });
      }
      if (path === '/api/library/marks') {
        return Promise.resolve({
          marks: { IMG_0001: 'pick' }, settings: SETTINGS,
          marksMeta: { IMG_0001: { by: 'u_9', at: 1700 } },
        });
      }
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    asGuest('viewer');
    await mountReady();

    expect(useMarks.getState().marksMeta).toEqual({ IMG_0001: { by: 'u_9', at: 1700 } });
  });

  it('老文件夹没有归属表时访客界面照常载入', async () => {
    apiMock.getJSON.mockImplementation((path: string) => {
      if (path === '/api/library/assets') {
        return Promise.resolve({ assets: ASSETS, warnings: [], skippedFiles: 0 });
      }
      if (path === '/api/library/marks') {
        return Promise.resolve({ marks: { IMG_0001: 'pick' }, settings: SETTINGS });
      }
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    asGuest('viewer');
    await mountReady();

    expect(useMarks.getState().marksMeta).toEqual({});
    expect(useMarks.getState().marks.IMG_0001).toBe('pick');
  });

  it('订阅实时流，元数据批次到达后合进 store', async () => {
    asGuest('viewer');
    await mountReady();

    // 第三个参数是 Task 17 补的 onOpen（重连后全量补拉的挂点）。
    expect(apiMock.openStream).toHaveBeenCalledWith(
      '/api/library/stream', expect.any(Function), expect.any(Function));
    emit({ type: 'meta', metas: [{ id: 'IMG_0001', time: 1, timeSource: 'exif', body: 'x' }] });
    expect(useLibrary.getState().metas.get('IMG_0001')?.timeSource).toBe('exif');
  });

  it('拉不到照片时整页阻断，而不是一张空网格', async () => {
    apiMock.getJSON.mockRejectedValue(
      Object.assign(new Error('会话已失效或已被替换，请重新打开文件夹'), { status: 409 }));
    asGuest('viewer');
    render(<GuestApp />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('会话已失效');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 17：实时合并与阻断层
// ─────────────────────────────────────────────────────────────────────────────

describe('实时合并', () => {
  it('别人的标记广播实时反映到界面上', async () => {
    asGuest('editor');
    await mountReady();
    expect(screen.getByRole('button', { name: /收藏 0/ })).toBeTruthy();

    emit({
      type: 'marks', origin: 'u_other', seq: 1,
      changes: { IMG_0001: { mark: 'pick', by: 'u_other', at: 1 } },
    });

    expect(useMarks.getState().marks.IMG_0001).toBe('pick');
    expect(screen.getByRole('button', { name: /收藏 1/ })).toBeTruthy();
  });

  it('自己按下的 P 不会被自己那条广播回声刷掉', async () => {
    asGuest('editor');
    await mountReady();
    act(() => { useView.getState().setCursor('IMG_0002'); });
    fireEvent.keyDown(document.body, { key: 'p' });
    expect(useMarks.getState().marks.IMG_0002).toBe('pick');

    // 服务端把这次写广播回来，origin 就是我自己（asGuest 用的 id 是 u_1）。
    emit({
      type: 'marks', origin: 'u_1', seq: 2,
      changes: { IMG_0002: { mark: 'pick', by: 'u_1', at: 1 } },
    });

    expect(useMarks.getState().marks.IMG_0002).toBe('pick');
  });

  it('SSE 重连后全量补拉 marks，断开期间别人的改动补齐', async () => {
    asGuest('editor');
    await mountReady();

    apiMock.getJSON.mockClear();
    apiMock.getJSON.mockResolvedValue({
      marks: { IMG_0003: 'reject' }, settings: SETTINGS, marksMeta: {},
    });

    streamOpened();            // 首次连上：不补拉
    expect(apiMock.getJSON).not.toHaveBeenCalled();
    streamOpened();            // 重连成功：必须补拉
    await act(async () => { await Promise.resolve(); });

    expect(apiMock.getJSON).toHaveBeenCalledWith('/api/library/marks');
    expect(useMarks.getState().marks.IMG_0003).toBe('reject');
  });

  it('presence 事件把在线成员显示出来', async () => {
    asGuest('editor');
    await mountReady();

    emit({
      type: 'presence',
      users: [
        { id: 'admin', nickname: '摄影师', role: 'admin' },
        { id: 'u_1', nickname: '新娘小林', role: 'editor' },
      ],
    });

    expect(screen.getByRole('list', { name: '成员' })).toBeTruthy();
    expect(screen.getByText('摄影师')).toBeTruthy();
  });

  it('role 事件把自己降成只读，界面当场变成只读', async () => {
    asGuest('editor');
    await mountReady();
    expect(screen.queryByText(/只读/)).toBeNull();

    emit({ type: 'role', userId: 'u_1', role: 'viewer' });

    expect(screen.getByText(/只读/).textContent).toContain('不能修改');
    act(() => { useView.getState().setCursor('IMG_0002'); });
    fireEvent.keyDown(document.body, { key: 'p' });
    expect(apiMock.putJSON).not.toHaveBeenCalled();
  });
});

describe('阻断层', () => {
  it('收到 kicked 后显示阻断层，且不再发出任何请求', async () => {
    asGuest('editor');
    await mountReady();
    apiMock.getJSON.mockClear();
    apiMock.putJSON.mockClear();
    apiMock.postJSON.mockClear();

    emit({ type: 'kicked', reason: 'disabled' });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('移出');
    // 网格没了，也就没有 useKeyboard、没有 Grid 的优先级上报。
    expect(screen.queryByTitle('快捷键 1')).toBeNull();

    // 服务端确实会断开这条连接，但 EventSource 会自己不停重连，每次重连
    // 都再撞一次 401、还会再触发一次补拉。主动关掉才是真的「不再发请求」。
    expect(stopStream).toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: 'p' });
    streamOpened();
    streamOpened();
    await act(async () => { await Promise.resolve(); });

    expect(apiMock.getJSON).not.toHaveBeenCalled();
    expect(apiMock.putJSON).not.toHaveBeenCalled();
    expect(apiMock.postJSON).not.toHaveBeenCalled();
  });

  it('收到 share-ended 后显示的文案与 kicked 不同', async () => {
    asGuest('editor');
    await mountReady();
    emit({ type: 'kicked', reason: 'disabled' });
    const kickedTitle = screen.getByRole('heading').textContent ?? '';
    const kickedText = screen.getByRole('alert').textContent ?? '';

    cleanup();
    resetRealtime();
    apiMock.openStream.mockClear();
    asGuest('editor');
    await mountReady();
    emit({ type: 'share-ended', reason: 'revoked' });
    const endedTitle = screen.getByRole('heading').textContent ?? '';
    const endedText = screen.getByRole('alert').textContent ?? '';

    expect(endedText).not.toBe(kickedText);
    // 「你被单独请出去了」和「这场选片对所有人都结束了」是两件事，用同一句话
    // 打发人，被踢的人会以为是链接过期而反复刷新，链接过期的人会以为自己
    // 做错了什么去追问摄影师。标题就得先把这一点分开。
    expect(endedTitle).not.toBe(kickedTitle);
    expect(kickedTitle).toContain('移出');
    expect(endedTitle).not.toContain('移出');
    expect(endedTitle).toContain('结束');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 8：网格缩放的 ⌘/Ctrl 滚轮
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `Grid` 按规格要求原封不动复用给访客，Task 8 的 brief 因此把滚轮缩放的
 * `setCellWidth` 调用也原样带了进来——但没考虑到 `persist: true` 会打
 * `PUT /api/library/settings`，而那条路由是 requireAdmin。访客的浏览器上
 * 从来不会有 admin 会话，字面照抄 brief 的话，访客一滚轮就会发一条注定
 * 403 的写请求。
 *
 * 这不是"403 掉就算了"：本文件上面「访客界面 = 本地界面减去三块」那组用例
 * 已经把 `/api/library/settings` 写进了访客一律不该碰的路径黑名单（见该
 * describe 块最后一条用例），连拍阈值滑块那条更是明说"它改变的是所有人
 * 看到的分组，所以连那条写设置的请求都不该存在"。Grid.tsx 因此按
 * `useSession.getState().kind === 'admin'` 决定 persist：管理员滚轮落盘、
 * 对所有人生效；访客滚轮只改自己这一屏的本地状态，不发任何请求。
 *
 * 只断言「没有 PUT」抓不住"滚轮处理器根本没挂上"这种恒真的空用例，所以第一步
 * 必须先证明本地状态真的变了。
 */
describe('访客网格缩放：Ctrl+滚轮本地生效，不发写请求', () => {
  it('Ctrl+滚轮改本地 cellWidth，防抖过后也不打 PUT /api/library/settings', async () => {
    asGuest('editor');
    await mountReady();

    const before = useLibrary.getState().settings.cellWidth;
    const scrollEl = document.querySelector('.grid-scroll');
    expect(scrollEl).toBeTruthy();

    vi.useFakeTimers();
    try {
      // 原生 dispatchEvent：处理器是 Grid.tsx 用 addEventListener +
      // passive: false 挂的，React 的合成事件（fireEvent.wheel）走不到它。
      act(() => {
        scrollEl!.dispatchEvent(new WheelEvent('wheel', {
          ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true,
        }));
      });

      // 本地状态确实变了——这一半不能省，少了它，万一滚轮处理器根本没挂上，
      // 下面「没有 PUT」的断言会对着一个什么都没发生的场景恒为真。
      expect(useLibrary.getState().settings.cellWidth).not.toBe(before);

      await act(async () => { await vi.advanceTimersByTimeAsync(500); }); // 越过 400ms 防抖
    } finally {
      vi.useRealTimers();
    }

    const settingsCalls = apiMock.putJSON.mock.calls.filter(
      ([url]) => String(url).includes('/api/library/settings'));
    expect(settingsCalls).toHaveLength(0);
  });
});

/**
 * 摄影师点「刷新」之后，访客手里那份照片列表也要跟着换。
 *
 * 这一段以前是缺的：服务端确实向该库每一条连接广播了 `rescan`，但访客界面
 * 完全不处理它，于是客户一直看着刷新前那份列表——点开一张已经从磁盘上消失的
 * 照片只会得到「无法预览」，而他不知道为什么。
 */
describe('GuestApp：摄影师刷新之后', () => {
  /** 让下一次 /assets 返回一份不同的资产表，模拟磁盘上少了 / 多了照片。 */
  function nextAssets(assets: Asset[]) {
    apiMock.getJSON.mockImplementation((path: string) => {
      if (path === '/api/library/assets') {
        return Promise.resolve({ assets, warnings: [], skippedFiles: 0 });
      }
      if (path === '/api/library/marks') {
        return Promise.resolve({ marks: {}, settings: SETTINGS, marksMeta: {} });
      }
      return Promise.reject(new Error('unexpected GET ' + path));
    });
  }

  it('收到 rescan 后重拉资产表', async () => {
    asGuest('editor');
    await mountReady();
    expect(useLibrary.getState().assets).toHaveLength(3);

    nextAssets([ASSETS[0]]);
    emit({ type: 'rescan', removed: 2, added: 0 });

    await vi.waitFor(() =>
      expect(useLibrary.getState().assets.map((a) => a.id)).toEqual(['IMG_0001']));
  });

  it('指向已消失照片的光标和大图一并清掉', async () => {
    // 不清的话 order.indexOf(cursor) === -1，方向键跳回列表开头；
    // 大图更糟——它会停在一张磁盘上已经不存在的照片上，一直显示不出来。
    asGuest('editor');
    await mountReady();
    act(() => {
      useView.getState().setCursor('IMG_0003');
      useView.getState().openLightbox('IMG_0003');
    });
    expect(useView.getState().lightbox).toBe('IMG_0003');

    nextAssets([ASSETS[0]]);
    emit({ type: 'rescan', removed: 2, added: 0 });

    await vi.waitFor(() => expect(useView.getState().lightbox).toBeNull());
    expect(useView.getState().cursor).toBeNull();
  });

  it('还在的那张，光标不动', async () => {
    // 配对用例：只有上一条的话，一个「收到 rescan 就把 cursor 清空」的实现
    // 也全绿，而那会让客户每次摄影师刷新都丢失自己看到哪儿了。
    asGuest('editor');
    await mountReady();
    act(() => { useView.getState().setCursor('IMG_0001'); });

    nextAssets([ASSETS[0]]);
    emit({ type: 'rescan', removed: 2, added: 0 });

    await vi.waitFor(() => expect(useLibrary.getState().assets).toHaveLength(1));
    expect(useView.getState().cursor).toBe('IMG_0001');
  });

  it('扫描失败的那一帧不重拉——服务端保留的还是同一份表', async () => {
    asGuest('editor');
    await mountReady();
    const before = apiMock.getJSON.mock.calls.length;

    emit({ type: 'rescan', error: '扫描文件夹时出错（ENOENT），请重试' });

    await new Promise((r) => setTimeout(r, 20));
    expect(apiMock.getJSON.mock.calls.length).toBe(before);
    expect(useLibrary.getState().assets).toHaveLength(3);
  });
});
