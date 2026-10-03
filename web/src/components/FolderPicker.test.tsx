import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FolderPicker } from './FolderPicker';

const api = vi.hoisted(() => ({ fail: '', delay: null as Promise<unknown> | null }));
vi.mock('../lib/api', () => ({
  getJSON: vi.fn(async (url: string) => {
    if (url.includes('/roots')) return { roots: [{ path: '/photos', label: '照片' }] };
    if (url.includes('native-folder')) return { available: false };
    const path = new URL(url, 'http://test').searchParams.get('path') ?? '/photos';
    if (path === api.fail) throw new Error('路径不存在');
    if (api.delay && path === '/slow') return api.delay;
    return { path: path === '/alias' ? '/photos/a' : path, parent: '/photos', dirs: path === '/photos'
      ? [{ path: '/photos/a', name: '相机 A' }, { path: '/photos/b', name: '相机 B' }]
      : [{ path: path + '/day1', name: '第一天' }] };
  }),
  postJSON: vi.fn(),
}));
const added = vi.fn(), close = vi.fn();
beforeEach(() => { api.fail = ''; api.delay = null; vi.clearAllMocks(); });
afterEach(() => { cleanup(); });
const show = (existing: string[] = []) => render(<FolderPicker existing={existing} onAdd={added} onClose={close} />);
const paste = (value: string) => {
  fireEvent.change(screen.getByLabelText('目录完整路径'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: '加入待添加' }));
};

it('可以勾选多个目录，浏览到下一层时保留待添加列表', async () => {
  show();
  fireEvent.click(await screen.findByLabelText('选择目录 /photos/a'));
  fireEvent.click(screen.getByLabelText('选择目录 /photos/b'));
  fireEvent.click(screen.getByRole('button', { name: '相机 A' }));
  fireEvent.click(await screen.findByLabelText('选择目录 /photos/a/day1'));
  fireEvent.click(screen.getByRole('button', { name: '添加 3 个目录' }));
  await waitFor(() => expect(added).toHaveBeenCalledWith(['/photos/a', '/photos/b', '/photos/a/day1']));
  expect(close).toHaveBeenCalledOnce();
});
it('已添加目录不重复加入，多行路径及服务端返回的真实路径均去重', async () => {
  show(['/photos/b']);
  expect(await screen.findByLabelText('选择目录 /photos/b')).toHaveProperty('disabled', true);
  paste('/photos/a\n/alias\n/photos/a\n/photos/b');
  fireEvent.click(screen.getByRole('button', { name: '添加 2 个目录' }));
  await waitFor(() => expect(added).toHaveBeenCalledWith(['/photos/a']));
});
it('路径失效时显示具体失败项，保留清单，不提交部分目录', async () => {
  api.fail = '/bad'; show(); paste('/photos/a\n/bad');
  fireEvent.click(screen.getByRole('button', { name: '添加 2 个目录' }));
  expect((await screen.findByRole('alert')).textContent).toContain('/bad：路径不存在');
  expect(added).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '取消添加 /photos/a' })).toBeTruthy();
});
it('取消未提交的清单不添加；关闭后到达的校验结果也不能添加目录', async () => {
  let resolve!: (value: unknown) => void;
  api.delay = new Promise((done) => { resolve = done; });
  const mounted = show(); paste('/slow');
  fireEvent.click(screen.getByRole('button', { name: '添加 1 个目录' }));
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(close).toHaveBeenCalledOnce(); mounted.unmount();
  await act(async () => resolve({ path: '/slow' }));
  expect(added).not.toHaveBeenCalled();
});
it('拖入名称只提示候选，需要确认；拖入真实路径先加入待添加', async () => {
  show(); await screen.findByLabelText('选择目录 /photos/a');
  fireEvent.drop(screen.getByTestId('picker-dropzone'), { dataTransfer: { items: [{ webkitGetAsEntry: () => ({ name: '相机 A', isDirectory: true }) }], getData: () => '' } });
  expect(screen.getByText(/找到了「相机 A」/)).toBeTruthy();
  expect(added).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: '添加 0 个目录' })).toBeTruthy();
  fireEvent.drop(screen.getByTestId('picker-dropzone'), { dataTransfer: { items: [{ webkitGetAsEntry: () => ({ name: 'b', isDirectory: true }) }], getData: () => 'file:///photos/b' } });
  expect(screen.getByRole('button', { name: '取消添加 /photos/b' })).toBeTruthy();
  expect(added).not.toHaveBeenCalled();
});
it('未知的拖入名称不猜路径，仍可改用完整路径添加', async () => {
  show(); await screen.findByLabelText('选择目录 /photos/a');
  fireEvent.drop(screen.getByTestId('picker-dropzone'), { dataTransfer: { items: [{ webkitGetAsEntry: () => ({ name: '陌生目录', isDirectory: true }) }], getData: () => '' } });
  expect(screen.getByText(/浏览器只提供了「陌生目录」/)).toBeTruthy();
  expect(added).not.toHaveBeenCalled();
});
