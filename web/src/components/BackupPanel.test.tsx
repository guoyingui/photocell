import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupPanel } from './BackupPanel';
import { getJSON, postJSON } from '../lib/api';
vi.mock('../lib/api', () => ({ getSessionId: () => 'sid', getJSON: vi.fn(), postJSON: vi.fn() }));
beforeEach(() => {
  vi.mocked(getJSON).mockImplementation((url) => Promise.resolve(url.endsWith('/backups')
    ? { backups: [{ id: 'id', createdAt: 1, reason: 'manual', count: 3 }] } : { format: 'test-bundle' }) as never);
  vi.mocked(postJSON).mockResolvedValue({ token: 'token', source: '原目录', target: '当前目录', createdAt: 1,
    matched: 2, missing: ['missing'], extra: 1, changes: ['标记与最终名单'] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('预览列出范围和覆盖行为，正确输入目标名之前不能恢复', async () => {
  render(<BackupPanel onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '预览恢复' }));
  await screen.findByText('将覆盖：标记与最终名单。');
  const restore = screen.getByRole('button', { name: '确认恢复选片数据' }) as HTMLButtonElement;
  expect(restore.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('输入当前目录名称「当前目录」确认覆盖'), { target: { value: '原目录' } });
  expect(restore.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('输入当前目录名称「当前目录」确认覆盖'), { target: { value: '当前目录' } });
  expect(restore.disabled).toBe(false);
  vi.mocked(postJSON).mockRejectedValueOnce(new Error('当前选片已变化，请重新预览'));
  fireEvent.click(restore);
  await screen.findByRole('alert');
  expect(postJSON).toHaveBeenLastCalledWith('/api/library/backups/restore', {
    bundle: { format: 'test-bundle' }, token: 'token', confirmName: '当前目录',
  });
});
it('无效文件不能沿用上一次可恢复的预览', async () => {
  render(<BackupPanel onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '预览恢复' }));
  await screen.findByRole('button', { name: '确认恢复选片数据' });
  const file = new File(['bad json'], 'bad.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve('bad json') });
  fireEvent.change(screen.getByLabelText('导入备份文件（JSON，最多 24 MB）'), { target: { files: [file] } });
  await waitFor(() => expect(screen.queryByRole('button', { name: '确认恢复选片数据' })).toBeNull());
  await screen.findByRole('alert');
});
