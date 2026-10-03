import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FilterWorkspace } from './FilterWorkspace';
import { PhotoTools } from './PhotoTools';
import { OpinionTools } from './OpinionTools';
import { AnnotationTools } from './AnnotationTools';
import { usePhotoFilterGroups } from '../lib/usePhotoFilters';
import { useSortedGroups } from '../lib/useSortedGroups';
import { useVisiblePhotos } from '../lib/useVisiblePhotos';
import { useKeyboard } from '../lib/useKeyboard';
import { emptyFilters } from '../lib/filterState';
import { savePreset } from '../lib/filterPresets';
import { useView } from '../store/view';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { useReview } from '../store/review';
import { useWorkspace } from '../store/workspace';
import { useAnnotations } from '../store/annotations';
import { setSession } from '../store/session';

vi.mock('../lib/api', () => ({ getSessionId: () => 'sid', getJSON: vi.fn(), putJSON: vi.fn(async () => ({})), setSessionGoneHandler: vi.fn() }));
const groups = [{ key: 'IMG_10', ids: ['IMG_10'] }, { key: 'IMG_2', ids: ['IMG_2'] }];
function Harness() {
  const sorted = useSortedGroups(usePhotoFilterGroups(groups));
  const order = sorted.flatMap((group) => group.ids);
  useVisiblePhotos(order, true); useKeyboard(order);
  return <><FilterWorkspace /><PhotoTools groups={sorted} order={order} /><OpinionTools order={order} /><AnnotationTools order={order} />
    <output>{order.join(',')}</output></>;
}
beforeEach(() => {
  localStorage.clear(); useView.getState().reset(); useMarks.getState().load({}); useReview.getState().reset(); useAnnotations.getState().reset();
  useWorkspace.setState({ sort: 'time-asc', collapsed: { capture: false, opinions: false, annotations: false }, storageError: '' });
  setSession({ kind: 'admin', user: null, roster: [], online: [], selectionLocked: false });
  useReview.setState({ ready: true });
  useLibrary.setState({ root: '/test/photos', assets: ['IMG_10', 'IMG_2'].map((id) => ({ id, stem: id, dir: '', raws: [], jpg: id + '.JPG', jpgSize: 1, jpgMtimeMs: 1 })),
    metas: new Map(['IMG_10', 'IMG_2'].map((id) => [id, { id, time: 1, timeSource: 'exif', orientation: 1, body: 'camera', iso: 800, fNumber: 2.8, exposureTime: 1 / 125, focalLength: 50 }])) });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); useReview.getState().reset(); });

it('折叠筛选不丢条件，可从常驻标签单独清除，变更后清空旧选区与预览', () => {
  render(<Harness />);
  fireEvent.change(screen.getByLabelText('ISO'), { target: { value: '800' } });
  fireEvent.click(screen.getByRole('button', { name: '拍摄参数' }));
  expect(screen.queryByRole('combobox', { name: 'ISO' })).toBeNull();
  expect(useView.getState().photoFilters.iso).toBe('800');
  act(() => useView.getState().openLightbox('IMG_2'));
  fireEvent.click(screen.getByRole('button', { name: '清除筛选 ISO：800' }));
  expect(useView.getState().photoFilters.iso).toBe(''); expect(useView.getState().lightbox).toBeNull(); expect(useView.getState().selection.size).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: '客户意见' }));
  expect(screen.queryByRole('group', { name: '客户意见筛选' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '后期筛选' }));
  expect(screen.queryByRole('combobox', { name: '阶段' })).toBeNull();
});
it('排序改变照片与键盘浏览顺序，文件名清单为空时不会退回全库', () => {
  const { container } = render(<Harness />);
  fireEvent.change(screen.getByLabelText('排序'), { target: { value: 'name-asc' } });
  expect(container.querySelector('output')?.textContent).toBe('IMG_2,IMG_10');
  fireEvent.keyDown(window, { key: 'ArrowRight' }); expect(useView.getState().cursor).toBe('IMG_2');
  fireEvent.keyDown(window, { key: 'ArrowRight' }); expect(useView.getState().cursor).toBe('IMG_10');
  act(() => useView.getState().applyFilters({ ...emptyFilters(), matchedIds: [] }));
  expect(container.querySelector('output')?.textContent).toBe('');
  fireEvent.click(screen.getByRole('button', { name: '清除筛选 文件名清单：0 个目标' }));
  expect(container.querySelector('output')?.textContent).toBe('IMG_2,IMG_10');
});
it('保存并重新打开预设可以恢复筛选与排序，预设不带回旧选区', () => {
  render(<Harness />);
  fireEvent.change(screen.getByLabelText('浏览状态'), { target: { value: 'unseen' } });
  fireEvent.change(screen.getByLabelText('排序'), { target: { value: 'name-desc' } });
  fireEvent.click(screen.getByRole('button', { name: '筛选预设…' }));
  fireEvent.change(screen.getByLabelText('预设名称'), { target: { value: '未看倒序' } });
  fireEvent.click(screen.getByRole('button', { name: '保存当前条件' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' }));
  fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
  fireEvent.change(screen.getByLabelText('排序'), { target: { value: 'time-asc' } });
  act(() => useView.getState().setCursor('IMG_2'));
  fireEvent.click(screen.getByRole('button', { name: '筛选预设…' }));
  fireEvent.click(screen.getByRole('button', { name: '应用预设 未看倒序' }));
  expect(useView.getState().reviewFilter).toBe('unseen'); expect(useWorkspace.getState().sort).toBe('name-desc');
  expect(useView.getState().selection.size).toBe(0); expect(screen.queryByRole('dialog')).toBeNull();
});
it('只读访客可管理自己的预设，不看到摄影师预设或客户意见面板开关', () => {
  savePreset('admin:/test/photos', '摄影师私有预设', emptyFilters(), 'time-asc');
  setSession({ kind: 'user', user: { id: 'alice', nickname: '客户', role: 'viewer' } });
  render(<FilterWorkspace />);
  expect(screen.queryByRole('button', { name: '客户意见' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '筛选预设…' }));
  expect(screen.queryByText('摄影师私有预设')).toBeNull();
  fireEvent.change(screen.getByLabelText('预设名称'), { target: { value: '我的条件' } });
  fireEvent.click(screen.getByRole('button', { name: '保存当前条件' }));
  expect(screen.getByRole('button', { name: '应用预设 我的条件' })).toBeTruthy();
});
