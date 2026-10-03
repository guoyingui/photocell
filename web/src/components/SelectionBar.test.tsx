import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelectionBar } from './SelectionBar';
import { useSelection } from '../store/selection';
import { useMarks } from '../store/marks';
import { setSession, useSession } from '../store/session';
import type { CustomerSelection } from '../types';

const api = vi.hoisted(() => ({ getJSON: vi.fn(), postJSON: vi.fn(), putJSON: vi.fn(), sid: 'sid' }));
vi.mock('../lib/api', () => ({ ...api, getSessionId: () => api.sid }));
const draft: CustomerSelection = { userId: 'alice', nickname: '客户甲', shareId: 'share', shareLabel: '婚礼',
  status: 'draft', revision: 1, pickedIds: ['A', 'B'], selectedCount: 2, limit: 30, note: '', photoNotes: {},
  submittedAt: null, confirmedAt: null, reopenedAt: null, missingIds: [] };
beforeEach(() => {
  useSelection.getState().reset(); useMarks.getState().load({}); api.sid = 'sid';
  setSession({ kind: 'user', user: { id: 'alice', nickname: '客户甲', role: 'editor' } });
  api.getJSON.mockResolvedValue({ selection: draft }); api.postJSON.mockReset(); api.putJSON.mockReset();
});
afterEach(() => { cleanup(); useSelection.getState().reset(); vi.clearAllMocks(); });

describe('客户选片提交入口', () => {
  it('旧的载入响应不能解除已收到的提交锁定', async () => {
    await useSelection.getState().activate('sid', 'alice');
    let finish!: (value: unknown) => void;
    api.getJSON.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const loading = useSelection.getState().reload();
    useSelection.getState().remote({ ...draft, status: 'submitted', revision: 3 });
    finish({ selection: draft }); await loading;
    expect(useSession.getState().canWrite()).toBe(false); expect(useSelection.getState().selection?.revision).toBe(3);
  });
  it('等待标记落地，确认提交自己的清单，提交锁定后摄影师可以重新开放', async () => {
    api.postJSON.mockResolvedValueOnce({ selection: { ...draft, status: 'submitted', revision: 2 } });
    render(<SelectionBar ready />); await screen.findByText('我已选 2 / 30 张');
    act(() => useMarks.setState({ pendingCount: 1 }));
    expect((screen.getByRole('button', { name: '正在保存标记…' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => useMarks.setState({ pendingCount: 0 }));
    fireEvent.click(screen.getByRole('button', { name: '提交选片' }));
    expect(api.postJSON).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认提交并锁定' }));
    await screen.findByText('已提交，等待摄影师确认 · 已锁定');
    expect(api.postJSON).toHaveBeenCalledWith('/api/library/selection/submit', { assetIds: ['A', 'B'], revision: 1 });
    expect(useSession.getState().canWrite()).toBe(false);
    act(() => useSelection.getState().remote({ ...draft, revision: 3 }));
    expect(screen.getByRole('button', { name: '提交选片' })).toBeTruthy();
    expect(useSession.getState().canWrite()).toBe(true);
  });
  it('未保存的备注先保存，提交失败保留确认对话框和可操作提示', async () => {
    api.putJSON.mockResolvedValueOnce({ selection: { ...draft, note: '自然肤色', revision: 2 } });
    api.postJSON.mockRejectedValueOnce(new Error('收藏清单已变化，请刷新后重试'));
    render(<SelectionBar ready />); await screen.findByText('我已选 2 / 30 张');
    fireEvent.change(screen.getByLabelText('选片备注'), { target: { value: '自然肤色' } });
    expect((screen.getByRole('button', { name: '提交选片' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '保存备注' }));
    await vi.waitFor(() => expect(useSelection.getState().selection?.note).toBe('自然肤色'));
    fireEvent.click(screen.getByRole('button', { name: '提交选片' }));
    fireEvent.click(screen.getByRole('button', { name: '确认提交并锁定' }));
    await vi.waitFor(() => expect(screen.getAllByText(/收藏清单已变化/).length).toBeGreaterThan(0));
    expect(screen.getByRole('dialog', { name: '确认提交选片' })).toBeTruthy();
  });
  it('切换身份后旧提交响应不锁定新身份', async () => {
    await useSelection.getState().activate('sid', 'alice');
    let resolve!: (value: unknown) => void;
    api.postJSON.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const submitted = useSelection.getState().submit();
    useSelection.getState().reset(); api.sid = 'next';
    api.getJSON.mockResolvedValueOnce({ selection: { ...draft, userId: 'bob' } });
    await useSelection.getState().activate('next', 'bob');
    resolve({ selection: { ...draft, status: 'submitted', revision: 2 } }); await submitted;
    expect(useSelection.getState().selection?.userId).toBe('bob');
    expect(useSession.getState().selectionLocked).toBe(false);
  });
});
