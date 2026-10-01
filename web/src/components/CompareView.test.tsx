import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompareView } from './CompareView';
import { useView } from '../store/view';
import { useMarks } from '../store/marks';
import { setSession } from '../store/session';
import { useKeyboard } from '../lib/useKeyboard';
import type { Asset } from '../types';

vi.mock('../lib/api', () => ({ putJSON: vi.fn(() => Promise.resolve({})), withSid: (url: string) => url }));
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
