import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AnnotationTools } from './AnnotationTools';
import { usePhotoFilterAssets } from '../lib/usePhotoFilters';
import { useAnnotations } from '../store/annotations';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { setSession } from '../store/session';
import { useView } from '../store/view';

const api = vi.hoisted(() => ({ getJSON: vi.fn(), putJSON: vi.fn(), postBlob: vi.fn(), sid: 'sid' }));
vi.mock('../lib/api', () => ({ ...api, getSessionId: () => api.sid, setSessionGoneHandler: vi.fn() }));
function Harness() { const assets = usePhotoFilterAssets(); return <><AnnotationTools order={assets.map((asset) => asset.id)} /><output>{assets.map((asset) => asset.id).join(',')}</output></>; }
beforeEach(() => {
  api.sid = 'sid'; api.putJSON.mockReset(); useView.getState().reset(); useMarks.getState().load({}); useAnnotations.getState().reset();
  setSession({ kind: 'admin', user: null });
  useLibrary.setState({ assets: ['A', 'B'].map((id) => ({ id, stem: id, dir: '', raws: [id + '.NEF'], jpg: null, jpgSize: 0, jpgMtimeMs: 0 })), metas: new Map() });
  useAnnotations.setState({ sid: 'sid', ready: true, revision: 1, annotations: { A: { rating: 4, label: 'green', stage: 'retouch', keywords: ['人像'] } } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('后期筛选组合生效，筛选变化清除旧光标与选区', () => {
  useView.setState({ cursor: 'B', selection: new Set(['B']) });
  const { container } = render(<Harness />);
  fireEvent.change(screen.getByLabelText('至少'), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText('阶段'), { target: { value: 'retouch' } });
  expect(container.querySelector('output')?.textContent).toBe('A'); expect(useView.getState().cursor).toBeNull(); expect(useView.getState().selection.size).toBe(0);
  fireEvent.change(screen.getByLabelText('关键词筛选'), { target: { value: '风景' } });
  expect(container.querySelector('output')?.textContent).toBe('');
});
it('批量只改仍可见的选区与指定字段，失败保留编辑内容可重试', async () => {
  useView.setState({ selection: new Set(['A', 'missing']) }); api.putJSON.mockRejectedValue(new Error('磁盘只读'));
  render(<Harness />); fireEvent.click(screen.getByRole('button', { name: '批量后期信息（1）' }));
  fireEvent.change(screen.getByLabelText('后期阶段'), { target: { value: 'delivery' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await vi.waitFor(() => expect(api.putJSON).toHaveBeenCalledWith('/api/library/annotations', { ids: ['A'], patch: { stage: 'delivery' } }));
  await vi.waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('磁盘只读'));
  expect((screen.getByLabelText('后期阶段') as HTMLSelectElement).value).toBe('delivery');
});
it('旧库返回和旧版本 SSE 不会覆盖新库的后期信息；访客没有写入入口', async () => {
  let finish!: (data: unknown) => void;
  api.getJSON.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const loading = useAnnotations.getState().reload();
  api.sid = 'new'; useAnnotations.getState().reset(); useAnnotations.setState({ sid: 'new', revision: 3, ready: true });
  await act(async () => { finish({ revision: 9, annotations: { A: { rating: 5 } } }); await loading; });
  expect(useAnnotations.getState().annotations).toEqual({});
  useAnnotations.getState().remote({ revision: 2, annotations: {} }); expect(useAnnotations.getState().revision).toBe(3);
  setSession({ kind: 'user', user: { id: 'u', nickname: '客户', role: 'editor' } });
  render(<Harness />); expect(screen.queryByRole('button', { name: /批量后期信息|导出 XMP/ })).toBeNull();
});
