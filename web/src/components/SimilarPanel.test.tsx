import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SimilarPanel } from './SimilarPanel';
import { getJSON, putJSON } from '../lib/api';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { setSession } from '../store/session';
import { useSimilar } from '../store/similar';
import { useView } from '../store/view';

vi.mock('../lib/api', () => ({
  getSessionId: () => 'sid',
  getJSON: vi.fn(),
  postJSON: vi.fn(),
  putJSON: vi.fn(),
  openStream: vi.fn(),
  setSessionId: vi.fn(),
  setSessionGoneHandler: vi.fn(),
  withSid: (url: string) => url,
}));

const groupResult = {
  threshold: 8, dir: null, total: 4, analyzed: 4, skipped: 0, noPreview: 0, flat: 0,
  capped: false, durationMs: 42,
  groups: [{
    key: 'a', assetIds: ['a', 'b', 'c'], distances: { a: 0, b: 2, c: 5 }, maxDistance: 5,
  }],
};

const asset = (id: string) => ({
  id, dir: '', stem: id, raws: [`${id}.CR3`], jpg: `${id}.JPG`, jpgSize: 1, jpgMtimeMs: 1,
});

beforeEach(() => {
  vi.mocked(getJSON).mockResolvedValue(groupResult as never);
  vi.mocked(putJSON).mockImplementation((async (url: string, body: any) => (
    String(url).includes('/review') ? {} : { marks: body?.marks }
  )) as never);
  setSession({ kind: 'admin', user: null, share: null, online: [] });
  useLibrary.setState({ root: '/photos', assets: ['a', 'b', 'c', 'd'].map(asset), phase: 'ready' });
  useView.getState().reset();
  useMarks.getState().load({});
  useSimilar.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('默认保留组内第一张，选中别的照片后整组处理只算一步撤销', async () => {
  render(<SimilarPanel onClose={() => {}} />);
  await screen.findByText(/第 1 组/);

  expect(screen.getByRole('button', { name: /选 a 为保留图/ }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: /选 b 为保留图/ }));
  expect(screen.getByRole('button', { name: /选 b 为保留图/ }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: /选 a 为保留图/ }).getAttribute('aria-pressed')).toBe('false');

  fireEvent.click(screen.getByRole('button', { name: '保留并排除其余 2 张…' }));
  await screen.findByText(/已有摄影师最终决定仍然优先/);
  fireEvent.click(screen.getByRole('button', { name: '确认处理这一组' }));

  await waitFor(() => expect(useMarks.getState().marks).toEqual({ a: 'reject', b: 'pick', c: 'reject' }));
  expect(useMarks.getState().undoStack).toHaveLength(1);
  expect(screen.getByText('已处理')).toBeTruthy();
});

it('在大图中比较这组会清除筛选，把整组作为翻页序列打开', async () => {
  useView.getState().setTab('pick');
  const close = vi.fn();
  render(<SimilarPanel onClose={close} />);
  await screen.findByText(/第 1 组/);
  fireEvent.click(screen.getByRole('button', { name: /选 b 为保留图/ }));
  fireEvent.click(screen.getByRole('button', { name: '在大图中比较这组' }));

  const view = useView.getState();
  expect(close).toHaveBeenCalledOnce();
  expect(view.tab).toBe('all');
  expect(view.lightbox).toBe('b');
  expect(view.lightboxOrder).toEqual(['a', 'b', 'c']);
  expect(view.selection).toEqual(new Set(['b']));
});

it('改变相似程度后重新扫描，并把阈值带给服务端', async () => {
  render(<SimilarPanel onClose={() => {}} />);
  await screen.findByText(/第 1 组/);
  expect(vi.mocked(getJSON).mock.calls[0][0]).toContain('threshold=8');

  fireEvent.change(screen.getByLabelText('相似程度'), { target: { value: '12' } });
  fireEvent.click(screen.getByRole('button', { name: '重新扫描' }));
  await waitFor(() => expect(vi.mocked(getJSON).mock.calls.at(-1)![0]).toContain('threshold=12'));
});

it('没有相似照片时给出可执行的提示，并仍然可以调整阈值', async () => {
  vi.mocked(getJSON).mockResolvedValue({ ...groupResult, groups: [] } as never);
  render(<SimilarPanel onClose={() => {}} />);
  await screen.findByText(/没有找到相似照片/);
  expect(screen.getByLabelText('相似程度')).toBeTruthy();
  expect(screen.getByRole('button', { name: '重新扫描' })).toBeTruthy();
});

it('只读身份不能执行组内批量标记', async () => {
  setSession({ kind: 'user', user: { id: 'u_1', nickname: '客户', role: 'viewer' }, share: null, online: [] });
  render(<SimilarPanel onClose={() => {}} />);
  await screen.findByText(/第 1 组/);
  expect(screen.queryByRole('button', { name: /保留并排除其余/ })).toBeNull();
  expect(screen.getByText('只读模式，只能查看分组')).toBeTruthy();
});

it('扫描期间显示进度，并且只认本次扫描的进度帧', async () => {
  let resolve: (value: unknown) => void = () => {};
  vi.mocked(getJSON).mockImplementation((() => new Promise((done) => { resolve = done; })) as never);
  render(<SimilarPanel onClose={() => {}} />);
  await waitFor(() => expect(vi.mocked(getJSON)).toHaveBeenCalled());
  const url = String(vi.mocked(getJSON).mock.calls[0][0]);
  const scan = new URL(url, 'http://x').searchParams.get('scan')!;

  useSimilar.getState().setProgress({ scan: 'other', done: 1, total: 9, running: true, seq: 1 });
  expect(screen.queryByText(/1\/9/)).toBeNull();
  useSimilar.getState().setProgress({ scan, done: 3, total: 9, running: true, seq: 2 });
  expect(await screen.findByText(/3\/9/)).toBeTruthy();

  resolve(groupResult);
  await screen.findByText(/第 1 组/);
});
