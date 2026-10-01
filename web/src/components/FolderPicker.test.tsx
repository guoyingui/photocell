import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderPicker } from './FolderPicker';
import { useLibrary } from '../store/library';

/**
 * DirBrowser 一挂载就发两个请求（`/api/fs/roots` 和 `/api/fs/list`）。不替身掉
 * 会在 jsdom 里留下未处理的拒绝——本仓库要求测试输出干净。照 App.test.tsx 的
 * 先例替身整个 api 模块，而不是去 stub fetch。
 *
 * `listDirs` 是「/api/fs/list 返回哪些子目录」唯一的可变入口，默认空。用
 * vi.hoisted 包一层——和本仓库 ExportPanel.test.tsx / JoinGate.test.tsx 的写法
 * 保持一致：vi.mock 的工厂函数在模块求值早期就跑，直接引用下面那个 const 会
 * 因为时间顺序拿到 undefined。「命中当前目录列出的子目录」那条用例会在渲染前
 * 塞一条进去，afterEach 里复位，避免串到其他用例（其余用例都假设目录是空的）。
 */
const apiMock = vi.hoisted(() => ({
  listDirs: [] as { name: string; path: string }[],
}));

vi.mock('../lib/api', () => ({
  getJSON: vi.fn((path: string) => (
    path.includes('/api/fs/roots')
      ? Promise.resolve({ roots: [], home: '/tmp' })
      : Promise.resolve({ path: '/tmp', parent: '/tmp', dirs: apiMock.listDirs })
  )),
  postJSON: vi.fn(() => new Promise(() => {})),
  putJSON: vi.fn(),
  openStream: vi.fn(() => () => {}),
  withSid: (u: string) => u,
  setSessionId: vi.fn(),
  getSessionId: vi.fn(() => null),
  setSessionGoneHandler: vi.fn(),
}));

const KEY = 'photocull.recent';

beforeEach(() => {
  localStorage.clear();
  useLibrary.setState({
    phase: 'idle', root: null, assets: [], metas: new Map(),
    error: null, errorDetail: null,
  });
});

// 本仓库没有 test.globals，testing-library 的自动 cleanup 不会注册，
// 不写这一句 DOM 会跨用例泄漏。apiMock.listDirs 也在这里复位——
// 不然「命中当前目录列出的子目录」那条用例塞进去的数据会漏到后面的用例里。
afterEach(() => {
  cleanup();
  apiMock.listDirs = [];
});

const delButtons = () => screen.queryAllByRole('button', { name: /不再显示/ });

describe('FolderPicker：最近打开可以逐条删掉', () => {
  it('每条记录都有一个删除按钮', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a', '/b', '/c']));
    render(<FolderPicker />);
    expect(delButtons()).toHaveLength(3);
  });

  it('点某条的 ✕：那条从界面消失，其余还在', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a', '/b', '/c']));
    render(<FolderPicker />);
    fireEvent.click(screen.getByRole('button', { name: '不再显示 /b' }));
    expect(screen.queryByRole('button', { name: '/b' })).toBeNull();
    expect(screen.getByRole('button', { name: '/a' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '/c' })).toBeTruthy();
  });

  it('删掉的那条也从 localStorage 里没了', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a', '/b']));
    render(<FolderPicker />);
    fireEvent.click(screen.getByRole('button', { name: '不再显示 /a' }));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['/b']);
  });

  it('删光之后整个「最近打开」区块消失', () => {
    localStorage.setItem(KEY, JSON.stringify(['/only']));
    render(<FolderPicker />);
    fireEvent.click(screen.getByRole('button', { name: '不再显示 /only' }));
    expect(screen.queryByText('最近打开')).toBeNull();
  });

  // ✕ 不碰 library，扫描期间删一条 MRU 记录没有任何副作用；
  // 旁边那个"打开"按钮则照旧禁用。
  it('扫描期间 ✕ 仍然可点，而路径按钮被禁用', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a']));
    useLibrary.setState({ phase: 'scanning' });
    render(<FolderPicker />);
    expect(screen.getByRole('button', { name: '不再显示 /a' })).not.toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '/a' })).toHaveProperty('disabled', true);
  });
});

