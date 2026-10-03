import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';
import { useLibrary } from '../store/library';
import { useView } from '../store/view';

const api = vi.hoisted(() => ({ putJSON: vi.fn(), sid: 'one' }));
vi.mock('../lib/api', () => ({ putJSON: api.putJSON, getJSON: vi.fn(async () => ({ files: 0, bytes: 0 })),
  deleteJSON: vi.fn(), getSessionId: () => api.sid, setSessionGoneHandler: vi.fn() }));
beforeEach(() => { useView.getState().reset(); useLibrary.setState({ assets: [], metas: new Map() }); api.putJSON.mockReset(); api.sid = 'one'; });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('连拍设置', () => {
  it('校验间隔，保存成功后才修改分组，失败时显示可重试提示', async () => {
    api.putJSON.mockRejectedValueOnce(new Error('只读磁盘'));
    const close = vi.fn(); render(<SettingsPanel onClose={close} />);
    fireEvent.change(screen.getByLabelText('连拍间隔（秒）'), { target: { value: '11' } });
    expect((screen.getByRole('button', { name: '保存设置' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('连拍间隔（秒）'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    await screen.findByText(/只读磁盘/); expect(useView.getState().threshold).toBe(1000);
    api.putJSON.mockResolvedValueOnce({ settings: { burstThresholdMs: 2500, cellWidth: 210, sort: 'time' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(useView.getState().threshold).toBe(2500);
    expect(api.putJSON).toHaveBeenLastCalledWith('/api/library/settings', { burstThresholdMs: 2500 });
  });
  it('保存响应晚于切库时不改变新库的分组', async () => {
    let resolve!: (value: unknown) => void;
    api.putJSON.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const close = vi.fn(); render(<SettingsPanel onClose={close} />);
    fireEvent.change(screen.getByLabelText('连拍间隔（秒）'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    api.sid = 'two';
    await act(async () => resolve({ settings: { burstThresholdMs: 3000 } }));
    expect(useView.getState().threshold).toBe(1000); expect(close).not.toHaveBeenCalled();
  });
  it('实时同步先到达时，保存响应保留当前照片所在的展开组', async () => {
    let resolve!: (value: unknown) => void;
    api.putJSON.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const close = vi.fn(); render(<SettingsPanel onClose={close} />);
    fireEvent.change(screen.getByLabelText('连拍间隔（秒）'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    act(() => {
      useView.getState().setThreshold(2000);
      useView.setState({ expanded: new Set(['focused-burst']) });
    });
    await act(async () => resolve({ settings: { burstThresholdMs: 2000, cellWidth: 210, sort: 'time' } }));
    expect(close).toHaveBeenCalledOnce();
    expect(useView.getState().expanded.has('focused-burst')).toBe(true);
  });
});
