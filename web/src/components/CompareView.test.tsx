import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompareView } from './CompareView';
import { useView } from '../store/view';
import { useMarks } from '../store/marks';
import { setSession } from '../store/session';
import { useKeyboard } from '../lib/useKeyboard';
import { putJSON } from '../lib/api';
import type { Asset } from '../types';

vi.mock('../lib/api', () => ({ putJSON: vi.fn(() => Promise.resolve({ leaders: { A: 'B' }, revision: 1 })), getSessionId: () => 'test', withSid: (url: string) => url }));
const assets: Asset[] = ['A', 'B', 'C'].map((id) => ({
  id, stem: id, dir: '', jpg: `${id}.JPG`, raws: [`${id}.CR3`], jpgSize: 1, jpgMtimeMs: 1,
}));
const order = assets.map((asset) => asset.id);
const byId = new Map(assets.map((asset) => [asset.id, asset]));
function Harness({ ids = order }: { ids?: string[] }) {
  useKeyboard(ids);
  return <CompareView order={ids} byId={byId} />;
}
beforeEach(() => {
  useView.getState().reset(); useMarks.getState().load({});
  setSession({ kind: 'admin', user: null });
  useView.getState().openCompare('A', 'B');
});
afterEach(() => cleanup());

describe('双图对比', () => {
  it('换候选保留参考，键盘收藏只作用于右侧', () => {
    const { getByRole } = render(<Harness />);
    fireEvent.click(getByRole('button', { name: '下一张' }));
    expect(useView.getState().compare).toEqual({ reference: 'A', candidate: 'C' });
    fireEvent.keyDown(document.body, { key: 'p' });
    expect(useMarks.getState().marks).toEqual({ C: 'pick' });
    expect(useView.getState().compare?.candidate).toBe('C');
  });
  it('两侧同步缩放，换候选仍保留放大位置', () => {
    const { container, getByRole } = render(<Harness />);
    fireEvent.doubleClick(container.querySelector('.compare-stage')!);
    expect([...container.querySelectorAll<HTMLElement>('.compare-image')].map((el) => el.style.transform))
      .toEqual(['translate(0%, 0%) scale(2)', 'translate(0%, 0%) scale(2)']);
    fireEvent.click(getByRole('button', { name: '下一张' }));
    expect(container.textContent).toContain('同步缩放 2.0×');
    fireEvent.click(getByRole('button', { name: '恢复贴合' }));
    expect(container.textContent).toContain('同步缩放 1.0×');
  });
  it('鼠标操作参考图不会误标候选或之前的批量选区', () => {
    const { getByRole } = render(<Harness />);
    fireEvent.click(getByRole('button', { name: '收藏参考图' }));
    expect(useMarks.getState().marks).toEqual({ A: 'pick' });
  });
  it('只读访客能对比但不能写，实时降权也立即生效', () => {
    const { getByRole } = render(<Harness />);
    act(() => setSession({ kind: 'user', user: { id: 'viewer', nickname: '访客', role: 'viewer' } }));
    expect(within(getByRole('dialog')).queryByRole('button', { name: '收藏候选图' })).toBeNull();
    fireEvent.keyDown(document.body, { key: 'x' });
    expect(useMarks.getState().marks).toEqual({});
    fireEvent.click(getByRole('button', { name: '下一张' }));
    expect(useView.getState().compare?.candidate).toBe('C');
  });
  it('筛选或刷新移除比较项时关闭，不保留旧照片的操作入口', () => {
    const { rerender, queryByRole } = render(<Harness />);
    rerender(<Harness ids={['A', 'C']} />);
    expect(queryByRole('dialog')).toBeNull();
    expect(useView.getState().compare).toBeNull();
  });
});

describe('连拍组择优', () => {
  it('候选仅在组内移动，保存交换后的参考图为代表图', async () => {
    useView.getState().openCompare('A', 'B', 'A');
    const { getByRole } = render(<CompareView order={order} byId={byId} groups={[{ key: 'A', ids: ['A', 'B'] }, { key: 'C', ids: ['C'] }]} />);
    expect((getByRole('button', { name: '下一张' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(useView.getState().compare?.candidate).toBe('B');
    fireEvent.click(getByRole('button', { name: '交换位置' }));
    await act(async () => fireEvent.click(getByRole('button', { name: '将参考图设为代表图' })));
    expect(putJSON).toHaveBeenCalledWith('/api/library/burst-leaders', { key: 'A', id: 'B' });
  });
  it('确认后仅排除组内其他可见照片，整批可撤销', async () => {
    useView.getState().openCompare('A', 'B', 'A');
    const { getByRole } = render(<CompareView order={order} byId={byId} groups={[{ key: 'A', ids: ['A', 'B'] }]} />);
    fireEvent.click(getByRole('button', { name: '排除其余 1 张…' }));
    expect(useMarks.getState().marks).toEqual({});
    await act(async () => fireEvent.click(getByRole('button', { name: '确认排除其余照片' })));
    expect(useMarks.getState().marks).toEqual({ B: 'reject' });
    await act(async () => useMarks.getState().undo());
    expect(useMarks.getState().marks).toEqual({});
  });
  it('筛选移除组内候选后关闭对比，访客没有代表图和批量择优入口', () => {
    useView.getState().openCompare('A', 'B', 'A');
    setSession({ kind: 'user', user: { id: 'editor', nickname: '客户', role: 'editor' } });
    const { queryByRole, rerender } = render(<CompareView order={order} byId={byId} groups={[{ key: 'A', ids: ['A', 'B'] }]} />);
    expect(queryByRole('button', { name: '将参考图设为代表图' })).toBeNull();
    rerender(<CompareView order={order} byId={byId} groups={[{ key: 'A', ids: ['A'] }]} />);
    expect(useView.getState().compare).toBeNull();
  });
});
