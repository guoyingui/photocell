import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VersionsPanel } from './VersionsPanel';
import { getJSON } from '../lib/api';
vi.mock('../lib/api', () => ({ getSessionId: () => 'sid', getJSON: vi.fn() }));
beforeEach(() => {
  vi.mocked(getJSON).mockResolvedValue({ versions: [
    { id: 'two', subject: 'admin', name: '最终名单', action: 'final', createdAt: 2, pickedIds: ['B'], note: '第二轮', photoNotes: {} },
    { id: 'one', subject: 'admin', name: '最终名单', action: 'final', createdAt: 1, pickedIds: ['A'], note: '第一轮', photoNotes: { A: '自然' } },
    { id: 'guest', subject: 'guest', name: '客户', action: 'submit', createdAt: 3, pickedIds: ['C'], note: '', photoNotes: {} },
  ] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('显示新增撤回和备注清除，并将客户版本与最终名单分开', async () => {
  render(<VersionsPanel onClose={() => {}} />);
  await screen.findByText('新增 1 张 · 撤回 1 张 · 照片备注变化 1 条');
  expect(screen.getByText('之后：已清除')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('名单'), { target: { value: 'guest' } });
  expect(screen.getByText('新增 1 张 · 撤回 0 张 · 照片备注变化 0 条')).toBeTruthy();
  expect(screen.queryByText('之后：已清除')).toBeNull();
});
it('Escape 关闭面板并恢复触发按钮焦点', async () => {
  const close = vi.fn(); const button = document.createElement('button'); document.body.append(button); button.focus();
  const view = render(<VersionsPanel onClose={close} />);
  await screen.findByText('新增 1 张 · 撤回 1 张 · 照片备注变化 1 条');
  fireEvent.keyDown(screen.getByLabelText('名单'), { key: 'Escape' }); expect(close).toHaveBeenCalledOnce();
  view.unmount(); expect(document.activeElement).toBe(button); button.remove();
});
