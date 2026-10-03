import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { useView } from '../store/view';
import { setSession } from '../store/session';

const closeSpy = vi.fn();
const dismissSpy = vi.fn();

/** 只填这一组用例真正读到的那几个字段，其余走 store 的默认值。 */
function setLibrary(over: Partial<ReturnType<typeof useLibrary.getState>> = {}) {
  useLibrary.setState({
    root: '/Users/photographer/雨婚礼',
    assets: [],
    metas: new Map(),
    bake: { done: 0, total: 0 },
    streamError: null,
    closeBlocked: null,
    close: closeSpy,
    dismissCloseBlock: dismissSpy,
    ...over,
  });
}

beforeEach(() => {
  closeSpy.mockClear().mockResolvedValue(undefined);
  dismissSpy.mockClear();
  useView.getState().reset();
  useMarks.getState().load({});
  setLibrary();
});

afterEach(() => {
  cleanup();
  useLibrary.setState({ closeBlocked: null });
});

it('电脑端顶栏提供对比与历史操作，不再显示多选模式', () => {
  setSession({ kind: 'admin', user: null });
  render(<TopBar onExport={() => {}} />);
  expect(screen.queryByRole('button', { name: '多选' })).toBeNull();
  expect(screen.getByRole('button', { name: '对比' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '重做' })).toBeTruthy();
});

it('目录管理已移到左侧，顶栏不再提供关闭目录的选择文件夹按钮', () => {
  render(<TopBar onExport={() => {}} />);
  expect(screen.queryByRole('button', { name: '选择文件夹' })).toBeNull();
  expect(closeSpy).not.toHaveBeenCalled();
});

/**
 * 顶栏不再提供连拍阈值滑块。
 *
 * 这条守的是一个产品决定，不是某个 bug：滑块删掉之后，阈值取自该文件夹
 * marks.json 里的设置（默认 1.0 秒），界面上没有调整入口。有人日后顺手把它
 * 加回顶栏时，这条会红。
 *
 * 网格缩放也从顶栏拿掉了（⌘/Ctrl+滚轮还在）。顶栏里不该再出现任何 range。
 */
describe('TopBar：不再有连拍阈值滑块', () => {
  it('顶栏里没有任何 range 输入', () => {
    const { container } = render(<TopBar onExport={() => {}} />);
    expect(container.querySelectorAll('input[type="range"]')).toHaveLength(0);
  });

  it('顶栏里没有「连拍」字样', () => {
    const { container } = render(<TopBar onExport={() => {}} />);
    expect(container.textContent).not.toContain('连拍');
  });
});

/**
 * 第五个 tab「已隐藏」。只有管理员看得到——隐藏是摄影师的操作，客户那侧
 * 没有这个概念，让他看见一个自己既填不满也清不空的 tab 只会造成困惑。
 */
describe('TopBar：第五个 tab「已隐藏」', () => {
  const asset = (id: string) => ({
    id, dir: '', stem: id, raws: [`${id}.CR3`], jpg: `${id}.JPG`, jpgSize: 1, jpgMtimeMs: 1,
  });

  it('管理员看得到它，计数只算隐藏的那些', () => {
    setSession({ kind: 'admin', user: null, share: null, online: [] });
    setLibrary({ assets: [asset('a'), asset('b'), asset('c')] });
    useMarks.getState().load({}, undefined, ['a', 'b']);

    render(<TopBar onExport={() => {}} />);

    expect(screen.getByRole('button', { name: /已隐藏/ }).textContent).toContain('2');
    // 「全部」必须把隐藏的剔掉：1 + 2 才等于库里真实的三张。少了这句，
    // 一个把 counts.hidden 算成整库大小的实现只会让上面那句变成 3 ≠ 2 才被抓到，
    // 而算成「全部」的实现（两个 tab 显示同一个数）根本抓不到。
    expect(screen.getByRole('button', { name: /全部/ }).textContent).toContain('1');
  });

  it('访客那一侧整个 tab 不进 DOM，不是置灰', () => {
    // 只读界面不展示修改入口。
    setSession({
      kind: 'user', user: { id: 'u_ab', nickname: '小林', role: 'editor' },
      share: null, online: [],
    });

    render(<TopBar onExport={() => {}} />);

    expect(screen.queryByRole('button', { name: /已隐藏/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /全部/ })).toBeTruthy();
  });

  it('它的快捷键提示是 5，和键盘那一档对得上', () => {
    // title 是从数组下标算的（快捷键 ${i + 1}）。哪天有人往 TABS 中间插一项，
    // 这里会先红——而键盘那边的 TABS 常量是另一份，两处错位不会自己暴露。
    setSession({ kind: 'admin', user: null, share: null, online: [] });
    render(<TopBar onExport={() => {}} />);
    expect(screen.getByRole('button', { name: /已隐藏/ }).getAttribute('title')).toBe('快捷键 5');
  });
});
