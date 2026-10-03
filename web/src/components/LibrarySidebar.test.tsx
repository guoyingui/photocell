import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LibrarySidebar } from './LibrarySidebar';
import { GuestsOnlineConfirm } from './GuestsOnlineConfirm';
import { useFolderActions } from '../lib/useFolderActions';
import { useFolders, readFolders } from '../store/folders';
import { useLibrary } from '../store/library';
import { useView } from '../store/view';
import { useMarks } from '../store/marks';
import { setSession } from '../store/session';

const api = vi.hoisted(() => ({ missing: '', block: false, closeFailure: false }));
vi.mock('../lib/api', () => ({ getJSON: vi.fn(async (url: string) => {
  const path = new URL(url, 'http://test').searchParams.get('path');
  if (path === api.missing) throw new Error('路径不存在，请连接移动硬盘后重试');
  return { path };
}), putJSON: vi.fn(), setSessionGoneHandler: vi.fn() }));
const open = vi.fn(async (root: string) => {
  useView.getState().reset();
  useLibrary.setState({ root, sessionId: root, phase: 'ready', error: null, closeBlocked: null });
});
const close = vi.fn(async (force = false) => {
  if (api.block && !force) { useLibrary.setState({ closeBlocked: { online: 2, message: '还有 2 位访客在线，链接仍然有效。' } }); return; }
  useLibrary.setState({ root: null, sessionId: null, phase: 'idle', closeBlocked: null, error: api.closeFailure ? '标记未能写入磁盘' : null });
});
const revoke = vi.fn();
function Harness() {
  const folders = useFolderActions();
  const blocked = useLibrary((state) => state.closeBlocked);
  return <><LibrarySidebar onAdd={vi.fn()} onOpen={folders.open} onRemove={folders.remove} busyPath={folders.busyPath} />
    {blocked && <GuestsOnlineConfirm message={blocked.message} onCancel={folders.cancel} onForce={folders.force}
      busy={folders.busyPath !== null} onRevoke={() => { folders.cancel(); revoke(); }} />}</>;
}
beforeEach(() => {
  localStorage.clear(); api.missing = ''; api.block = false; api.closeFailure = false; vi.clearAllMocks();
  useFolders.getState().reload(); useFolders.getState().add(['/a', '/b']);
  useView.getState().reset(); useMarks.getState().load({}); setSession({ kind: 'admin' });
  useLibrary.setState({ root: '/a', sessionId: '/a', phase: 'ready', assets: [], warnings: [], refreshing: false,
    error: null, errorDetail: null, closeBlocked: null, open, close, dismissCloseBlock: () => useLibrary.setState({ closeBlocked: null }) });
});
afterEach(() => { cleanup(); localStorage.clear(); });

it('目录常驻，点击其他目录先关闭旧库再打开，记住当前目录并清空旧选区', async () => {
  useView.getState().setCursor('old-photo'); render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: '打开目录 /b' }));
  await waitFor(() => expect(open).toHaveBeenCalledWith('/b'));
  expect(close).toHaveBeenCalledWith(false);
  expect(close.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]);
  expect(screen.getByRole('button', { name: '打开目录 /b' }).getAttribute('aria-current')).toBe('page');
  expect(readFolders()).toEqual({ roots: ['/a', '/b'], lastRoot: '/b' });
  expect(useView.getState().selection.size).toBe(0);
});
it('移除非当前目录不关闭库，移除当前目录后仍保留其他目录', async () => {
  render(<Harness />); fireEvent.click(screen.getByRole('button', { name: '从列表移除 /b' }));
  expect(close).not.toHaveBeenCalled(); expect(useLibrary.getState().root).toBe('/a');
  useFolders.getState().add(['/b']);
  fireEvent.click(screen.getByRole('button', { name: '从列表移除 /a' }));
  await waitFor(() => expect(readFolders().roots).toEqual(['/b']));
  expect(open).not.toHaveBeenCalled(); expect(readFolders().lastRoot).toBeNull();
});
it('有访客时保留当前库和待切换目标，取消不会切换，确认后继续打开原目标', async () => {
  api.block = true; render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: '打开目录 /b' }));
  const dialog = await screen.findByRole('alertdialog'); expect(dialog.textContent).toContain('链接仍然有效');
  expect(open).not.toHaveBeenCalled(); expect(useLibrary.getState().root).toBe('/a');
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('alertdialog')).toBeNull(); expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '打开目录 /b' }));
  fireEvent.click(await screen.findByRole('button', { name: '仍然关闭并继续' }));
  await waitFor(() => expect(open).toHaveBeenCalledWith('/b'));
  expect(close).toHaveBeenLastCalledWith(true);
});
it('当前目录移除也保留访客保护，并提供撤销分享的入口', async () => {
  api.block = true; render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: '从列表移除 /a' }));
  fireEvent.click(await screen.findByRole('button', { name: '去撤销链接…' }));
  expect(revoke).toHaveBeenCalledOnce(); expect(readFolders().roots).toContain('/a');
  expect(open).not.toHaveBeenCalled(); expect(screen.queryByRole('alertdialog')).toBeNull();
});
it('失效目录先报错，不关闭当前库；关闭落盘失败也不继续切换', async () => {
  api.missing = '/b'; render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: '打开目录 /b' }));
  await waitFor(() => expect(useLibrary.getState().error).toContain('路径不存在'));
  expect(close).not.toHaveBeenCalled(); expect(useLibrary.getState().root).toBe('/a');
  api.missing = ''; api.closeFailure = true;
  fireEvent.click(screen.getByRole('button', { name: '打开目录 /b' }));
  await waitFor(() => expect(useLibrary.getState().error).toBe('标记未能写入磁盘'));
  expect(open).not.toHaveBeenCalled();
});
it('重新进入页面恢复上次目录；扫描或刷新期间不允许并发切换与移除', async () => {
  useFolders.getState().opened('/b'); useLibrary.setState({ phase: 'idle', root: null, sessionId: null });
  const mounted = render(<Harness />);
  await waitFor(() => expect(open).toHaveBeenCalledWith('/b')); mounted.unmount();
  useLibrary.setState({ phase: 'scanning' }); render(<Harness />);
  expect(screen.getByRole('button', { name: '打开目录 /a' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: '从列表移除 /b' })).toHaveProperty('disabled', true);
});
