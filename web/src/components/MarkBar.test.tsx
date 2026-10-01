import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarkBar } from './MarkBar';
import { useMarks } from '../store/marks';
import { clearToast, useNotice } from '../store/notice';
import { useView } from '../store/view';
import { setSession } from '../store/session';

const asEditor = () => setSession({
  kind: 'user',
  user: { id: 'u_1', nickname: '小林', role: 'editor' },
  share: null, online: [],
});

beforeEach(() => {
  useMarks.getState().load({});
  useView.getState().reset();
  clearToast();
  setSession({ kind: 'none', user: null, share: null, online: [] });
});

// 本仓库没有 test.globals，testing-library 的自动 cleanup 不会注册，
// 不写这一句 DOM 会跨用例泄漏。
afterEach(() => { cleanup(); });

describe('MarkBar', () => {
  it('只选一张也可使用鼠标标记', () => {
    asEditor();
    useView.getState().toggleSelect('IMG_0002');
    const { container } = render(<MarkBar />);
    expect(container.querySelector('.markbar')).not.toBeNull();
  });

  it('一张都没选时不渲染', () => {
    asEditor();
    const { container } = render(<MarkBar />);
    expect(container.querySelector('.markbar')).toBeNull();
  });

  it('选中超过一张时显示选中数', () => {
    asEditor();
    useView.getState().setSelection(['a', 'b', 'c']);
    const { getByText } = render(<MarkBar />);
    expect(getByText('已选 3')).toBeTruthy();
  });

  it('点收藏 → 一次写入全部三张', () => {
    asEditor();
    useView.getState().setSelection(['a', 'b', 'c']);
    const { getByRole } = render(<MarkBar />);
    fireEvent.click(getByRole('button', { name: '收藏' }));
    const { marks } = useMarks.getState();
    expect([marks.a, marks.b, marks.c]).toEqual(['pick', 'pick', 'pick']);
  });

  it('执行后清空选区', () => {
    asEditor();
    useView.getState().setSelection(['a', 'b']);
    const { getByRole } = render(<MarkBar />);
    fireEvent.click(getByRole('button', { name: '排除' }));
    const s = useView.getState();
    expect(s.selection.size).toBe(0);
  });

  // 安全属性：viewer 永远拿不到这条操作条。
  it('viewer 角色下不渲染', () => {
    setSession({
      kind: 'user',
      user: { id: 'u_2', nickname: '路人', role: 'viewer' },
      share: null, online: [],
    });
    useView.getState().setSelection(['a', 'b']);
    const { container } = render(<MarkBar />);
    expect(container.querySelector('.markbar')).toBeNull();
  });
});

describe('隐藏按钮', () => {
  it('管理员的批量操作条上有「隐藏」', () => {
    setSession({ kind: 'admin', user: null });
    useView.getState().setSelection(['a', 'b']);
    const { getByText } = render(<MarkBar />);
    expect(getByText('隐藏')).toBeTruthy();
  });

  it('访客的操作条上整个不渲染这个按钮（不是置灰）', () => {
    // 只读界面只展示有权限的操作。
    setSession({ kind: 'user', user: { id: 'u_ab', nickname: '小林', role: 'editor' } });
    useView.getState().setSelection(['a', 'b']);
    const { queryByText } = render(<MarkBar />);
    expect(queryByText('隐藏')).toBeNull();
    expect(queryByText('收藏')).toBeTruthy();   // 别的按钮照常在
  });

  // 上面两条只看按钮在不在。一个渲染出来、onClick 却没接上 applyHidden 的按钮
  // 同样能让它们全绿——这条走完整条链路。
  it('点隐藏 → 整个选区立刻进 hidden', () => {
    setSession({ kind: 'admin', user: null });
    useView.getState().setSelection(['a', 'b']);
    const { getByRole } = render(<MarkBar />);
    fireEvent.click(getByRole('button', { name: '隐藏' }));
    expect([...useMarks.getState().hidden]).toEqual(['a', 'b']);
    expect(useView.getState().selection.size).toBe(0);
  });

  it('选区里已标记的那张不会被藏起来，并且当场说明为什么', () => {
    setSession({ kind: 'admin', user: null });
    useMarks.getState().load({ a: 'pick' });
    useView.getState().setSelection(['a', 'b']);
    const { getByRole } = render(<MarkBar />);
    fireEvent.click(getByRole('button', { name: '隐藏' }));
    expect([...useMarks.getState().hidden]).toEqual(['b']);
    // 不给这句话的话，用户看到的是「我选了两张，只少了一张」，没有任何解释。
    expect(useNotice.getState().text).toBe('已隐藏 1 张，1 张因为已有标记被跳过');
  });
});
