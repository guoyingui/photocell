import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Sidebar } from './Sidebar';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { setSession } from '../store/session';
import { useView } from '../store/view';
import type { Asset } from '../types';

const asset = (id: string, dir: string): Asset => ({
  id, dir, stem: id, raws: ['x.CR3'], jpg: 'x.JPG', jpgSize: 10, jpgMtimeMs: 5000,
});

// Sidebar 在 dirs.length <= 1 && warnings.length === 0 时整个返回 null，
// 所以夹具至少要两个目录。
const ASSETS = [
  asset('a1', 'cam-a'), asset('a2', 'cam-a'),
  asset('b1', 'cam-b'),
];

const asAdmin = () => setSession({ kind: 'admin', user: null, share: null, online: [] });
const asEditor = () => setSession({
  kind: 'user', user: { id: 'u_1', nickname: '小林', role: 'editor' }, share: null, online: [],
});
const asViewer = () => setSession({
  kind: 'user', user: { id: 'u_2', nickname: '路人', role: 'viewer' }, share: null, online: [],
});

beforeEach(() => {
  useLibrary.setState({ assets: ASSETS, warnings: [] });
  useMarks.getState().load({});
  useView.getState().reset();
  setSession({ kind: 'none', user: null, share: null, online: [] });
});

// 本仓库没有 test.globals，不写这一句 DOM 会跨用例泄漏。
afterEach(() => { cleanup(); });

const excludeButtons = () => screen.queryAllByRole('button', { name: /整批排除|取消排除/ });

describe('Sidebar：目录批量排除的门禁', () => {
  // 安全属性，不是界面装饰：三道门禁里的第二道。
  it('viewer 角色下一个排除按钮都不在 DOM 里', () => {
    asViewer();
    render(<Sidebar />);
    expect(excludeButtons()).toHaveLength(0);
  });

  // canWrite() 是默认拒绝的：身份还没解析出来时同样不给。
  it('身份还没解析出来（kind: none）时也不渲染', () => {
    render(<Sidebar />);
    expect(excludeButtons()).toHaveLength(0);
  });

  it('admin 每个目录一个按钮', () => {
    asAdmin();
    render(<Sidebar />);
    expect(excludeButtons()).toHaveLength(2);
  });

  it('editor 也有', () => {
    asEditor();
    render(<Sidebar />);
    expect(excludeButtons()).toHaveLength(2);
  });

  // 把整个库一键排掉不是一个有意义的动作。断言结构而不是"某个名字的按钮不存在"——
  // 后者对着一个本来就永远不会生成的名字，它恒真，什么也守不住。
  it('「全部」那一行没有排除按钮', () => {
    asAdmin();
    const { container } = render(<Sidebar />);
    expect(container.querySelectorAll('.dir-row')).toHaveLength(2);
    expect(container.querySelectorAll('.dir-exclude')).toHaveLength(2);
  });
});

