import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useMarks } from './marks';
import { setSession } from './session';
import { putJSON } from '../lib/api';

vi.mock('../lib/api', () => ({ putJSON: vi.fn(() => Promise.resolve({})) }));
const state = () => useMarks.getState();
beforeEach(() => {
  vi.mocked(putJSON).mockReset().mockResolvedValue({});
  setSession({ kind: 'admin', user: null }); state().load({});
});
afterEach(() => vi.clearAllMocks());

describe('标记撤销与重做', () => {
  it('批量操作逐步撤销、重做，新操作清空重做分支', () => {
    state().setMark(['A', 'B'], 'pick'); state().setMark(['A'], 'reject');
    state().undo(); state().undo();
    expect(state().marks).toEqual({});
    state().redo(); expect(state().marks).toEqual({ A: 'pick', B: 'pick' });
    state().redo(); expect(state().marks).toEqual({ A: 'reject', B: 'pick' });
    state().undo(); state().setMark(['C'], 'pick');
    expect(state().redoStack).toEqual([]);
  });
  it('重做失败回滚并保留重试机会', async () => {
    state().setMark(['A'], 'pick'); state().undo();
    await vi.waitFor(() => expect(putJSON).toHaveBeenCalledTimes(2));
    vi.mocked(putJSON).mockRejectedValueOnce(new Error('连接中断'));
    state().redo();
    await vi.waitFor(() => expect(state().error).toContain('连接中断'));
    expect(state().marks).toEqual({});
    expect(state().redoStack).toHaveLength(1);
    state().redo();
    expect(state().marks).toEqual({ A: 'pick' });
  });
  it('切库后的迟到失败不改变新库数据和历史', async () => {
    let reject!: (error: Error) => void;
    vi.mocked(putJSON).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    state().setMark(['A'], 'pick'); state().load({ B: 'pick' });
    reject(new Error('旧库失败')); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state().marks).toEqual({ B: 'pick' });
    expect(state().error).toBeNull(); expect(state().redoStack).toEqual([]);
  });
  it('撤销恢复自己的意见，不复制别人的最终标记', () => {
    state().load({ A: 'reject' }, { A: { by: 'guest', at: 2 } }, [], {
      A: { admin: { mark: 'pick', at: 1 }, guest: { mark: 'reject', at: 2 } },
    });
    state().setMark(['A'], 'reject'); state().undo();
    expect(putJSON).toHaveBeenLastCalledWith('/api/library/marks', { marks: { A: 'pick' } });
    expect(state().contrib.A?.guest.mark).toBe('reject');
  });
});
