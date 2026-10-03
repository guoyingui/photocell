import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  handleRealtimeEvent, createReconnectRefetch, refetchMarks,
  blockerPropsFor, resetRealtime, useRealtime,
} from './realtime';
import { useMarks } from '../store/marks';
import { setSession, useSession } from '../store/session';

// realtime.ts 只用 lib/api 的 getJSON；marks.ts 用同一个模块的 putJSON。
// 两者都要能由测试控制，所以整个模块替身化（与 GuestApp.test.tsx 同一套约定）。
const apiMock = vi.hoisted(() => ({
  getJSON: vi.fn(),
  putJSON: vi.fn(),
}));

vi.mock('./api', () => ({
  getJSON: apiMock.getJSON,
  putJSON: apiMock.putJSON,
  postJSON: vi.fn(),
  openStream: vi.fn(() => () => {}),
  withSid: (u: string) => u,
  setSessionId: vi.fn(),
  getSessionId: vi.fn(() => null),
  setSessionGoneHandler: vi.fn(),
}));

const flush = () => new Promise((r) => setTimeout(r, 10));
const marks = () => useMarks.getState().marks;

/** 把 PUT 挂起，模拟「本地写请求还没落地」。 */
function deferredPut() {
  const pending: ((v: unknown) => void)[] = [];
  apiMock.putJSON.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
  return { settle() { for (const r of pending.splice(0)) r({ ok: true }); } };
}

beforeEach(() => {
  apiMock.getJSON.mockReset();
  apiMock.putJSON.mockReset().mockResolvedValue({ ok: true });
  resetRealtime();
  useMarks.getState().load({});
  setSession({ kind: 'none', user: null, share: null, online: [] });
});

