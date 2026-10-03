import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVisiblePhotos } from './useVisiblePhotos';
import { useKeyboard } from './useKeyboard';
import { useView } from '../store/view';
import { useMarks } from '../store/marks';
import { setSession } from '../store/session';
import { MarkBar } from '../components/MarkBar';

vi.mock('./api', () => ({ putJSON: vi.fn(async () => ({})) }));

function Harness({ ids, ready = true }: { ids: string[]; ready?: boolean }) {
  useVisiblePhotos(ids, ready);
  useKeyboard(ids);
  return <MarkBar />;
}

beforeEach(() => {
  useView.getState().reset();
  useMarks.getState().load({});
  setSession({ kind: 'admin', user: null });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('筛选结果变化后的操作目标', () => {
  it('移除不可见的选中照片，鼠标标记只写入剩余选区', () => {
    useView.getState().setSelection(['A', 'B']);
    const { rerender, getByRole } = render(<Harness ids={['A', 'B', 'C']} />);
    rerender(<Harness ids={['B', 'C']} />);
    expect([...useView.getState().selection]).toEqual(['B']);
    expect(useView.getState().anchor).toBeNull();
    fireEvent.click(getByRole('button', { name: '收藏' }));
    expect(useMarks.getState().marks).toEqual({ B: 'pick' });
  });

  it('大图被筛掉后关闭，后续快捷键不能标记旧照片', () => {
    useView.getState().openLightbox('A');
    const { rerender } = render(<Harness ids={['A', 'B']} />);
    rerender(<Harness ids={['B']} />);
    expect(useView.getState().lightbox).toBeNull();
    expect(useView.getState().cursor).toBeNull();
    fireEvent.keyDown(window, { key: 'p' });
    expect(useMarks.getState().marks).toEqual({});
  });

  it('对比中的任一照片消失后退出，保留仍可见的候选光标', () => {
    useView.getState().openCompare('A', 'B');
    const { rerender } = render(<Harness ids={['A', 'B']} />);
    rerender(<Harness ids={['B']} />);
    expect(useView.getState().compare).toBeNull();
    expect(useView.getState().cursor).toBe('B');
  });

  it('载入期间不抢先清空选区，完整筛选结果仍包含折叠组内照片', () => {
    useView.getState().setSelection(['A', 'B']);
    const { rerender } = render(<Harness ids={[]} ready={false} />);
    expect(useView.getState().selection.size).toBe(2);
    rerender(<Harness ids={['A', 'B', 'C']} />);
    expect([...useView.getState().selection]).toEqual(['A', 'B']);
    act(() => useView.getState().setCursor('C'));
    expect(useView.getState().cursor).toBe('C');
  });
});