describe('Sidebar：目录批量排除的行为', () => {
  it('点一下把该目录整批标成 reject', () => {
    asAdmin();
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: '把 cam-a 的 2 张照片整批排除' }));
    const { marks } = useMarks.getState();
    expect([marks.a1, marks.a2]).toEqual(['reject', 'reject']);
  });

  it('别的目录一张都没被碰', () => {
    asAdmin();
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: '把 cam-a 的 2 张照片整批排除' }));
    expect(useMarks.getState().marks.b1).toBeUndefined();
  });

  // 点第二次是取消，不是确认框。撤销至今只有 ⌘Z 一个入口，而 Sidebar 会在
  // 访客界面也复用这个组件，目录批量操作应当可以撤销。
  it('该目录已全部排除时，按钮变成「取消排除」，点它全数清空', () => {
    asAdmin();
    useMarks.getState().load({ a1: 'reject', a2: 'reject' });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: '取消排除 cam-a 的 2 张照片' }));
    const { marks } = useMarks.getState();
    expect([marks.a1, marks.a2]).toEqual([undefined, undefined]);
  });

  it('只排除了一部分时，点了是全排除而不是取消', () => {
    asAdmin();
    useMarks.getState().load({ a1: 'reject', a2: 'pick' });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: '把 cam-a 的 2 张照片整批排除' }));
    const { marks } = useMarks.getState();
    expect([marks.a1, marks.a2]).toEqual(['reject', 'reject']);
  });

  // 连点两下不是"撤销"，是两次独立的批量操作：先全排除、再全取消。
  // 原本已经收藏的那几张会在第二下里一并被清掉——这是这个设计已知且接受的代价，
  // 真正要回到原处只有 ⌘Z（一次撤销整批）。钉在这里是为了让它将来变了会有人发现。
  it('从混合状态连点两下：不是回到原样，而是整个目录都变成无标记', () => {
    asAdmin();
    useMarks.getState().load({ a1: 'pick' });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: '把 cam-a 的 2 张照片整批排除' }));
    expect([useMarks.getState().marks.a1, useMarks.getState().marks.a2])
      .toEqual(['reject', 'reject']);
    fireEvent.click(screen.getByRole('button', { name: '取消排除 cam-a 的 2 张照片' }));
    const { marks } = useMarks.getState();
    expect([marks.a1, marks.a2]).toEqual([undefined, undefined]);
  });

  // 作用对象是该目录的**全部**照片，不是眼前看得见的那几张。
  it('当前在「收藏」标签页上，点了仍然作用于该目录全部照片', () => {
    asAdmin();
    useMarks.getState().load({ a1: 'pick' });
    useView.getState().setTab('pick');
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: '把 cam-a 的 2 张照片整批排除' }));
    const { marks } = useMarks.getState();
    expect([marks.a1, marks.a2]).toEqual(['reject', 'reject']);
  });

  // 同上：当前筛在别的目录上，也不影响这次操作的对象。
  it('当前筛在 cam-b 上，点 cam-a 的按钮仍然只动 cam-a', () => {
    asAdmin();
    useView.getState().setDirFilter('cam-b');
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: '把 cam-a 的 2 张照片整批排除' }));
    const { marks } = useMarks.getState();
    expect([marks.a1, marks.a2, marks.b1]).toEqual(['reject', 'reject', undefined]);
  });

  // 一次 setMark 只压一条撤销记录（marks.ts:197），所以一次 ⌘Z 撤销整个文件夹。
  it('一次点击只压一条撤销记录，undo 一次全数复原', () => {
    asAdmin();
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: '把 cam-a 的 2 张照片整批排除' }));
    useMarks.getState().undo();
    const { marks } = useMarks.getState();
    expect([marks.a1, marks.a2]).toEqual([undefined, undefined]);
  });
});

describe('Sidebar：「全部」计数与隐藏（Task 16）', () => {
  // 「全部」这一行必须和下面各目录行加总一致。库里没有隐藏照片时，
  // assets.length 和「各目录行之和」永远相等，这条用例抓不住任何东西——
  // 必须真的隐藏一张，两种算法才会给出不同的数字。
  it('「全部」的数字等于各目录行加总，不是未剔除隐藏照片的 assets.length', () => {
    asAdmin();
    // ASSETS：cam-a 两张（a1/a2）、cam-b 一张（b1）。隐藏 a1 之后：
    // dirCounts 剔除隐藏项 → cam-a: 1、cam-b: 1，加总 2；
    // 而未剔除的 assets.length 仍然是 3——两者此时才会分岔。
    useMarks.getState().load({}, undefined, ['a1']);
    const { container } = render(<Sidebar />);

    // 「全部」按钮是 .sidebar 的直接子按钮；各目录按钮都包在 .dir-row 里，
    // 用结构选择器区分，不用文案（文案里的数字正是待验证的东西）。
    const total = Number(container.querySelector('.sidebar > button.dir b')!.textContent);
    const rowTotal = [...container.querySelectorAll('.dir-row b')]
      .reduce((sum, el) => sum + Number(el.textContent), 0);

    expect(total).toBe(rowTotal);
    expect(total).toBe(2); // 钉死具体数字：3（assets.length）会是这条断言真正抓住的回归
  });
});
