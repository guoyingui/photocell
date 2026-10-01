import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeToggle } from './ThemeToggle';
import { initializeTheme, useTheme } from '../store/theme';

let light: boolean;
let media: EventTarget;
let stop: (() => void) | undefined;

beforeEach(() => {
  localStorage.clear();
  light = true;
  media = new EventTarget();
  vi.stubGlobal('matchMedia', () => Object.assign(media, { matches: light }));
  useTheme.setState({ theme: 'dark', preference: null });
});
afterEach(() => {
  cleanup();
  stop?.();
  stop = undefined;
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('首次跟随系统，系统改变时更新所有主题切换入口', () => {
  stop = initializeTheme();
  const { getAllByRole } = render(<><ThemeToggle /><ThemeToggle /></>);
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(getAllByRole('button', { name: '切换到黑色主题' })).toHaveLength(2);
  act(() => { light = false; media.dispatchEvent(new Event('change')); });
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(getAllByRole('button', { name: '切换到白色主题' })).toHaveLength(2);
});

it('手动选择覆盖系统设置，重新初始化后仍保留', () => {
  stop = initializeTheme();
  const { getByRole } = render(<ThemeToggle />);
  fireEvent.click(getByRole('button', { name: '切换到黑色主题' }));
  expect(localStorage.getItem('photocull.theme')).toBe('dark');
  act(() => { media.dispatchEvent(new Event('change')); });
  expect(document.documentElement.dataset.theme).toBe('dark');
  stop();
  act(() => { stop = initializeTheme(); });
  expect(document.documentElement.dataset.theme).toBe('dark');
  fireEvent.click(getByRole('button', { name: '切换到白色主题' }));
  expect(localStorage.getItem('photocull.theme')).toBe('light');
  expect(document.documentElement.dataset.theme).toBe('light');
});

it('存储不可用时仍能跟随系统并切换主题', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  stop = initializeTheme();
  const { getByRole } = render(<ThemeToggle />);
  fireEvent.click(getByRole('button', { name: '切换到黑色主题' }));
  expect(document.documentElement.dataset.theme).toBe('dark');
});
