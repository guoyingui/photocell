import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportHistory } from './ExportHistory';

const api = vi.hoisted(() => ({ getJSON: vi.fn(), postJSON: vi.fn(), openStream: vi.fn() }));
vi.mock('../lib/api', () => ({ ...api, withSid: (url: string) => `${url}?sid=test` }));
const record = { id: 'old-job', parentId: null, createdAt: 1, mode: 'move', status: 'partial',
  destRoot: '/delivery', total: 4, completed: 3, retryCount: 1, error: null };
let handler: ((event: any) => void) | null;
const stop = vi.fn();
beforeEach(() => {
  handler = null;
  api.getJSON.mockReset().mockImplementation((url: string) => Promise.resolve(url.includes('?offset=')
    ? { records: [record], total: 1 }
    : { ...record, files: [{ id: 'A', dir: 'day2', name: 'A.JPG', kind: 'jpg', status: 'failed', message: '磁盘已满' }] }));
  api.postJSON.mockReset().mockResolvedValue({ jobId: 'retry-job', total: 1 });
  api.openStream.mockReset().mockImplementation((_url: string, next: (event: any) => void) => { handler = next; return stop; });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('导出历史界面', () => {
  it('重新打开后从服务端读取历史，可查看逐文件失败原因和下载清单', async () => {
    const { unmount } = render(<ExportHistory onBusyChange={() => {}} />);
    await screen.findByText(/已完成 3 \/ 4/);
    fireEvent.click(screen.getByRole('button', { name: '查看清单' }));
    await screen.findByText('day2/A.JPG'); expect(screen.getByText('磁盘已满')).toBeTruthy();
    expect(screen.getByRole('link', { name: '下载 CSV 清单' }).getAttribute('href')).toBe('/api/export/history/old-job/csv?sid=test');
    unmount(); render(<ExportHistory onBusyChange={() => {}} />);
    await screen.findByText(/已完成 3 \/ 4/);
    expect(api.getJSON.mock.calls.filter(([url]) => url.includes('?offset='))).toHaveLength(2);
  });

  it('历史移动任务默认复制重试，断线时保留任务，完成后解除忙碌状态', async () => {
    const onBusy = vi.fn(); render(<ExportHistory onBusyChange={onBusy} />);
    fireEvent.click(await screen.findByRole('button', { name: '重试未完成文件' }));
    const dialog = screen.getByRole('dialog', { name: '重试未完成文件' });
    expect((within(dialog).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: '开始重试' }));
    await vi.waitFor(() => expect(handler).not.toBeNull());
    expect(api.postJSON).toHaveBeenCalledWith('/api/export/history/old-job/retry', { destRoot: '/delivery', mode: 'copy' });
    act(() => handler!({ type: 'error' }));
    expect(screen.getByText(/连接不稳定/)).toBeTruthy();
    expect(onBusy).toHaveBeenLastCalledWith(true);
    act(() => handler!({ type: 'done', summary: { canceled: false, exported: 1, skipped: 0, errors: [] } }));
    expect(await screen.findByText(/任务结束：成功 1/)).toBeTruthy();
    expect(onBusy).toHaveBeenLastCalledWith(false);
    expect(stop).toHaveBeenCalled();
  });

  it('移动重试需要重新输入文件数，并在执行时拦截刷新', async () => {
    render(<ExportHistory onBusyChange={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '重试未完成文件' }));
    const dialog = screen.getByRole('dialog', { name: '重试未完成文件' });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    const start = within(dialog).getByRole('button', { name: '开始重试' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('重试移动确认数量'), { target: { value: '4' } });
    expect(start.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('重试移动确认数量'), { target: { value: '1' } });
    fireEvent.click(start);
    await vi.waitFor(() => expect(handler).not.toBeNull());
    expect(api.postJSON).toHaveBeenCalledWith('/api/export/history/old-job/retry', { destRoot: '/delivery', mode: 'move', confirmCount: 1 });
    const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    act(() => handler!({ type: 'done', summary: { canceled: true, exported: 0, skipped: 0, errors: [] } }));
    const after = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});
