import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportPanel } from './ExportPanel';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { useView } from '../store/view';
import { setSession } from '../store/session';
import type { Asset } from '../types';

// ExportPanel 内嵌了 DirBrowser（挂载时会请求 /api/fs/list、/api/fs/roots），
// 也会在真正点「导出」之后调用 postJSON/openStream。这些请求在 jsdom + Node
// 环境下会打到真实网络/相对 URL 解析失败，所以整个 api 模块在这份测试里替身化，
// 行为由各用例按需覆盖。
type StreamHandler = (event: any) => void;

const apiMock = vi.hoisted(() => ({
  getJSON: vi.fn(),
  postJSON: vi.fn(),
  putJSON: vi.fn(),
  openStream: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  getJSON: apiMock.getJSON,
  postJSON: apiMock.postJSON,
  putJSON: apiMock.putJSON,
  openStream: apiMock.openStream,
  withSid: (u: string) => u,
  setSessionId: vi.fn(),
  getSessionId: vi.fn(() => null),
  setSessionGoneHandler: vi.fn(),
}));

function seedPicked(count: number, idPrefix = 'a') {
  const assets: Asset[] = Array.from({ length: count }, (_, i) => ({
    id: `${idPrefix}${i}`, dir: '', stem: `IMG_${i}`,
    raws: [`IMG_${i}.CR3`], jpg: null, jpgSize: 0, jpgMtimeMs: 0,
  }));
  useLibrary.setState({ assets });
  const marks: Record<string, 'pick' | 'reject'> = {};
  for (const a of assets) marks[a.id] = 'pick';
  useMarks.getState().load(marks);
}

function makeSummary(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    exported: 1, skipped: 0, renamed: 0, skippedAssets: [], renamedAssets: [],
    missingRaw: [], errors: [], canceled: false, destRoot: '/tmp/dest',
    ...overrides,
  };
}

async function setDest(value: string) {
  const dest = await screen.findByLabelText(/导出到/);
  fireEvent.change(dest, { target: { value } });
}

function switchToMove() {
  fireEvent.click(screen.getByLabelText(/移动（会从源文件夹删除原文件）/));
}

beforeEach(() => {
  apiMock.getJSON.mockImplementation((path: string) => (
    path.includes('/api/fs/roots')
      ? Promise.resolve({ roots: [], home: '/tmp' })
      : Promise.resolve({ path: '/tmp', parent: '/tmp', dirs: [] })
  ));
  apiMock.postJSON.mockReset();
  apiMock.openStream.mockReset().mockImplementation(() => () => {});
  useLibrary.setState({ assets: [] });
  useMarks.getState().load({});
  useView.getState().reset();
  setSession({ kind: 'admin', user: null, roster: [], online: [] });
});

afterEach(() => {
  // 配置里没有开 test.globals，@testing-library/react 探测不到全局 afterEach，
  // 不会自动注册卸载——不手动 cleanup() 的话，上一条用例渲染的 DOM 会一直挂在
  // jsdom 的 document 上，下一条用例的 findByLabelText 会在两份重叠的表单里
  // 卡住等不到目标元素（这正是这里第一次跑就踩到的坑）。
  cleanup();
  vi.clearAllMocks();
});

// 规格 §8.3：move 确认是删除不可再生 RAW 之前唯一的人工闸门。
// 如果把要求输入的数字直接印在确认框旁边，它就退化成一次抄写练习。
//
// 计划里给的示例测试假设 ExportPanel 直接接受 `mode`/`fileCount` 这两个 props，
// 但真实组件的签名只有 { open, onClose }——mode/fileCount 都是内部 state，
// 只能通过用户交互（勾选“移动”、以及在 store 里塞入被 pick 的 asset）驱动。
// 这里按真实签名重写，而不是伪造组件不支持的 props。
describe('move 确认闸门（I16）', () => {
  it('确认对话框里不得出现待输入的那个数字', async () => {
    seedPicked(30);
    render(<ExportPanel open onClose={() => {}} />);
    await setDest('/tmp/dest');
    switchToMove();

    fireEvent.click(screen.getByRole('button', { name: /移动 30 个文件/ }));

    const dialog = await screen.findByRole('dialog', { name: /确认移动/ });
    expect(dialog.textContent).not.toMatch(/\b30\b/);
  });
});

describe('ExportPanel 重开复位（分诊 k）', () => {
  it('换过文件夹之后重开面板，不得闪现上一次的导出结果', async () => {
    seedPicked(5);
    apiMock.postJSON.mockResolvedValueOnce({ jobId: 'job-1', total: 5 });
    let handler: StreamHandler | null = null;
    apiMock.openStream.mockImplementation((_path: string, cb: StreamHandler) => {
      handler = cb;
      return () => {};
    });

    const { rerender } = render(<ExportPanel open onClose={() => {}} />);
    await setDest('/tmp/dest');
    fireEvent.click(screen.getByRole('button', { name: /复制 5 个文件/ }));

    await vi.waitFor(() => expect(handler).not.toBeNull());
    act(() => { handler!({ type: 'done', summary: makeSummary({ exported: 5 }) }); });
    await screen.findByText(/导出完成/);

    // 关闭面板、换文件夹（重新 seed 一批新数据）、重开。
    rerender(<ExportPanel open={false} onClose={() => {}} />);
    seedPicked(3, 'b');
    rerender(<ExportPanel open onClose={() => {}} />);

    expect(screen.queryByText(/导出完成/)).toBeNull();
  });
});

