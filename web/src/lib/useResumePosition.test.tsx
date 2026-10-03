import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useResumePosition } from './useResumePosition';
import { readPosition, rememberPosition } from './resume';
import { useView } from '../store/view';
import { useMarks } from '../store/marks';
import type { Asset } from '../types';
import type { Group } from './bursts';

vi.mock('./api', () => ({ putJSON: vi.fn(async () => ({})) }));

const assets: Asset[] = ['A', 'B', 'C'].map((id) => ({
  id, dir: '', stem: id, raws: [], jpg: `${id}.jpg`, jpgSize: 1, jpgMtimeMs: 1,
}));
const singles = assets.map((asset) => ({ key: asset.id, ids: [asset.id] }));
function Harness({ root = '/one', ready = true, groups = singles }: {
  root?: string; ready?: boolean; groups?: Group[];
}) {
  useResumePosition(root, ready, assets, groups);
  return null;
}

beforeEach(() => {
  localStorage.clear();
  useView.getState().reset();
  useMarks.getState().load({});
});
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });

describe('续选位置恢复', () => {
  it('等待载入完成后恢复单张位置，并随元数据分组自动展开', () => {
    rememberPosition('/one', 'B');
    const { rerender } = render(<Harness ready={false} />);
    expect(useView.getState().cursor).toBeNull();
    rerender(<Harness />);
    expect(useView.getState().cursor).toBe('B');
    expect([...useView.getState().selection]).toEqual(['B']);
    rerender(<Harness groups={[{ key: 'A', ids: ['A', 'B'] }, singles[2]]} />);
    expect(useView.getState().expanded.has('A')).toBe(true);
  });

  it.each(['missing', 'B'])('不恢复已不存在或隐藏的照片：%s', (id) => {
    rememberPosition('/one', id);
    useMarks.getState().load({}, undefined, ['B']);
    render(<Harness />);
    expect(useView.getState().cursor).toBeNull();
    expect(useView.getState().selection.size).toBe(0);
  });

  it('已有光标时不抢位置，切库后只写入当前目录', () => {
    rememberPosition('/one', 'B');
    useView.getState().setCursor('C');
    const { rerender } = render(<Harness />);
    expect(useView.getState().cursor).toBe('C');
    act(() => useView.getState().setCursor('A'));
    expect(readPosition('/one')).toBe('A');

    act(() => useView.getState().reset());
    rerender(<Harness root="/two" />);
    act(() => useView.getState().setCursor('C'));
    expect(readPosition('/two')).toBe('C');
    expect(readPosition('/one')).toBe('A');
  });

  it('手动离开恢复位置后，新的连拍分组不会自动展开旧位置', () => {
    rememberPosition('/one', 'B');
    const { rerender } = render(<Harness />);
    act(() => useView.getState().setCursor('C'));
    rerender(<Harness groups={[{ key: 'A', ids: ['A', 'B'] }, singles[2]]} />);
    expect(useView.getState().expanded.size).toBe(0);
    expect(readPosition('/one')).toBe('C');
  });
});
