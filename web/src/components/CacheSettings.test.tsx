import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CacheSettings } from './CacheSettings';
const api = vi.hoisted(() => ({ getJSON: vi.fn(), deleteJSON: vi.fn(), invalidate: vi.fn(), sid: 'one' }));
vi.mock('../lib/api', () => ({ ...api, getSessionId: () => api.sid }));
vi.mock('../lib/thumbSource', () => ({ invalidateThumbCache: api.invalidate }));
beforeEach(() => { api.sid = 'one'; api.getJSON.mockResolvedValue({ files: 10, bytes: 1024 * 1024 }); api.deleteJSON.mockReset(); api.invalidate.mockReset(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('清理失败保留入口并可重试，成功后刷新照片缓存并显示实际删除数量', async () => {
  api.deleteJSON.mockRejectedValueOnce(new Error('缓存正在生成')); render(<CacheSettings />);
  await screen.findByText('10 个文件 · 1.0 MB');
  fireEvent.click(screen.getByRole('button', { name: '清理当前目录的预览缓存' }));
  await screen.findByText('缓存正在生成'); expect(api.invalidate).not.toHaveBeenCalled();
  api.deleteJSON.mockResolvedValueOnce({ files: 0, bytes: 0, removed: { files: 10, bytes: 1024 * 1024 } });
  fireEvent.click(screen.getByRole('button', { name: '清理当前目录的预览缓存' }));
  await screen.findByText('已清理 10 个缓存文件，释放 1.0 MB'); expect(api.invalidate).toHaveBeenCalledOnce();
});
it('晚到的旧库清理响应不刷新新库的照片', async () => {
  let finish!: (data: unknown) => void;
  api.deleteJSON.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })); render(<CacheSettings />);
  await screen.findByText('10 个文件 · 1.0 MB'); fireEvent.click(screen.getByRole('button', { name: '清理当前目录的预览缓存' }));
  api.sid = 'two'; finish({ files: 0, bytes: 0, removed: { files: 10, bytes: 100 } });
  await vi.waitFor(() => expect((screen.getByRole('button', { name: '清理当前目录的预览缓存' }) as HTMLButtonElement).disabled).toBe(false));
  expect(api.invalidate).not.toHaveBeenCalled();
});
