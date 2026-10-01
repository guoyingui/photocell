import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkBar } from './MarkBar';
import { Thumb } from './Thumb';
import { useMarks } from '../store/marks';
import { useView } from '../store/view';
import { setSession } from '../store/session';
import { useKeyboard } from '../lib/useKeyboard';
import type { Asset } from '../types';

vi.mock('../lib/thumbSource', () => ({ useThumb: () => ({ url: null, failed: false }) }));
vi.mock('../lib/api', () => ({ putJSON: vi.fn(() => Promise.resolve({})) }));
const assets: Asset[] = ['A', 'B', 'C'].map((id) => ({
  id, stem: id, dir: '', raws: [`${id}.CR3`], jpg: `${id}.JPG`, jpgSize: 1, jpgMtimeMs: 1,
}));
const order = assets.map((asset) => asset.id);
function Harness() {
  useKeyboard(order);
  return <><MarkBar />{assets.map((asset) => (
    <Thumb key={asset.id} asset={asset} priority={0} visible order={order} />
  ))}</>;
}
beforeEach(() => {
  useView.getState().reset(); useMarks.getState().load({});
  setSession({ kind: 'admin', user: null });
});
afterEach(() => cleanup());

describe('电脑端选片', () => {
  it('标记和选区分开显示，没有照片复选框', () => {
    useMarks.getState().load({ A: 'pick', B: 'reject' });
    const { getByRole, queryAllByRole, container } = render(<Harness />);
    expect(getByRole('img', { name: '已收藏' })).toBeTruthy();
    expect(queryAllByRole('checkbox')).toHaveLength(0);
    expect(container.querySelector('.thumb-selected')).toBeNull();
  });
  it('Ctrl 点选批量标记只作用于选区，执行后清空', () => {
    const { getByRole, container } = render(<Harness />);
    fireEvent.click(container.querySelector('[data-id="A"]')!);
    fireEvent.click(container.querySelector('[data-id="C"]')!, { ctrlKey: true });
    fireEvent.click(getByRole('button', { name: '收藏' }));
    expect(useMarks.getState().marks).toEqual({ A: 'pick', C: 'pick' });
    expect(useView.getState().selection.size).toBe(0);
  });
  it('Shift 点选连续范围，双击大图后只操作当前一张', () => {
    const { container } = render(<Harness />);
    fireEvent.click(container.querySelector('[data-id="A"]')!);
    fireEvent.click(container.querySelector('[data-id="C"]')!, { shiftKey: true });
    expect([...useView.getState().selection]).toEqual(['A', 'B', 'C']);
    fireEvent.doubleClick(container.querySelector('[data-id="B"]')!);
    fireEvent.keyDown(document.body, { key: 'p' });
    expect(useMarks.getState().marks).toEqual({ B: 'pick' });
  });
  it('Ctrl+A 全选，批量快捷键处理后不残留旧选区', () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: 'a', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'x' });
    expect(useMarks.getState().marks).toEqual({ A: 'reject', B: 'reject', C: 'reject' });
    expect(useView.getState().selection.size).toBe(0);
  });
  it('已隐藏页签支持鼠标选择后取消隐藏', () => {
    useMarks.getState().load({}, undefined, ['A', 'B']);
    useView.getState().setTab('hidden');
    const { container } = render(<Harness />);
    fireEvent.click(container.querySelector('[data-id="A"]')!);
    fireEvent.click(container.querySelector('.markbar-hide')!);
    expect([...useMarks.getState().hidden]).toEqual(['B']);
  });
  it('只读访客可选照片但没有写入口，快捷键不能修改', () => {
    setSession({ kind: 'user', user: { id: 'u_1', nickname: '访客', role: 'viewer' } });
    const { queryByRole, container } = render(<Harness />);
    fireEvent.click(container.querySelector('[data-id="A"]')!);
    fireEvent.keyDown(document.body, { key: 'p' });
    expect(useMarks.getState().marks).toEqual({});
    expect(queryByRole('toolbar')).toBeNull();
  });
});