afterEach(() => {
  resetRealtime();
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 规则 1：origin === 自己的广播一律忽略
// ─────────────────────────────────────────────────────────────────────────────

describe('规则 1 —— 忽略自己发出的回声', () => {
  it('同一客户其他页面的意见变更可同步，最终决定和其他成员的意见仍然分开', async () => {
    setSession({ kind: 'user', user: { id: 'u_me', nickname: '我', role: 'editor' } });
    useMarks.getState().load({ A: 'pick' }, {}, [], undefined, { A: { mark: 'pick', at: 1 } }, 1, {});
    handleRealtimeEvent({ type: 'marks', origin: 'u_me', changes: {},
      ownContribChanges: { A: { mark: 'reject', at: 2 } } });
    expect(useMarks.getState().contrib.A).toEqual({ u_me: { mark: 'reject', at: 2 } });
    expect(marks().A).toBe('pick');
    apiMock.getJSON.mockResolvedValue({ marks: { A: 'pick' }, finalMarks: { A: { mark: 'pick', at: 1 } },
      finalRevision: 1, ownContrib: { A: { mark: 'reject', at: 2 } }, hidden: [] });
    await refetchMarks();
    useMarks.getState().setMark(['A'], 'pick'); await flush();
    useMarks.getState().undo();
    expect(apiMock.putJSON).toHaveBeenLastCalledWith('/api/library/marks', { marks: { A: 'reject' } });
    await flush();
  });
  function broadcast(origin: string, id: string, mark: string | null) {
    return { type: 'marks', origin, seq: 1, changes: { [id]: { mark, by: origin, at: 1 } } };
  }

  it('访客忽略 origin === 自己 userId 的广播', () => {
    setSession({ kind: 'user', user: { id: 'u_me', nickname: '我', role: 'editor' } });
    useMarks.getState().load({ a: 'pick' });

    // 回声里带的是服务端已经确认的值，但本地早就乐观更新过了；广播和自己那次
    // PUT 的响应之间没有顺序保证，让回声有发言权就是给「按下 P 之后闪一下」开一扇窗。
    handleRealtimeEvent(broadcast('u_me', 'a', 'reject'));

    expect(marks().a).toBe('pick');
  });

  it('本机摄影师忽略 origin === "admin" 的广播（他的 origin 就是 admin）', () => {
    setSession({ kind: 'admin', user: null });
    useMarks.getState().load({ a: 'pick' });

    handleRealtimeEvent(broadcast('admin', 'a', 'reject'));

    expect(marks().a).toBe('pick');
  });

  // 对照组：证明上面两条不是因为整个合并链路都断了。
  it('别人发出的广播照常应用（对照组）', () => {
    setSession({ kind: 'user', user: { id: 'u_me', nickname: '我', role: 'editor' } });
    useMarks.getState().load({ a: 'pick' });

    handleRealtimeEvent(broadcast('u_other', 'a', 'reject'));

    expect(marks().a).toBe('reject');
  });

  it('管理员的广播对访客来说是别人的广播', () => {
    setSession({ kind: 'user', user: { id: 'u_me', nickname: '我', role: 'editor' } });
    handleRealtimeEvent(broadcast('admin', 'a', 'pick'));
    expect(marks().a).toBe('pick');
  });

  it('mark 为 null 表示别人清除了标记', () => {
    setSession({ kind: 'user', user: { id: 'u_me', nickname: '我', role: 'editor' } });
    useMarks.getState().load({ a: 'pick' });
    handleRealtimeEvent(broadcast('u_other', 'a', null));
    expect(marks()).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 规则 2 在 store/marks.test.ts 上有完整覆盖，这里只钉住「事件路由确实走到了
// 那条规则上」——否则 realtime.ts 可以绕过 applyRemote 直接 set 而没人发现。
// ─────────────────────────────────────────────────────────────────────────────

describe('规则 2 —— 广播经过未落地写的丢弃规则', () => {
  it('本地有未落地写时，该 id 的广播被丢弃；同一批里别的 id 照常应用', async () => {
    setSession({ kind: 'user', user: { id: 'u_me', nickname: '我', role: 'editor' } });
    const put = deferredPut();
    useMarks.getState().setMark(['a'], 'pick');

    handleRealtimeEvent({
      type: 'marks', origin: 'u_other', seq: 3,
      changes: { a: { mark: 'reject', by: 'u_other', at: 1 }, b: { mark: 'pick', by: 'u_other', at: 1 } },
    });

    expect(marks()).toEqual({ a: 'pick', b: 'pick' });
    put.settle();
    await flush();
    expect(marks()).toEqual({ a: 'pick', b: 'pick' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 20：广播里的 by/at 是角标的唯一数据来源，必须一路送到 marks store，
// 而且必须**经过** applyRemote —— 绕过它就等于绕过规则 2，界面上会出现
// 「标记是我的、角标显示成别人的」。
// ─────────────────────────────────────────────────────────────────────────────

describe('归属（marksMeta）的接线（Task 20）', () => {
  const metaOf = (id: string) => useMarks.getState().marksMeta[id];

  it('广播里的 by / at 落进归属表', () => {
    setSession({ kind: 'user', user: { id: 'u_me', nickname: '我', role: 'editor' } });
    handleRealtimeEvent({
      type: 'marks', origin: 'u_other', seq: 1,
      changes: { a: { mark: 'pick', by: 'u_other', at: 1700 } },
    });
    expect(metaOf('a')).toEqual({ by: 'u_other', at: 1700 });
  });

  it('广播缺 by / at 时不写归属，也不抛异常', () => {
    setSession({ kind: 'user', user: { id: 'u_me', nickname: '我', role: 'editor' } });
    expect(() => handleRealtimeEvent({
      type: 'marks', origin: 'u_other', seq: 1, changes: { a: { mark: 'pick' } },
    })).not.toThrow();
    expect(marks().a).toBe('pick');
    expect(metaOf('a')).toBeUndefined();
  });

  it('归属也走 applyRemote 的未落地写保护，不会盖成上一个人', async () => {
    setSession({ kind: 'user', user: { id: 'u_me', nickname: '我', role: 'editor' } });
    const put = deferredPut();
    useMarks.getState().setMark(['a'], 'pick');       // 本地乐观更新：这是我的

    handleRealtimeEvent({
      type: 'marks', origin: 'u_other', seq: 3,
      changes: { a: { mark: 'reject', by: 'u_other', at: 5 } },
    });

    expect(marks().a).toBe('pick');
    expect(metaOf('a')?.by).toBe('u_me');
    put.settle();
    await flush();
    expect(metaOf('a')?.by).toBe('u_me');
  });

  it('全量补拉时归属跟着一起收敛', async () => {
    apiMock.getJSON.mockResolvedValue({
      marks: { a: 'reject' }, marksMeta: { a: { by: 'u_1', at: 42 } }, settings: {},
    });
    useMarks.getState().load({ a: 'pick' }, { a: { by: 'u_stale', at: 1 } });

    await refetchMarks();

    expect(metaOf('a')).toEqual({ by: 'u_1', at: 42 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 规则 3：重连之后必须全量补拉
// ─────────────────────────────────────────────────────────────────────────────

describe('规则 3 —— 重连后的全量补拉', () => {
  beforeEach(() => {
    apiMock.getJSON.mockResolvedValue({ marks: { a: 'reject', b: 'pick' }, settings: {} });
  });

  it('第一次建立连接不补拉（数据刚随初始化拉过）', async () => {
    const onOpen = createReconnectRefetch();
    onOpen();
    await flush();
    expect(apiMock.getJSON).not.toHaveBeenCalled();
  });

  it('断开后重连成功会全量拉一次 marks，状态随之收敛', async () => {
    useMarks.getState().load({ a: 'pick' });      // 断开前我这边看到的
    const onOpen = createReconnectRefetch();
    onOpen();                                     // 首次连上
    // …连接断了。EventSource 自己重连，期间别人把 a 改成 reject 并标了 b。
    onOpen();                                     // 重连成功
    await flush();

    // SSE 只推增量，断开期间的改动不会补发；不补拉就会一直显示 a=pick。
    expect(apiMock.getJSON).toHaveBeenCalledWith('/api/library/marks');
    expect(marks()).toEqual({ a: 'reject', b: 'pick' });
  });

  it('每一次重连都补拉，不是只补第一次', async () => {
    const onOpen = createReconnectRefetch();
    onOpen();
    onOpen();
    onOpen();
    await flush();
    expect(apiMock.getJSON).toHaveBeenCalledTimes(2);
  });

  it('补拉不覆盖本地未落地的写', async () => {
    const put = deferredPut();
    useMarks.getState().setMark(['a'], 'pick');   // 还没落地，服务端快照里必然没有它
    const onOpen = createReconnectRefetch();
    onOpen();
    onOpen();
    await flush();

    expect(marks().a).toBe('pick');
    expect(marks().b).toBe('pick');
    put.settle();
    await flush();
    expect(marks().a).toBe('pick');
  });

  it('补拉失败不制造新的错误提示，也不清空已有标记', async () => {
    useMarks.getState().load({ a: 'pick' });
    apiMock.getJSON.mockRejectedValue(new Error('boom'));
    const onOpen = createReconnectRefetch();
    onOpen();
    onOpen();
    await flush();

    expect(marks()).toEqual({ a: 'pick' });
    expect(useMarks.getState().error).toBeNull();
  });

  it('已经被阻断（kicked / share-ended）之后不再补拉', async () => {
    handleRealtimeEvent({ type: 'kicked', reason: 'disabled' });
    await refetchMarks();
    expect(apiMock.getJSON).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 在线名单与角色
// ─────────────────────────────────────────────────────────────────────────────

describe('presence / role', () => {
  it('presence 事件整份替换在线名单', () => {
    handleRealtimeEvent({
      type: 'presence',
      users: [
        { id: 'admin', nickname: '摄影师', role: 'admin' },
        { id: 'u_1', nickname: '新娘小林', role: 'editor' },
      ],
    });
    expect(useSession.getState().online.map((u) => u.id)).toEqual(['admin', 'u_1']);
  });

  it('resetRealtime 清空在线名单——流没了，名单就不该还挂着一屏早已不在的人', () => {
    handleRealtimeEvent({ type: 'presence', users: [{ id: 'u_1', nickname: '甲', role: 'editor' }] });
    resetRealtime();
    expect(useSession.getState().online).toEqual([]);
  });

  it('presence 的 users 缺失时按空名单处理，不炸', () => {
    setSession({ online: [{ id: 'u_1', nickname: '甲', role: 'editor' }] });
    handleRealtimeEvent({ type: 'presence' });
    expect(useSession.getState().online).toEqual([]);
  });

  it('role 事件改的是自己时，写权限立刻收紧', () => {
    setSession({ kind: 'user', user: { id: 'u_me', nickname: '我', role: 'editor' } });
    expect(useSession.getState().canWrite()).toBe(true);

    handleRealtimeEvent({ type: 'role', userId: 'u_me', role: 'viewer' });

    expect(useSession.getState().user?.role).toBe('viewer');
    expect(useSession.getState().canWrite()).toBe(false);
  });

  it('role 事件改的是别人时，不动自己的角色', () => {
    setSession({ kind: 'user', user: { id: 'u_me', nickname: '我', role: 'editor' } });
    handleRealtimeEvent({ type: 'role', userId: 'u_other', role: 'viewer' });
    expect(useSession.getState().user?.role).toBe('editor');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 阻断
// ─────────────────────────────────────────────────────────────────────────────

describe('kicked / share-ended 的阻断状态', () => {
  it('kicked 置阻断状态', () => {
    handleRealtimeEvent({ type: 'kicked', reason: 'disabled' });
    expect(useRealtime.getState().blocked).toEqual({ kind: 'kicked', reason: 'disabled' });
  });

  it('share-ended 置阻断状态', () => {
    handleRealtimeEvent({ type: 'share-ended', reason: 'expired' });
    expect(useRealtime.getState().blocked).toEqual({ kind: 'share-ended', reason: 'expired' });
  });

  it('两种阻断的文案不同——「你被单独移出」和「这场选片结束了」是两件事', () => {
    const kicked = blockerPropsFor({ kind: 'kicked', reason: 'disabled' });
    const ended = blockerPropsFor({ kind: 'share-ended', reason: 'revoked' });
    expect(kicked.title).not.toBe(ended.title);
    expect(kicked.message).not.toBe(ended.message);
  });

  it('禁用与删除给出不同的说法', () => {
    expect(blockerPropsFor({ kind: 'kicked', reason: 'disabled' }).message)
      .not.toBe(blockerPropsFor({ kind: 'kicked', reason: 'deleted' }).message);
  });

  it('撤销与过期给出不同的说法', () => {
    expect(blockerPropsFor({ kind: 'share-ended', reason: 'revoked' }).message)
      .not.toBe(blockerPropsFor({ kind: 'share-ended', reason: 'expired' }).message);
  });

  it('认不出的 reason 也有一句能用的文案，不出现 undefined', () => {
    const props = blockerPropsFor({ kind: 'kicked', reason: 'wat' });
    expect(props.message.length).toBeGreaterThan(0);
    expect(props.message).not.toContain('undefined');
  });

  it('阻断之后不再合并任何远端广播', () => {
    setSession({ kind: 'user', user: { id: 'u_me', nickname: '我', role: 'editor' } });
    handleRealtimeEvent({ type: 'kicked', reason: 'disabled' });
    handleRealtimeEvent({
      type: 'marks', origin: 'u_other', seq: 9, changes: { a: { mark: 'pick', by: 'u_other', at: 1 } },
    });
    expect(marks()).toEqual({});
  });
});

describe('事件路由', () => {
  it('认领自己负责的事件类型', () => {
    for (const type of ['marks', 'presence', 'role', 'kicked', 'share-ended', 'hidden']) {
      resetRealtime();
      expect(handleRealtimeEvent({ type })).toBe(true);
    }
  });

  it('不认领 meta / metaDone / bake / scan / error —— 那几条归调用方', () => {
    for (const type of ['meta', 'metaDone', 'bake', 'scan', 'error']) {
      expect(handleRealtimeEvent({ type })).toBe(false);
    }
  });

  it('形状怪异的帧不抛异常', () => {
    expect(() => handleRealtimeEvent(null)).not.toThrow();
    expect(() => handleRealtimeEvent({})).not.toThrow();
    expect(() => handleRealtimeEvent({ type: 'marks' })).not.toThrow();
    expect(() => handleRealtimeEvent({ type: 'marks', changes: 'nope' })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 16：hidden 事件。这个模块只列在 derive/marks 的 Test: 清单之外，
// 但 SSE 路由这一段（realtime.ts 的 case 'hidden'）没有任何用例覆盖的话，
// "认领了这个事件类型却忘了真的调用 applyRemoteHidden" 这种缺口不会被抓住——
// 上一个任务（Task 15）就在同一类问题上出过事：接口清单声明了 SSE 事件，
// 给的测试却在去掉 emit 之后照样全绿。这里补上，不是 brief 要求，是这一类
// 回归本身要求的。
// ─────────────────────────────────────────────────────────────────────────────

describe('hidden 事件的接线（Task 16）', () => {
  it('把服务端广播的整份 hidden 接到 marks store，整份覆盖', () => {
    useMarks.getState().load({}, undefined, ['a']);
    handleRealtimeEvent({ type: 'hidden', origin: 'admin', hidden: ['b', 'c'] });
    expect([...useMarks.getState().hidden]).toEqual(['b', 'c']);
  });

  it('已经被阻断之后不再应用 hidden 广播', () => {
    handleRealtimeEvent({ type: 'kicked', reason: 'disabled' });
    useMarks.getState().load({}, undefined, ['a']);
    handleRealtimeEvent({ type: 'hidden', origin: 'admin', hidden: ['b'] });
    expect([...useMarks.getState().hidden]).toEqual(['a']);
  });
});