/** 造一次 drop 事件用的假 DataTransfer。 */
function dropDataTransfer(entries: { name: string; isDirectory: boolean }[]) {
  return {
    items: entries.map((e) => ({ webkitGetAsEntry: () => e })),
    types: ['Files'],
  };
}

describe('拖拽定位', () => {
  it('命中最近打开时把那条列成候选，但不自动打开', () => {
    // 「永远不会静默猜错」是这条功能的立身之本：它从不替你打开任何东西。
    window.localStorage.setItem('photocull.recent', JSON.stringify(['/Users/guoyg/婚礼-小林']));
    const open = vi.fn();
    useLibrary.setState({ open, phase: 'idle' });

    const { getByTestId, getByText } = render(<FolderPicker />);
    fireEvent.drop(getByTestId('picker-dropzone'), {
      dataTransfer: dropDataTransfer([{ name: '婚礼-小林', isDirectory: true }]),
    });

    // 光找「婚礼-小林」这几个字不够精确——同一个名字这时候在页面上出现了三处
    // （命中横幅本身、横幅里的 <code> 路径、以及「最近打开」列表那一条），后两
    // 处光靠 localStorage 里那条记录就会显示，不代表拖拽命中逻辑真的跑通了。
    // 收紧到横幅独有的措辞，才是在钉住「命中横幅确实渲染了」这件事。
    expect(getByText(/找到了「婚礼-小林」/)).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
  });

  it('拖入文件而不是文件夹时显示提示', () => {
    const { getByTestId, getByText } = render(<FolderPicker />);
    fireEvent.drop(getByTestId('picker-dropzone'), {
      dataTransfer: dropDataTransfer([{ name: 'IMG_0001.CR2', isDirectory: false }]),
    });
    expect(getByText('请拖入文件夹，不是文件')).toBeTruthy();
  });

  it('都没命中时把名字显示出来让用户自己找', () => {
    const { getByTestId, getByText } = render(<FolderPicker />);
    fireEvent.drop(getByTestId('picker-dropzone'), {
      dataTransfer: dropDataTransfer([{ name: '从没见过的', isDirectory: true }]),
    });
    expect(getByText(/从没见过的/)).toBeTruthy();
    expect(getByText(/请在下面找到它/)).toBeTruthy();
  });

  // 上面两条用例的 mock 对 /api/fs/list 恒返回空 dirs，locate() 永远只可能
  // 命中 recent 或 none 这两支，DirBrowser 的 gotoPath 跳转、dirbrowser-hit
  // 高亮这两处代码从没被任何用例跑到过。这条补上 dirs 非空、且不落在 recent
  // 里的场景，专门去戳 kind === 'listed' 这一支。
  it('命中当前目录列出的子目录时那一行会高亮，但同样不自动打开', async () => {
    apiMock.listDirs = [{ name: '写真', path: '/tmp/写真' }];
    const open = vi.fn();
    useLibrary.setState({ open, phase: 'idle' });

    const { getByTestId } = render(<FolderPicker />);
    // DirBrowser 的目录列表是异步拉回来的（getJSON 返回一个 Promise），
    // 挂载那一刻列表还是空的——drop 太早，locate() 会拿着空的 listed 去比对，
    // 测的就不是这条分支了，必须先等它渲染出来。
    await screen.findByRole('button', { name: '写真' });

    fireEvent.drop(getByTestId('picker-dropzone'), {
      dataTransfer: dropDataTransfer([{ name: '写真', isDirectory: true }]),
    });

    // 命中的同时会触发 DirBrowser 的 gotoPath 效果——那也是一次异步的
    // browse()，会再发一次 /api/fs/list。用 waitFor 重新查询而不是复用上面
    // 那个引用，把这次跟着来的状态更新也等掉，不然它会在这条用例返回之后
    // 才落地，冒出 act() 警告污染下一条用例的输出。
    await waitFor(() => {
      const li = screen.getByRole('button', { name: '写真' }).closest('li');
      expect(li).not.toBeNull();
      expect(li?.className).toContain('dirbrowser-hit');
    });
    expect(open).not.toHaveBeenCalled();
  });
});
