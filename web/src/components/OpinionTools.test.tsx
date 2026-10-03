import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpinionTools } from './OpinionTools';
import { usePhotoFilterGroups } from '../lib/usePhotoFilters';
import { handleRealtimeEvent, resetRealtime } from '../lib/realtime';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { setSession } from '../store/session';
import { useView } from '../store/view';
import { summarizeOpinions } from '../../../shared/opinions.js';
import type { Asset } from '../types';

const api = vi.hoisted(() => ({ putJSON: vi.fn(), getJSON: vi.fn(), sid: 'sid' }));
vi.mock('../lib/api', () => ({ ...api, getSessionId: () => api.sid, setSessionGoneHandler: vi.fn() }));
const assets: Asset[] = ['A', 'B', 'C'].map((id) => ({ id, stem: id, dir: '', raws: [id + '.CR3'], jpg: null, jpgSize: 0, jpgMtimeMs: 0 }));
const vote = (mark: 'pick' | 'reject') => ({ mark, at: 1 });
const contrib = { A: { alice: vote('pick'), bob: vote('pick') },
  B: { alice: vote('pick'), bob: vote('pick'), carol: vote('reject') }, C: { admin: vote('pick') } };
function Harness() {
  const groups = usePhotoFilterGroups(assets.map((asset) => ({ key: asset.id, ids: [asset.id] })));
  return <><OpinionTools order={groups.flatMap((group) => group.ids)} /><output>{groups.map((group) => group.key).join(',')}</output></>;
}
beforeEach(() => {
  useView.getState().reset(); resetRealtime(); api.putJSON.mockReset(); api.sid = 'sid';
  setSession({ kind: 'admin', user: null });
  useMarks.getState().load({ A: 'pick', B: 'reject', C: 'pick' }, undefined, [], contrib);
  useLibrary.setState({ assets, metas: new Map() });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('多人意见与最终决定', () => {
  it('清除最终决定后，旧的 SSE 和断线补拉不会重新恢复已清除的决定', () => {
    handleRealtimeEvent({ type: 'final-marks', finalRevision: 2, finalMarks: {}, changes: { A: { mark: null } }, hidden: [] });
    handleRealtimeEvent({ type: 'final-marks', finalRevision: 1, finalMarks: { A: { mark: 'pick', at: 1 } }, changes: { A: { mark: 'pick' } }, hidden: ['B'] });
    useMarks.getState().reconcile({ A: 'pick' }, {}, {}, { A: { mark: 'pick', at: 1 } }, 1);
    expect(useMarks.getState().finalMarks).toEqual({}); expect(useMarks.getState().marks.A).toBeUndefined();
    expect(useMarks.getState().hidden.has('B')).toBe(false);
  });
  it('共同收藏不把未表态算赞同，多人收藏可同时有争议，并排除摄影师一票', () => {
    expect(summarizeOpinions(contrib.C).picks).toBe(0);
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '共同收藏 1' }));
    expect(container.querySelector('output')?.textContent).toBe('A');
    fireEvent.click(screen.getByRole('button', { name: '收藏与排除有争议 1' }));
    expect(container.querySelector('output')?.textContent).toBe('B');
    fireEvent.click(screen.getByRole('button', { name: '至少两人收藏 2' }));
    expect(container.querySelector('output')?.textContent).toBe('A,B');
  });
  it('确认最终名单只使用仍可见的选区，保留每位客户的原始意见', async () => {
    api.putJSON.mockResolvedValue({ finalMarks: { B: { mark: 'pick', at: 5 } }, marks: { A: 'pick', B: 'pick', C: 'pick' }, marksMeta: {}, contrib });
    useView.setState({ selection: new Set(['B', 'gone']) });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '选区确认为最终收藏' }));
    await vi.waitFor(() => expect(useMarks.getState().finalMarks.B?.mark).toBe('pick'));
    expect(api.putJSON).toHaveBeenCalledWith('/api/library/final-marks', { marks: { B: 'pick' } });
    expect(useMarks.getState().contrib.B?.carol?.mark).toBe('reject');
  });
  it('取消他人的一票后，实时汇总不会残留争议或把有效标记误记为那个人的票', () => {
    handleRealtimeEvent({ type: 'marks', origin: 'carol', changes: { B: { mark: 'pick', by: 'bob', at: 2 } },
      contribChanges: { B: { by: 'carol', mark: null, at: 3 } } });
    expect(summarizeOpinions(useMarks.getState().contrib.B).conflict).toBe(false);
    expect(summarizeOpinions(useMarks.getState().contrib.B).picks).toBe(2);
  });
  it('标记请求失败回滚时，期间收到的最终决定仍然保留', async () => {
    let reject!: (reason: Error) => void;
    api.putJSON.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    useMarks.getState().setMark(['A'], 'reject');
    act(() => handleRealtimeEvent({ type: 'final-marks', finalMarks: { A: { mark: 'pick', at: 10 } },
      changes: { A: { mark: 'pick', by: 'admin', at: 10 } }, hidden: [] }));
    reject(new Error('磁盘不可写'));
    await vi.waitFor(() => expect(useMarks.getState().error).toContain('磁盘不可写'));
    expect(useMarks.getState().marks.A).toBe('pick');
    expect(useMarks.getState().marksMeta.A.at).toBe(10);
  });
});
