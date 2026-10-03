import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeFolderButton } from './NativeFolderButton';
const api = vi.hoisted(() => ({ getJSON: vi.fn(), postJSON: vi.fn() }));
vi.mock('../lib/api', () => api);
beforeEach(() => { api.getJSON.mockResolvedValue({ available: true }); api.postJSON.mockReset(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('系统选择成功打开返回的真实路径，取消后保持当前界面', async () => {
  const choose = vi.fn(); api.postJSON.mockResolvedValueOnce({ path: '/tmp/婚礼 照片' }).mockResolvedValueOnce({ path: null });
  render(<NativeFolderButton onChoose={choose} />); const button = await screen.findByRole('button', { name: '系统选择文件夹…' });
  fireEvent.click(button); await vi.waitFor(() => expect(choose).toHaveBeenCalledWith('/tmp/婚礼 照片'));
  fireEvent.click(screen.getByRole('button', { name: '系统选择文件夹…' }));
  await vi.waitFor(() => expect(api.postJSON).toHaveBeenCalledTimes(2)); expect(choose).toHaveBeenCalledOnce();
  expect(api.postJSON).toHaveBeenCalledWith('/api/fs/native-folder', { open: true });
});
it('系统窗口不可用时不显示入口，启动失败给出可操作提示', async () => {
  api.getJSON.mockResolvedValueOnce({ available: false });
  const { unmount } = render(<NativeFolderButton onChoose={vi.fn()} />);
  await vi.waitFor(() => expect(api.getJSON).toHaveBeenCalledOnce()); expect(screen.queryByRole('button')).toBeNull(); unmount();
  api.postJSON.mockRejectedValueOnce(new Error('请使用页面目录浏览器'));
  render(<NativeFolderButton onChoose={vi.fn()} />); fireEvent.click(await screen.findByRole('button', { name: '系统选择文件夹…' }));
  await screen.findByText('请使用页面目录浏览器');
});
