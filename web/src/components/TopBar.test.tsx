import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { useView } from '../store/view';
import { setSession } from '../store/session';

/**
 * 规格 §5.4：管理员在本地关闭一个仍有访客在线的库时，界面必须**明确告知**
 * "还有 N 位访客在线，链接仍然有效"，并给出**直达撤销的入口**。
 *
 * 修复之前"换文件夹"是直接生效的：`close()` 一按就把本地状态拆了，
 * 而服务端那一头会把包括访客在内的每一条 SSE 连接 end() 掉——正在浏览器中
 * 看图的客户当场掉线，界面上一个字的提示都没有。全仓库 grep 不到
 * "还有 N 位访客在线"这句话。
 *
 * 这一组用例钉的就是那块提示：文案原样来自服务端（store 里的 closeBlocked），
 * 三个出口（撤销 / 仍然关闭 / 取消）各自对应一个明确的动作。
 */

// SharePanel 一挂载就会拉 /api/admin/shares 和 /api/admin/netaddr。这里要验的是
// "撤销入口能不能打开它"，不是面板自己的内容，所以整个替身掉——真实实现在
// SharePanel.test.tsx 上另有覆盖。
vi.mock('./SharePanel', () => ({
  SharePanel: ({ open }: { open: boolean }) =>
    (open ? <div data-testid="share-panel" /> : null),
}));

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

const BLOCKED = {
  online: 2,
  message: '还有 2 位访客在线，链接仍然有效。关闭文件夹只是你这一侧脱离，'
    + '他们会当场掉线，但手里的链接不会失效——要真正结束访问，请到分享面板撤销这条链接。',
};

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

const changeFolder = () => screen.getByRole('button', { name: /选择文件夹/ });

it('电脑端顶栏提供对比与历史操作，不再显示多选模式', () => {
  setSession({ kind: 'admin', user: null });
  render(<TopBar onExport={() => {}} />);
  expect(screen.queryByRole('button', { name: '多选' })).toBeNull();
  expect(screen.getByRole('button', { name: '对比' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '重做' })).toBeTruthy();
});

describe('TopBar：仍有访客在线时的「换文件夹」确认（规格 §5.4）', () => {
  it('没有拦截时不显示任何确认，按钮直接调 close()', () => {
    render(<TopBar onExport={() => {}} />);

    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(changeFolder());
    expect(closeSpy).toHaveBeenCalledTimes(1);
    // 第一次按永远不带 force：踢不踢人由用户在确认框里说了算。
    expect(closeSpy.mock.calls[0][0]).toBeUndefined();
  });

  it('store 里有拦截时，把服务端那句话原样显示出来', () => {
    setLibrary({ closeBlocked: BLOCKED });
    render(<TopBar onExport={() => {}} />);

    // 没有装 @testing-library/jest-dom，用原生 textContent 断言（与 JoinGate.test.tsx 一致）。
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('还有 2 位访客在线');
    expect(dialog.textContent).toContain('链接仍然有效');
  });

  it('给出直达撤销的入口：点它就打开分享面板', () => {
    setLibrary({ closeBlocked: BLOCKED });
    render(<TopBar onExport={() => {}} />);

    expect(screen.queryByTestId('share-panel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '去撤销链接…' }));

    expect(screen.getByTestId('share-panel')).toBeTruthy();
    // 面板开了就说明这条提示已经被处理掉了，不该继续压在上面。
    expect(dismissSpy).toHaveBeenCalledTimes(1);
  });

  it('「仍然关闭」带 force 再调一次 close', async () => {
    setLibrary({ closeBlocked: BLOCKED });
    render(<TopBar onExport={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /仍然关闭/ }));

    await waitFor(() => expect(closeSpy).toHaveBeenCalledWith(true));
  });

  it('「取消」只清提示，不发任何请求', () => {
    setLibrary({ closeBlocked: BLOCKED });
    render(<TopBar onExport={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /^取消$/ }));

    expect(dismissSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('服务端没给人数时不显示成 NaN，照样把文案说出来', () => {
    setLibrary({ closeBlocked: { online: null, message: '还有访客在线，链接仍然有效' } });
    render(<TopBar onExport={() => {}} />);

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('还有访客在线');
    expect(dialog.textContent).not.toContain('NaN');
  });
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
