import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FilenameMatchPanel } from './FilenameMatchPanel';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { useView } from '../store/view';
import { useSession, setSession } from '../store/session';
import { applyMark } from '../lib/applyMark';
import type { Asset } from '../types';

const api = vi.hoisted(() => ({ sid: 'sid' }));
vi.mock('../lib/api', () => ({ getSessionId: () => api.sid, setSessionGoneHandler: vi.fn(), getJSON: vi.fn(), putJSON: vi.fn() }));
vi.mock('../lib/applyMark', () => ({ applyMark: vi.fn(() => true) }));
const photo = (id: string, dir: string, stem: string): Asset => ({ id, dir, stem, raws: [stem + '.CR3'], jpg: stem + '.JPG', jpgSize: 1, jpgMtimeMs: 1 });
const assets = [photo('a', 'day1', 'IMG_1'), photo('b', 'day2', 'IMG_1'), photo('c', '', 'IMG_2'), photo('h', '', 'HIDDEN')];
beforeEach(() => {
  api.sid = 'sid'; vi.clearAllMocks(); useView.getState().reset(); useMarks.getState().load({}, undefined, ['h']);
  useLibrary.setState({ root: '/test/photos', assets });
  setSession({ kind: 'admin', user: null, selectionLocked: false });
});
afterEach(() => { cleanup(); });
function analyze(text: string) {
  fireEvent.change(screen.getByLabelText('文件名清单'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: '开始匹配' }));
}

it('同名候选必须确认；加入选区去重且保留原选区，并显示匹配清单', () => {
  const close = vi.fn(); useView.getState().setCursor('a'); useView.getState().setPhotoFilters({ query: 'old' });
  useView.getState().setSelection(['a']);
  render(<FilenameMatchPanel onClose={close} />);
  analyze('IMG_1.JPG\nIMG_2.JPG\nIMG_2.CR3\ngone.JPG\nHIDDEN.JPG');
  expect(screen.getByRole('status').textContent).toContain('未找到 2 行');
  expect((screen.getByRole('button', { name: '加入选区（1）' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('第 1 行同名照片'), { target: { value: 'id:b' } });
  fireEvent.click(screen.getByRole('button', { name: '加入选区（2）' }));
  expect([...useView.getState().selection]).toEqual(['a', 'b', 'c']);
  expect(useView.getState().matchedIds).toEqual(['a', 'b', 'c']); expect(useView.getState().photoFilters.query).toBe('');
  expect(applyMark).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
});
it('收藏只作用于本次确认结果，不把原选区或跳过的同名项一起收藏', () => {
  useView.getState().setCursor('a'); render(<FilenameMatchPanel onClose={vi.fn()} />);
  analyze('IMG_1\nIMG_2.JPG\nIMG_2.CR3');
  fireEvent.change(screen.getByLabelText('第 1 行同名照片'), { target: { value: 'skip' } });
  fireEvent.click(screen.getByRole('button', { name: '收藏匹配（1）' }));
  expect(applyMark).toHaveBeenCalledWith('pick', { targets: ['c'] });
  expect(useView.getState().matchedIds).toEqual(['c']); expect(useView.getState().selection.size).toBe(0);
});
it('目录刷新、隐藏或会话变化后，旧匹配结果不能直接提交', () => {
  render(<FilenameMatchPanel onClose={vi.fn()} />); analyze('IMG_2');
  act(() => useLibrary.setState({ assets: [...assets] }));
  expect(screen.getByRole('alert').textContent).toContain('重新匹配');
  expect((screen.getByRole('button', { name: '收藏匹配（1）' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '重新匹配' }));
  api.sid = 'other'; fireEvent.click(screen.getByRole('button', { name: '收藏匹配（1）' }));
  expect(applyMark).not.toHaveBeenCalled(); expect(useView.getState().matchedIds).toBeNull();
});
it('只读或已锁定客户可以匹配与选择，没有收藏入口；权限变化立即生效', () => {
  setSession({ kind: 'user', user: { id: 'alice', nickname: '客户', role: 'viewer' } });
  render(<FilenameMatchPanel onClose={vi.fn()} />); analyze('IMG_2');
  expect(screen.queryByRole('button', { name: /收藏匹配/ })).toBeNull();
  act(() => setSession({ user: { id: 'alice', nickname: '客户', role: 'editor' } }));
  expect(screen.getByRole('button', { name: '收藏匹配（1）' })).toBeTruthy();
  act(() => useSession.setState({ selectionLocked: true }));
  expect(screen.queryByRole('button', { name: /收藏匹配/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '加入选区（1）' }));
  expect([...useView.getState().selection]).toEqual(['c']); expect(applyMark).not.toHaveBeenCalled();
});
it('CSV 可选择文件名列，异步读取旧文件不会覆盖用户后来输入的清单', async () => {
  render(<FilenameMatchPanel onClose={vi.fn()} />);
  analyze('编号,清单\n1,IMG_2.JPG');
  expect(screen.getByRole('status').textContent).toContain('未找到 2 行');
  fireEvent.click(screen.getByLabelText('首行是列名'));
  fireEvent.change(screen.getByLabelText('文件名列'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: '开始匹配' }));
  expect(screen.getByRole('status').textContent).toContain('已匹配 1 张');
  expect(screen.getByRole('status').textContent).toContain('未找到 0 行');
  let finish!: (text: string) => void;
  const file = { name: 'list.txt', size: 40, text: () => new Promise<string>((resolve) => { finish = resolve; }) };
  fireEvent.change(screen.getByLabelText('导入 TXT / CSV'), { target: { files: [file] } });
  fireEvent.change(screen.getByLabelText('文件名清单'), { target: { value: 'day2/IMG_1.JPG' } });
  await act(async () => finish('IMG_2.JPG'));
  expect((screen.getByLabelText('文件名清单') as HTMLTextAreaElement).value).toBe('day2/IMG_1.JPG');
});
it('读取有效文件后可以匹配，并支持 Escape 关闭', async () => {
  const close = vi.fn(); render(<FilenameMatchPanel onClose={close} />);
  fireEvent.change(screen.getByLabelText('导入 TXT / CSV'), { target: { files: [{ name: 'list.csv', size: 40, text: async () => '文件名\nIMG_2.JPG' }] } });
  await waitFor(() => expect((screen.getByLabelText('文件名清单') as HTMLTextAreaElement).value).toContain('IMG_2.JPG'));
  fireEvent.click(screen.getByRole('button', { name: '开始匹配' }));
  expect(screen.getByRole('status').textContent).toContain('已匹配 1 张');
  fireEvent.keyDown(screen.getByLabelText('文件名清单'), { key: 'Escape' }); expect(close).toHaveBeenCalledOnce();
});
