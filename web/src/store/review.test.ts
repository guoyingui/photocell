import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReview } from './review';

const api = vi.hoisted(() => ({ sid: 'one', getJSON: vi.fn(), putJSON: vi.fn() }));
vi.mock('../lib/api', () => ({ getJSON: api.getJSON, putJSON: api.putJSON, getSessionId: () => api.sid }));
beforeEach(() => {
  useReview.getState().reset(); api.sid = 'one';
  api.getJSON.mockReset().mockResolvedValue({ reviewed: [] });
  api.putJSON.mockReset().mockResolvedValue({});
});
afterEach(() => { useReview.getState().reset(); vi.clearAllMocks(); });

describe('个人浏览进度保存', () => {
  it('重复查看不重复发请求，失败后可重新记录', async () => {
    await useReview.getState().activate('one', 'admin');
    api.putJSON.mockRejectedValueOnce(new Error('磁盘已满'));
    useReview.getState().setSeen(['A'], true); useReview.getState().setSeen(['A'], true);
    await vi.waitFor(() => expect(useReview.getState().error).toContain('磁盘已满'));
    expect(useReview.getState().reviewed.has('A')).toBe(false);
    expect(api.putJSON).toHaveBeenCalledTimes(1);
    useReview.getState().setSeen(['A'], true);
    await vi.waitFor(() => expect(useReview.getState().error).toBeNull());
    expect(useReview.getState().reviewed.has('A')).toBe(true);
  });
  it('快速切换已看/未看，两次都失败时回到服务端原有状态', async () => {
    await useReview.getState().activate('one', 'admin');
    api.putJSON.mockRejectedValue(new Error('离线'));
    useReview.getState().setSeen(['A'], true); useReview.getState().setSeen(['A'], false);
    await vi.waitFor(() => expect(api.putJSON).toHaveBeenCalledTimes(2));
    expect(useReview.getState().reviewed.has('A')).toBe(false);
  });
  it('旧目录的延迟读取不能覆盖新目录，旧队列不能写入新会话', async () => {
    let resolve!: (value: unknown) => void;
    api.getJSON.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const old = useReview.getState().activate('one', 'admin');
    api.sid = 'two'; api.getJSON.mockResolvedValueOnce({ reviewed: ['B'] });
    await useReview.getState().activate('two', 'admin');
    resolve({ reviewed: ['A'] }); await old;
    expect([...useReview.getState().reviewed]).toEqual(['B']);
    useReview.getState().setSeen(['C'], true);
    api.sid = 'three'; useReview.getState().reset();
    await Promise.resolve();
    expect(api.putJSON).not.toHaveBeenCalled();
  });
});