describe('move 进行中拦截 beforeunload（分诊 b 前端半边）', () => {
  it('move 任务跑着的时候刷新/关标签页会被拦截，任务结束后放行', async () => {
    // 这条用例改用 @testing-library/user-event 驱动交互（其余用例用 fireEvent）——
    // 顺带验证计划要求安装的四个开发依赖里，user-event 在这套 jsdom 环境下也是
    // 真的能跑的，不是装了但从没验证过。
    const user = userEvent.setup();
    seedPicked(2);
    apiMock.postJSON.mockResolvedValueOnce({ jobId: 'job-2', total: 2 });
    let handler: StreamHandler | null = null;
    apiMock.openStream.mockImplementation((_path: string, cb: StreamHandler) => {
      handler = cb;
      return () => {};
    });

    render(<ExportPanel open onClose={() => {}} />);
    await setDest('/tmp/dest');
    await user.click(screen.getByLabelText(/移动（会从源文件夹删除原文件）/));
    await user.click(screen.getByRole('button', { name: /移动 2 个文件/ }));

    const dialog = await screen.findByRole('dialog', { name: /确认移动/ });
    const input = within(dialog).getByRole('textbox');
    await user.type(input, '2');
    await user.click(within(dialog).getByRole('button', { name: /确认移动/ }));

    await vi.waitFor(() => expect(handler).not.toBeNull());

    const before = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);

    act(() => { handler!({ type: 'done', summary: makeSummary({ exported: 2 }) }); });
    await screen.findByText(/导出完成/);

    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});

describe('导出范围预览', () => {
  it('参数和文件名筛选默认导出可见结果中的收藏，不导出隐藏在筛选外的收藏', async () => {
    seedPicked(3);
    useView.getState().setPhotoFilters({ query: 'a1', iso: '800' });
    apiMock.postJSON.mockResolvedValue({ jobId: 'filtered', total: 1 });
    render(<ExportPanel open onClose={() => {}} visibleIds={['a1']} />);
    await setDest('/tmp/dest');
    expect(screen.getByText('本次范围：当前筛选中的收藏')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '复制 1 个文件' }));
    expect(apiMock.postJSON).toHaveBeenCalledWith('/api/export', expect.objectContaining({
      scope: { kind: 'filtered', dir: null, tab: 'all', clientId: null, assetIds: ['a1'] },
    }));
  });
  it('按客户筛选时默认显示客户自己的收藏，并把范围交给服务端复核', async () => {
    seedPicked(2);
    useMarks.getState().load({ a0: 'reject', a1: 'pick' }, {}, [], {
      a0: { bride: { mark: 'pick', at: 1 }, admin: { mark: 'reject', at: 2 } },
    });
    setSession({ roster: [{ id: 'bride', nickname: '新娘' }] });
    useView.getState().setClientFilter('bride');
    apiMock.postJSON.mockResolvedValue({ jobId: 'client', total: 1 });
    render(<ExportPanel open onClose={() => {}} />);
    expect(screen.getByText('本次范围：新娘的收藏')).toBeTruthy();
    await setDest('/tmp/dest');
    fireEvent.click(screen.getByRole('button', { name: '复制 1 个文件' }));
    expect(apiMock.postJSON).toHaveBeenCalledWith('/api/export', expect.objectContaining({
      scope: { kind: 'client', clientId: 'bride' },
    }));
  });
  it('手动选区不要求收藏，改变范围后数量和请求同步变化', async () => {
    seedPicked(3);
    useMarks.getState().load({ a0: 'pick' });
    useView.getState().setSelection(['a1', 'a2']);
    apiMock.postJSON.mockResolvedValue({ jobId: 'selected', total: 2 });
    render(<ExportPanel open onClose={() => {}} />);
    await setDest('/tmp/dest');
    expect(screen.getByRole('button', { name: '复制 2 个文件' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('导出范围'), { target: { value: 'all' } });
    expect(screen.getByRole('button', { name: '复制 1 个文件' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('导出范围'), { target: { value: 'selection' } });
    fireEvent.click(screen.getByRole('button', { name: '复制 2 个文件' }));
    expect(apiMock.postJSON).toHaveBeenCalledWith('/api/export', expect.objectContaining({
      scope: { kind: 'selection', assetIds: ['a1', 'a2'] },
    }));
  });
});
