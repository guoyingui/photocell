import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotoTools } from './PhotoTools';
import { PhotoInfo } from './PhotoInfo';
import { usePhotoFilterGroups } from '../lib/usePhotoFilters';
import { useView } from '../store/view';
import { useLibrary } from '../store/library';
import { useReview } from '../store/review';
import { useMarks } from '../store/marks';
import type { Asset, AssetMeta } from '../types';
import { matchesPhoto } from '../lib/photoFilters';

vi.mock('../lib/api', () => ({ putJSON: vi.fn(async () => ({})), getJSON: vi.fn(),
  setSessionGoneHandler: vi.fn(), getSessionId: () => null }));
const assets: Asset[] = ['A', 'B', 'C'].map((id) => ({ id, stem: `IMG_${id}`, dir: 'day2',
  raws: [`IMG_${id}.CR3`], jpg: `IMG_${id}.JPG`, jpgMtimeMs: 1, jpgSize: 1 }));
const meta = (id: string, iso: number | null): AssetMeta => ({ id, iso, fNumber: 2.8, exposureTime: 1 / 125,
  focalLength: 50, time: 1, timeSource: 'exif', orientation: 1, body: 'camera' });
const groups = [{ key: 'A', ids: ['A', 'B', 'C'] }];
function Harness() {
  const filtered = usePhotoFilterGroups(groups);
  return <><PhotoTools groups={filtered} order={filtered.flatMap((group) => group.ids)} />
    <output>{filtered.flatMap((group) => group.ids).join(',')}</output></>;
}
beforeEach(() => {
  useView.getState().reset(); useMarks.getState().load({}); useReview.getState().reset();
  useReview.setState({ ready: true, reviewed: new Set(['A', 'B']) });
  useLibrary.setState({ assets, metas: new Map([['A', meta('A', 100)], ['B', meta('B', 800)], ['C', meta('C', null)]]), metaDone: true });
});
afterEach(() => { cleanup(); useReview.getState().reset(); vi.clearAllMocks(); });

describe('照片搜索、参数和浏览状态', () => {
  it('文件名搜索忽略大小写，可含路径和扩展名；定位展开连拍并只选一张', () => {
    const { container } = render(<Harness />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'DAY2/img_b.jpg' } });
    expect(container.querySelector('output')?.textContent).toBe('B');
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
    expect(useView.getState().cursor).toBe('B');
    expect([...useView.getState().selection]).toEqual(['B']);
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(container.querySelector('output')?.textContent).toBe('A,B,C');
    fireEvent.click(screen.getByRole('button', { name: '定位下一张' }));
    expect(useView.getState().expanded.has('A')).toBe(true);
  });
  it('参数筛选组合生效，并保留原连拍组的 key；未知数据可单独筛出', () => {
    const { container } = render(<Harness />);
    fireEvent.change(screen.getByLabelText('ISO'), { target: { value: '800' } });
    expect(container.querySelector('output')?.textContent).toBe('B');
    fireEvent.change(screen.getByLabelText('ISO'), { target: { value: 'missing' } });
    expect(container.querySelector('output')?.textContent).toBe('C');
    expect(matchesPhoto(assets[2], undefined, { ...useView.getState().photoFilters, fNumber: '2.8' })).toBe(false);
  });
  it('已看与标记独立，未看视图保留查看中的照片直到退出大图', () => {
    useMarks.getState().load({ A: 'pick' });
    const { container } = render(<Harness />);
    fireEvent.change(screen.getByLabelText('浏览状态'), { target: { value: 'undecided' } });
    expect(container.querySelector('output')?.textContent).toBe('B');
    fireEvent.change(screen.getByLabelText('浏览状态'), { target: { value: 'unseen' } });
    expect(container.querySelector('output')?.textContent).toBe('C');
    act(() => { useView.getState().openLightbox('C'); useReview.setState({ reviewed: new Set(['A', 'B', 'C']) }); });
    expect(container.querySelector('output')?.textContent).toBe('C');
    act(() => useView.getState().closeLightbox());
    expect(container.querySelector('output')?.textContent).toBe('');
  });
  it('信息面板显示格式化参数和相对目录，不伪造缺失数据', () => {
    useView.getState().toggleInfo();
    render(<PhotoInfo id="A" />);
    expect(screen.getByText('f/2.8')).toBeTruthy(); expect(screen.getByText('1/125 s')).toBeTruthy();
    expect(screen.getByText('50 mm')).toBeTruthy(); expect(screen.getByText('day2')).toBeTruthy();
    act(() => useLibrary.setState({ metas: new Map([['A', { ...meta('A', 100), exposureTime: 0.6 }]]) }));
    expect(screen.getByText('0.6 s')).toBeTruthy();
    act(() => useLibrary.setState({ metas: new Map() }));
    expect(screen.getAllByText('未知').length).toBeGreaterThan(0);
  });
});
