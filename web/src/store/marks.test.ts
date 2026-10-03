import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { useMarks } from './marks';
import { setSession } from './session';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
  useMarks.getState().load({});
});

const marks = () => useMarks.getState().marks;

describe('useMarks', () => {
  it('setMark 立即更新本地状态（乐观更新）', () => {
    useMarks.getState().setMark(['a'], 'pick');
    expect(marks().a).toBe('pick');
  });

  it('setMark 传 null 取消标记', () => {
    useMarks.getState().setMark(['a'], 'pick');
    useMarks.getState().setMark(['a'], null);
    expect(marks().a).toBeUndefined();
  });

  it('批量标记一次生效', () => {
    useMarks.getState().setMark(['a', 'b', 'c'], 'reject');
    expect(marks()).toEqual({ a: 'reject', b: 'reject', c: 'reject' });
  });

  it('undo 恢复上一步的全部 id', () => {
    useMarks.getState().setMark(['a'], 'pick');
    useMarks.getState().setMark(['a', 'b'], 'reject');
    useMarks.getState().undo();
    expect(marks()).toEqual({ a: 'pick' });
  });

  it('批量标记算一步撤销', () => {
    useMarks.getState().setMark(['a', 'b', 'c'], 'pick');
    useMarks.getState().undo();
    expect(marks()).toEqual({});
  });

  it('连续 undo 逐步回退', () => {
    useMarks.getState().setMark(['a'], 'pick');
    useMarks.getState().setMark(['b'], 'pick');
    useMarks.getState().undo();
    useMarks.getState().undo();
    expect(marks()).toEqual({});
  });

  it('撤销栈为空时 undo 无副作用', () => {
    expect(() => useMarks.getState().undo()).not.toThrow();
    expect(marks()).toEqual({});
  });

  it('撤销栈上限 50 步', () => {
    for (let i = 0; i < 60; i++) useMarks.getState().setMark([`k${i}`], 'pick');
    expect(useMarks.getState().undoStack).toHaveLength(50);
  });

  it('pickCount 与 rejectCount 实时反映当前标记', () => {
    useMarks.getState().setMark(['a', 'b'], 'pick');
    useMarks.getState().setMark(['c'], 'reject');
    expect(useMarks.getState().pickCount()).toBe(2);
    expect(useMarks.getState().rejectCount()).toBe(1);
  });

  it('load 覆盖当前标记并清空撤销栈', () => {
    useMarks.getState().setMark(['a'], 'pick');
    useMarks.getState().load({ z: 'reject' });
    expect(marks()).toEqual({ z: 'reject' });
    expect(useMarks.getState().undoStack).toHaveLength(0);
  });

  it('clearError 手动关掉错误提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, statusText: 'boom', json: async () => ({ error: 'boom' }),
    })));
    useMarks.getState().setMark(['a'], 'pick');
    await new Promise((r) => setTimeout(r, 10));
    expect(useMarks.getState().error).toBeTruthy();

    // 没有这个动作，错误 toast 只能等下一次标记成功才消失——而"下一次标记成功"
    // 恰恰是保存失败之后最不确定会不会发生的事。
    useMarks.getState().clearError();
    expect(useMarks.getState().error).toBeNull();
  });

  it('把改动 PUT 给服务端', () => {
    useMarks.getState().setMark(['a'], 'pick');
    expect(fetch).toHaveBeenCalledWith('/api/library/marks', expect.objectContaining({ method: 'PUT' }));
  });

  it('服务端写入失败时回滚本地状态', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, statusText: 'boom', json: async () => ({ error: 'boom' }),
    })));
    useMarks.getState().setMark(['a'], 'pick');
    await new Promise((r) => setTimeout(r, 10));
    expect(marks().a).toBeUndefined();
    expect(useMarks.getState().error).toBeTruthy();
  });

  // Fix round 1 (F1/F2): 回滚必须只影响失败批次自己的 id，且撤销栈不能留下幽灵条目。

  /** 让针对 `failIds` 的 PUT 失败，其余全部成功。 */
  function fetchRejectingIds(...failIds: string[]) {
    return vi.fn(async (_path: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      const patchIds = Object.keys(body.marks ?? {});
      if (patchIds.some((id) => failIds.includes(id))) {
        return { ok: false, statusText: 'boom', json: async () => ({ error: 'boom' }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
  }

  it('并发批次：先发的批次失败时，不能把后发已成功的批次一起清掉（F1）', async () => {
    vi.stubGlobal('fetch', fetchRejectingIds('a'));
    useMarks.getState().setMark(['a'], 'pick'); // PUT 会失败
    useMarks.getState().setMark(['b'], 'pick'); // PUT 会成功
    await new Promise((r) => setTimeout(r, 10));
    // a 的失败回滚只应该摘掉 a，b 是服务端已经真实保存的结果，必须还在。
    expect(marks()).toEqual({ b: 'pick' });
  });

  it('load() 切换目录发生在一个挂起的 PUT 之后，该 PUT 失败也不能清空新目录的标记（F1）', async () => {
    vi.stubGlobal('fetch', fetchRejectingIds('a'));
    useMarks.getState().setMark(['a'], 'pick'); // PUT 尚未 settle 就切换目录
    useMarks.getState().load({ z: 'reject' });
    await new Promise((r) => setTimeout(r, 10));
    // a 的失败回滚不能把整个 marks 换回切换前的旧快照，新目录的 z 必须保留。
    expect(marks()).toEqual({ z: 'reject' });
  });

  it('回滚后撤销栈不残留失败批次的幽灵条目（F2）', async () => {
    vi.stubGlobal('fetch', fetchRejectingIds('a'));
    useMarks.getState().setMark(['a'], 'pick');
    await new Promise((r) => setTimeout(r, 10));
    expect(marks()).toEqual({});
    expect(useMarks.getState().undoStack).toHaveLength(0);
  });

  it('失败批次被清理后，之后一次正常 undo 不应对该批次涉及的 id 再发多余/破坏性的 PUT（F2）', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      calls.push(body.marks);
      if ('a' in body.marks) {
        return { ok: false, statusText: 'boom', json: async () => ({ error: 'boom' }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    }));

    useMarks.getState().setMark(['a'], 'pick'); // 失败，应该从 undoStack 里消失
    useMarks.getState().setMark(['b'], 'pick'); // 成功，留在 undoStack 顶部
    await new Promise((r) => setTimeout(r, 10));
    expect(marks()).toEqual({ b: 'pick' });
    expect(useMarks.getState().undoStack).toHaveLength(1); // 只剩 b 这一步，没有 a 的幽灵条目

    calls.length = 0; // 只关心接下来 undo 触发的请求
    useMarks.getState().undo();
    await new Promise((r) => setTimeout(r, 10));

    expect(marks()).toEqual({});
    // 撤销只应该针对 b 发起 PUT；绝不能因为幽灵条目而又碰一次 a。
    expect(calls).toEqual([{ b: null }]);
  });

  // Fix round 2 (N1/N2): entries[].before 只是撤销栈的语义，不能直接当回滚依据——
  // undo() 复用的是几步之前的 entries，而且同一个 id 可能先后被两个批次触碰。

  it('undo() 自己发起的 PUT 失败时应该回到 undo 之前的值，而不是停留在已撤销的状态（N1）', async () => {
    useMarks.getState().setMark(['a'], 'pick'); // 用默认成功的 fetch 先把 a 存成 pick
    await new Promise((r) => setTimeout(r, 10));
    expect(marks()).toEqual({ a: 'pick' });

    // 接下来这次 PUT（也就是 undo 自己发起的那次）会失败
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, statusText: 'boom', json: async () => ({ error: 'boom' }),
    })));
    useMarks.getState().undo();
    expect(marks()).toEqual({}); // undo 的乐观更新先在本地生效
    await new Promise((r) => setTimeout(r, 10));
    // undo 自己的 PUT 失败了，必须回到 undo 之前的 'pick'，不能停在「已撤销」的空状态，
    // 否则用户会以为撤销成功了，但服务端其实仍然保存着 pick。
    expect(marks()).toEqual({ a: 'pick' });
    expect(useMarks.getState().error).toBeTruthy();
  });

  it('同一个 id 的两个批次：较早失败、较晚成功时，不能把已确认的较晚值覆盖掉（N2）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (body.marks.a === 'pick') { // 较早那次：pick，会失败
        return { ok: false, statusText: 'boom', json: async () => ({ error: 'boom' }) };
      }
      return { ok: true, json: async () => ({ ok: true }) }; // 较晚那次：reject，会成功
    }));
    useMarks.getState().setMark(['a'], 'pick');   // 较早发起，PUT 会失败
    useMarks.getState().setMark(['a'], 'reject'); // 较晚发起，PUT 会成功
    await new Promise((r) => setTimeout(r, 10));
    // 较早那次失败的回滚不能拿它自己记的旧值把 a 抢回来——较晚这次已经是服务端确认的结果。
    expect(marks()).toEqual({ a: 'reject' });
  });

  it('同一个 id 的两个批次：较早成功、较晚失败时，应该还原成较早那次已保存的值（N2）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (body.marks.a === 'reject') { // 较晚那次：reject，会失败
        return { ok: false, statusText: 'boom', json: async () => ({ error: 'boom' }) };
      }
      return { ok: true, json: async () => ({ ok: true }) }; // 较早那次：pick，会成功
    }));
    useMarks.getState().setMark(['a'], 'pick');   // 较早发起，PUT 会成功
    useMarks.getState().setMark(['a'], 'reject'); // 较晚发起，PUT 会失败
    await new Promise((r) => setTimeout(r, 10));
    // 较晚那次失败，应该退回到较早那次已经成功保存的 'pick'，而不是退回到两次都没发生之前。
    expect(marks()).toEqual({ a: 'pick' });
  });

  it('同一个 id 前后两次设成相同的值：较早那次失败不应该因为「当前值看起来还是我设的」而误回滚（N2）', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++;
      // 两次请求体完全一样（都是 a:'pick'），只能靠调用顺序区分：
      // 第一次（较早发起）失败，第二次（较晚发起，设了同样的值）成功。
      if (call === 1) return { ok: false, statusText: 'boom', json: async () => ({ error: 'boom' }) };
      return { ok: true, json: async () => ({ ok: true }) };
    }));
    useMarks.getState().setMark(['a'], 'pick'); // 较早发起，将失败
    useMarks.getState().setMark(['a'], 'pick'); // 较晚发起，设相同的值，将成功
    await new Promise((r) => setTimeout(r, 10));
    // 期望：较晚这次已经成功保存，a 应该保持 'pick'。如果单纯靠「当前值是否等于我设的值」
    // 判断要不要回滚，这里会误判「还是我的手笔」而把 a 删掉，制造出本地与服务端不一致。
    expect(marks()).toEqual({ a: 'pick' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 17：远端广播与全量补拉的合并。
//
// 三条实时规则里的两条落在这个 store 上：
//   - 本地对某个 id 还有**未落地**的写请求时，丢弃该 id 的远端广播；
//   - 这份保护只覆盖那个 id，同一批广播里别的 id 照常应用。
// （第一条规则「忽略自己发出的回声」需要知道自己是谁，在 realtime.ts 上测。）
// ─────────────────────────────────────────────────────────────────────────────

/** 把 PUT 挂起，由测试自己决定何时（以及成功还是失败）让它返回。 */
function deferredPut() {
  const pending: ((v: unknown) => void)[] = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { pending.push(resolve); })));
  return {
    /** 让目前挂起的全部 PUT 一起返回。 */
    settle(ok = true) {
      for (const resolve of pending.splice(0)) {
        resolve(ok
          ? { ok: true, json: async () => ({ ok: true }) }
          : { ok: false, statusText: 'boom', json: async () => ({ error: 'boom' }) });
      }
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe('远端广播的合并（Task 17）', () => {
  it('applyRemote 把别人的改动合进本地状态', () => {
    useMarks.getState().applyRemote({ a: 'pick', b: 'reject' });
    expect(marks()).toEqual({ a: 'pick', b: 'reject' });
  });

  it('applyRemote 收到 null 表示别人清除了标记', () => {
    useMarks.getState().load({ a: 'pick' });
    useMarks.getState().applyRemote({ a: null });
    expect(marks()).toEqual({});
  });

  it('本地有未落地写时，丢弃该 id 的远端广播（规则 2）', async () => {
    const put = deferredPut();
    // 1. 本地乐观置为 pick，写请求还没返回
    useMarks.getState().setMark(['a'], 'pick');
    expect(marks().a).toBe('pick');

    // 2. 收到别人的广播说它是 reject —— 这是发起者按下 P 之前的旧值
    useMarks.getState().applyRemote({ a: 'reject' });

    // 3. 界面必须仍然是 pick。让广播赢一次，用户就会看到自己刚按的 P 被刷回去，
    //    然后自己的写又成功了 —— 那一下闪烁正是这条规则要挡的东西。
    expect(marks().a).toBe('pick');

    // 4. 自己的写请求返回之后，仍然是 pick
    put.settle(true);
    await flush();
    expect(marks().a).toBe('pick');
  });

  it('未落地写只保护它自己那个 id，别的 id 的广播照常应用（规则 2 的边界）', async () => {
    const put = deferredPut();
    useMarks.getState().setMark(['a'], 'pick');

    // 同一批广播里 a 是旧值（要丢），b 是别人刚做的新标记（要留）。
    // 一刀切丢弃整批的实现会在这里把 b 一起丢掉，那样别人的选择在我这边
    // 会一直看不见，直到下一次重连补拉为止。
    useMarks.getState().applyRemote({ a: 'reject', b: 'pick' });

    expect(marks()).toEqual({ a: 'pick', b: 'pick' });

    put.settle(true);
    await flush();
    expect(marks()).toEqual({ a: 'pick', b: 'pick' });
  });

  it('写请求落地之后，同一个 id 的远端广播恢复正常应用（保护是暂时的）', async () => {
    useMarks.getState().setMark(['a'], 'pick');
    await flush();                       // 默认的 fetch 替身立刻成功
    useMarks.getState().applyRemote({ a: 'reject' });
    expect(marks().a).toBe('reject');
  });

  it('写请求失败回滚之后，保护同样解除', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, statusText: 'boom', json: async () => ({ error: 'boom' }),
    })));
    useMarks.getState().setMark(['a'], 'pick');
    await flush();
    expect(marks().a).toBeUndefined();

    useMarks.getState().applyRemote({ a: 'reject' });
    expect(marks().a).toBe('reject');
  });

  it('多个批次压在同一个 id 上时，要等最后一个落地才解除保护', async () => {
    const put = deferredPut();
    useMarks.getState().setMark(['a'], 'pick');
    useMarks.getState().setMark(['a'], 'reject');
    useMarks.getState().applyRemote({ a: 'pick' });
    expect(marks().a).toBe('reject');
    put.settle(true);
    await flush();
    expect(marks().a).toBe('reject');
  });

  it('远端广播不进撤销栈，也不清空撤销栈', () => {
    useMarks.getState().setMark(['a'], 'pick');
    useMarks.getState().applyRemote({ b: 'reject' });
    // 别人的标记不是我的操作，我的 ⌘Z 不该能把它撤掉；
    // 反过来，收到广播也不该把我自己的撤销历史抹掉。
    expect(useMarks.getState().undoStack).toHaveLength(1);
    useMarks.getState().undo();
    expect(marks()).toEqual({ b: 'reject' });
  });

  it('reconcile 以服务端快照为准，多出来的本地 id 会被删掉', () => {
    useMarks.getState().load({ a: 'pick', ghost: 'reject' });
    useMarks.getState().reconcile({ a: 'reject', c: 'pick' });
    expect(marks()).toEqual({ a: 'reject', c: 'pick' });
  });

  it('reconcile 保留未落地写的 id（服务端快照里必然还没有它）', async () => {
    const put = deferredPut();
    useMarks.getState().setMark(['a'], 'pick');
    useMarks.getState().reconcile({ b: 'reject' });   // 断线期间别人标了 b
    expect(marks()).toEqual({ a: 'pick', b: 'reject' });
    put.settle(true);
    await flush();
    expect(marks()).toEqual({ a: 'pick', b: 'reject' });
  });

  it('reconcile 不清空撤销栈（它是一次合并，不是换文件夹）', () => {
    useMarks.getState().setMark(['a'], 'pick');
    useMarks.getState().reconcile({ a: 'pick' });
    expect(useMarks.getState().undoStack).toHaveLength(1);
  });

  it('load() 之后，旧目录仍在飞的写不再保护新目录里的同名 id', async () => {
    const put = deferredPut();
    useMarks.getState().setMark(['IMG_0002'], 'pick');
    useMarks.getState().load({});                     // 换文件夹：硬重置
    useMarks.getState().applyRemote({ IMG_0002: 'reject' });
    expect(marks()).toEqual({ IMG_0002: 'reject' });
    put.settle(false);                                // 旧的写失败也不该再有发言权
    await flush();
    expect(marks()).toEqual({ IMG_0002: 'reject' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 20：归属表（marksMeta）。
//
// 它是 marks 的**平行**表，形状 `{ id: { by, at } }`，marks 本身一个字节都不变
// （server/lib/store.js 同一口径）。归属只在这里维护，因为它必须复用上面那份
// 在飞计数：本地乐观更新已经把标记改成我的了，远端广播里带的却是上一个人——
// 让它赢一次，界面上就是「标记是我的、角标显示成别人的」。
// ─────────────────────────────────────────────────────────────────────────────

const meta = () => useMarks.getState().marksMeta;

describe('标记归属 marksMeta（Task 20）', () => {
  beforeEach(() => {
    setSession({ kind: 'admin', user: null, share: null, online: [] });
  });

  afterEach(() => {
    setSession({ kind: 'none', user: null, share: null, online: [] });
  });

  it('load 带进来的归属表存进 store', () => {
    useMarks.getState().load({ a: 'pick' }, { a: { by: 'u_1', at: 1700 } });
    expect(meta()).toEqual({ a: { by: 'u_1', at: 1700 } });
  });

  // 旧文件夹 / 一直单机用的文件夹都是这个形状，它是常态而不是异常。
  it('load 不给归属表时按空表处理，不报错', () => {
    useMarks.getState().load({ a: 'pick', b: 'reject' });
    expect(meta()).toEqual({});
    expect(marks()).toEqual({ a: 'pick', b: 'reject' });
  });

  it('load 换文件夹时把上一个文件夹的归属一并清掉', () => {
    useMarks.getState().load({ a: 'pick' }, { a: { by: 'u_1', at: 1 } });
    useMarks.getState().load({ a: 'pick' });
    expect(meta()).toEqual({});
  });

  it('形状不对的归属条目被丢掉，而不是原样塞进界面', () => {
    useMarks.getState().load({ a: 'pick', b: 'pick', c: 'pick' }, {
      a: { by: '', at: 1 },
      b: { at: 1 },
      c: { by: 'u_1', at: Number.NaN },
    } as never);
    expect(meta()).toEqual({});
  });

  it('自己标的片，归属记成自己', () => {
    useMarks.getState().setMark(['a'], 'pick');
    expect(meta().a?.by).toBe('admin');
    expect(typeof meta().a?.at).toBe('number');
  });

  it('访客标的片，归属记成自己的 userId', () => {
    setSession({ kind: 'user', user: { id: 'u_me', nickname: '我', role: 'editor' } });
    useMarks.getState().setMark(['a'], 'pick');
    expect(meta().a?.by).toBe('u_me');
  });

  it('清除标记时归属跟着没（否则归属表会无限长，且描述一条不存在的标记）', () => {
    useMarks.getState().setMark(['a'], 'pick');
    useMarks.getState().setMark(['a'], null);
    expect(meta()).toEqual({});
  });

  it('写失败回滚时，归属跟着标记一起回滚', async () => {
    useMarks.getState().load({ a: 'pick' }, { a: { by: 'u_other', at: 1 } });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, statusText: 'boom', json: async () => ({ error: 'boom' }),
    })));

    useMarks.getState().setMark(['a'], 'reject');
    expect(meta().a?.by).toBe('admin');       // 乐观更新：先算我的
    await flush();

    // 服务端没收下，界面上的标记回到了别人那一版——归属也必须一起回去，
    // 否则那张片会显示成「我改的」，而磁盘上根本没有这次改动。
    expect(marks().a).toBe('pick');
    expect(meta().a).toEqual({ by: 'u_other', at: 1 });
  });

  it('applyRemote 把别人的归属合进来', () => {
    useMarks.getState().applyRemote({ a: 'pick' }, { a: { by: 'u_1', at: 99 } });
    expect(meta()).toEqual({ a: { by: 'u_1', at: 99 } });
  });

  it('applyRemote 收到清除时归属一并删掉', () => {
    useMarks.getState().load({ a: 'pick' }, { a: { by: 'u_1', at: 1 } });
    useMarks.getState().applyRemote({ a: null });
    expect(meta()).toEqual({});
  });

  // 这是 Task 20 的核心防线。没有它，界面会出现「标记是我的、角标是别人的」：
  // 本地乐观更新已经把 a 改成我的了，而远端那一帧广播带的是我按下 P **之前**
  // 那个人的归属，盖上来就成了一条自相矛盾的显示。
  it('本地有未落地写时，该 id 的远端归属一并被丢弃（复用在飞计数）', async () => {
    const put = deferredPut();
    useMarks.getState().setMark(['a'], 'pick');
    expect(meta().a?.by).toBe('admin');

    useMarks.getState().applyRemote({ a: 'reject' }, { a: { by: 'u_other', at: 5 } });

    expect(marks().a).toBe('pick');
    expect(meta().a?.by).toBe('admin');

    put.settle(true);
    await flush();
    expect(meta().a?.by).toBe('admin');
  });

  it('未落地写只保护它自己那个 id，同一批里别人的归属照常合入', async () => {
    const put = deferredPut();
    useMarks.getState().setMark(['a'], 'pick');

    useMarks.getState().applyRemote(
      { a: 'reject', b: 'pick' },
      { a: { by: 'u_other', at: 5 }, b: { by: 'u_other', at: 5 } },
    );

    expect(meta().a?.by).toBe('admin');
    expect(meta().b?.by).toBe('u_other');
    put.settle(true);
    await flush();
  });

  // 认不出发起者的广播（缺 by/at、或者形状坏了）只能退化成「不显示归属」。
  // 留着上一条归属更糟：它会把这次改动算到上一个人头上。
  it('广播没带归属时，旧归属被清掉而不是留着冒认', () => {
    useMarks.getState().load({ a: 'pick' }, { a: { by: 'u_1', at: 1 } });
    useMarks.getState().applyRemote({ a: 'reject' });
    expect(marks().a).toBe('reject');
    expect(meta().a).toBeUndefined();
  });

  it('reconcile 以服务端的归属快照为准', () => {
    useMarks.getState().load({ a: 'pick', ghost: 'pick' }, {
      a: { by: 'u_1', at: 1 }, ghost: { by: 'u_1', at: 1 },
    });
    useMarks.getState().reconcile({ a: 'reject' }, { a: { by: 'u_2', at: 9 } });
    expect(meta()).toEqual({ a: { by: 'u_2', at: 9 } });
  });

  it('reconcile 保留未落地写的那条归属（服务端快照里必然还没有它）', async () => {
    const put = deferredPut();
    useMarks.getState().setMark(['a'], 'pick');

    useMarks.getState().reconcile({ b: 'reject' }, { b: { by: 'u_1', at: 2 } });

    expect(marks().a).toBe('pick');
    expect(meta().a?.by).toBe('admin');
    expect(meta().b?.by).toBe('u_1');
    put.settle(true);
    await flush();
  });

  it('reconcile 不给归属表时按空表处理（老服务端 / 旧文件）', () => {
    useMarks.getState().load({ a: 'pick' }, { a: { by: 'u_1', at: 1 } });
    useMarks.getState().reconcile({ a: 'pick' });
    expect(meta()).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 16：hidden。隐藏对所有人生效，写入是 admin-only，但那道门禁在路由层，
// 这个 store 不重复判断。这里只管三件事：load 时把服务端给的整份 hidden 灌进来、
// setHidden 的乐观更新与失败回滚、以及 applyRemoteHidden 用服务端权威的那一份
// 整份覆盖本地——部分执行语义下（已标记的会被服务端过滤掉），请求体里原样的
// ids 不能直接当作生效结果，哪些真的被隐藏了只有服务端的响应说了算。
// ─────────────────────────────────────────────────────────────────────────────

/** 让 fetch 对指定路径返回一个结构化错误响应，其余路径按默认成功处理。 */
function stubError(path: string, status: number, body: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === path) return { ok: false, status, statusText: 'error', json: async () => body };
    return { ok: true, json: async () => ({ ok: true }) };
  }));
}

describe('hidden', () => {
  it('load 把 hidden 灌进 store', () => {
    useMarks.getState().load({}, undefined, ['a', 'b']);
    expect([...useMarks.getState().hidden]).toEqual(['a', 'b']);
  });

  it('旧文件夹没有这个字段时是空集，不报错', () => {
    useMarks.getState().load({});
    expect(useMarks.getState().hidden.size).toBe(0);
  });

  it('setHidden 乐观更新，失败回滚', async () => {
    stubError('/api/library/hidden', 500, { error: 'persist-failed', message: '写不进去' });
    useMarks.getState().load({}, undefined, []);
    useMarks.getState().setHidden(['a'], true);
    expect(useMarks.getState().hidden.has('a')).toBe(true);   // 乐观
    await flush();
    expect(useMarks.getState().hidden.has('a')).toBe(false);  // 回滚
    expect(useMarks.getState().error).toContain('写不进去');
  });

  it('applyRemoteHidden 用服务端给的整份覆盖', () => {
    useMarks.getState().load({}, undefined, ['a']);
    useMarks.getState().applyRemoteHidden(['b', 'c']);
    expect([...useMarks.getState().hidden]).toEqual(['b', 'c']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 17：隐藏写入的重叠。Task 16 时这条路径还不可达（没有任何 UI 能调
// setHidden），Task 17 把 H 键和批量操作条接上去之后它就是常态了——按住 H 会
// 触发键盘重复，一秒能发出去十几个 PUT。要防的不是"两个人同时改同一张"
// （隐藏只有管理员一个写入方），而是**同一个人的两次调用在时间上重叠**。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 让每一次 PUT 都挂在那里，由用例逐个决定成败与响应体——
 * 「#2 先成功、#1 后失败」这个顺序只有手动 settle 才构造得出来。
 */
function pendingPuts() {
  const pending: ((v: unknown) => void)[] = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { pending.push(resolve); })));
  return {
    /** 第 n 次调用（从 0 起）成功，服务端权威的整份 hidden 是 list。 */
    succeed(n: number, list: string[]) {
      pending[n]({ ok: true, json: async () => ({ ok: true, hidden: list }) });
    },
    /** 第 n 次调用失败。 */
    fail(n: number) {
      pending[n]({
        ok: false, status: 500, statusText: 'error',
        json: async () => ({ error: 'persist-failed', message: '写不进去' }),
      });
    },
  };
}

const hidden = () => [...useMarks.getState().hidden];

describe('hidden 的并发写入', () => {
  it('先发的那次失败时，不能把后发已成功的那次一起清掉', async () => {
    const puts = pendingPuts();
    useMarks.getState().load({}, undefined, []);
    useMarks.getState().setHidden(['a'], true);   // #1：50 张里的那次，会失败
    useMarks.getState().setHidden(['b'], true);   // #2：紧接着又按了一下

    // #2 先回来。服务端此刻只有 b —— #1 那次根本没落盘。
    puts.succeed(1, ['b']);
    await flush();
    expect(hidden()).toEqual(['b']);

    puts.fail(0);
    await flush();
    // 「失败就换回自己动手前那份快照」在这里会把 hidden 换成 #1 的空集：
    // 服务端藏着一张、本地一张都不藏，分歧一直持续到刷新或 SSE 重连。
    expect(hidden()).toEqual(['b']);
  });

  it('两次都失败时，退回服务端最后确认过的那一份', async () => {
    const puts = pendingPuts();
    useMarks.getState().load({}, undefined, ['z']);
    useMarks.getState().setHidden(['a'], true);   // #1
    useMarks.getState().setHidden(['b'], true);   // #2

    puts.fail(0);
    await flush();
    puts.fail(1);
    await flush();

    // 回滚的落点是「服务端最后一次说过的那份」。换成「#2 动手之前本地长什么样」
    // 会把 a 留下——那是 #1 的乐观更新，而 #1 恰恰失败了，服务端从来没有它。
    expect(hidden()).toEqual(['z']);
    expect(useMarks.getState().error).toContain('写不进去');
  });

  it('更晚的写入还在飞时，早一次的响应不铺到界面上', async () => {
    const puts = pendingPuts();
    useMarks.getState().load({}, undefined, []);
    useMarks.getState().setHidden(['a'], true);   // #1
    useMarks.getState().setHidden(['b'], true);   // #2 还在飞

    // #1 的响应描述的是 #2 到达之前的服务端：只有 a。
    puts.succeed(0, ['a']);
    await flush();
    // 铺上去的话，刚藏起来的 b 会当场冒回来，等 #2 的响应到了再消失一次。
    expect(hidden()).toEqual(['a', 'b']);

    puts.succeed(1, ['a', 'b']);
    await flush();
    expect(hidden()).toEqual(['a', 'b']);
  });

  it('更晚的写入还在飞时，早一次的失败不抹掉它的乐观状态', async () => {
    const puts = pendingPuts();
    useMarks.getState().load({}, undefined, []);
    useMarks.getState().setHidden(['a'], true);   // #1，会失败
    useMarks.getState().setHidden(['b'], true);   // #2，还在飞

    puts.fail(0);
    await flush();
    // 这时候回滚（不管回到哪一份）都会把 b 一起抹掉：用户看着它冒回来，
    // 等 #2 的响应到了再消失一次。b 的去留只有 #2 自己的成败有资格决定。
    expect(hidden()).toEqual(['a', 'b']);

    puts.succeed(1, ['b']);
    await flush();
    // #2 的响应把 a 也收敛掉了 —— 它那次确实没存进去。
    expect(hidden()).toEqual(['b']);
  });

  it('广播过来的真值成为后续回滚的落点', async () => {
    const puts = pendingPuts();
    useMarks.getState().load({}, undefined, []);
    useMarks.getState().setHidden(['a'], true);
    // 期间别人标了一张已隐藏的照片，服务端把它挤出隐藏并广播了整份 hidden
    // （server/routes/marks.js 的不变量 3）。
    useMarks.getState().applyRemoteHidden(['x']);

    puts.fail(0);
    await flush();

    // 回到广播那一份，而不是「我动手之前」的空集——后者会把别人的改动一起抹掉。
    expect(hidden()).toEqual(['x']);
  });

  it('换文件夹之后，上一个文件夹还在飞的写入不能再落地', async () => {
    const puts = pendingPuts();
    useMarks.getState().load({}, undefined, ['a']);   // 文件夹 A
    useMarks.getState().setHidden(['b'], true);       // #1
    useMarks.getState().setHidden(['c'], true);       // #2
    useMarks.getState().load({}, undefined, ['z']);   // 换到 B

    // 同一台相机的两场拍摄天然共享 id，A 的结果铺到 B 上不会报任何错，
    // 只会让 B 里几张莫名其妙的照片消失。
    puts.succeed(0, ['a', 'b']);
    await flush();
    expect(hidden()).toEqual(['z']);

    puts.fail(1);
    await flush();
    expect(hidden()).toEqual(['z']);
    // 这条提示说的是 A 里那几张，在 B 里既解释不清也无从处理。
    expect(useMarks.getState().error).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 22：contrib —— 按人筛选的唯一数据源
// ─────────────────────────────────────────────────────────────────────────────

describe('contrib', () => {
  const at = 1;

  afterEach(() => { setSession({ kind: 'none', user: null, share: null, online: [] }); });

  it('客户重新打开后，撤销和重做恢复自己的原始意见，保留摄影师最终决定', async () => {
    setSession({ kind: 'user', user: { id: 'u_me', nickname: '客户', role: 'editor' } });
    useMarks.getState().load({ A: 'pick' }, {}, [], undefined, { A: { mark: 'pick', at: 2 } }, 1,
      { A: { mark: 'reject', at: 1 } });
    useMarks.getState().setMark(['A'], 'pick');
    await vi.waitFor(() => expect(useMarks.getState().pendingCount).toBe(0));
    useMarks.getState().undo();
    expect(JSON.parse(vi.mocked(fetch).mock.calls.at(-1)![1]!.body as string).marks).toEqual({ A: 'reject' });
    expect(useMarks.getState().contrib.A?.u_me?.mark).toBe('reject');
    expect(marks().A).toBe('pick');
    await vi.waitFor(() => expect(useMarks.getState().pendingCount).toBe(0));
    useMarks.getState().redo();
    expect(JSON.parse(vi.mocked(fetch).mock.calls.at(-1)![1]!.body as string).marks).toEqual({ A: 'pick' });
    expect(useMarks.getState().contrib.A?.u_me?.mark).toBe('pick');
    await vi.waitFor(() => expect(useMarks.getState().pendingCount).toBe(0));
  });

  it('自己没有投票时，撤销会清除自己的一票，不把最终决定误存成原始意见', async () => {
    setSession({ kind: 'user', user: { id: 'u_me', nickname: '客户', role: 'editor' } });
    useMarks.getState().load({ A: 'pick' }, {}, [], undefined, { A: { mark: 'pick', at: 2 } }, 1, {});
    useMarks.getState().setMark(['A'], 'reject');
    await vi.waitFor(() => expect(useMarks.getState().pendingCount).toBe(0));
    useMarks.getState().undo();
    expect(JSON.parse(vi.mocked(fetch).mock.calls.at(-1)![1]!.body as string).marks).toEqual({ A: null });
    expect(useMarks.getState().contrib.A).toBeUndefined();
    expect(marks().A).toBe('pick');
    await vi.waitFor(() => expect(useMarks.getState().pendingCount).toBe(0));
  });

  it('load 时做形状校验，坏条目丢掉而不是抛', () => {
    // 这张表来自网络。一个 mark 字段写着别的字符串，就会让「新娘收藏过的」
    // 里混进一张她排除过的照片——那种错误在界面上一点痕迹都没有。
    // 而整份表抛掉更糟：升级不该让摄影师昨天的选片打不开。
    useMarks.getState().load({}, undefined, undefined, {
      IMG_ok: { u_a: { mark: 'pick', at } },
      IMG_badMark: { u_a: { mark: 'maybe', at } },
      IMG_badAt: { u_a: { mark: 'pick', at: 'x' } },
      IMG_emptyUser: { '': { mark: 'pick', at } },
      IMG_notObject: 'nope',
      IMG_mixed: { u_a: { mark: 'pick', at }, u_bad: { mark: 'nope', at } },
    });

    expect(useMarks.getState().contrib).toEqual({
      IMG_ok: { u_a: { mark: 'pick', at } },
      IMG_mixed: { u_a: { mark: 'pick', at } },
    });
  });

  it('字段整个坏掉或缺失时退化成空表', () => {
    for (const bad of [undefined, null, 'x', [1, 2, 3]]) {
      useMarks.getState().load({}, undefined, undefined, bad);
      expect(useMarks.getState().contrib).toEqual({});
    }
  });

  it('自己标记时只动自己那一格，别人投过的原样留着', () => {
    // 取消标记如果清空整条，会把摄影师那一票连坐删掉，按人筛立刻少一批照片。
    setSession({ kind: 'admin', user: null, share: null, online: [] });
    useMarks.getState().load({}, undefined, undefined, {
      IMG_1: { u_bride: { mark: 'pick', at } },
    });

    useMarks.getState().setMark(['IMG_1'], 'reject');
    expect(useMarks.getState().contrib.IMG_1?.u_bride).toEqual({ mark: 'pick', at });
    expect(useMarks.getState().contrib.IMG_1?.admin?.mark).toBe('reject');

    useMarks.getState().setMark(['IMG_1'], null);
    expect(useMarks.getState().contrib.IMG_1?.admin).toBeUndefined();
    expect(useMarks.getState().contrib.IMG_1?.u_bride).toEqual({ mark: 'pick', at });
  });

  it('别人的广播也维护 contrib，管理员筛着人时才看得见客户在选什么', () => {
    // 不维护的话，管理员正筛着「新娘」，新娘在浏览器中标的每一张都不会
    // 出现在他眼前，直到他刷新——而实时看到客户在选什么正是这个功能的用处。
    setSession({ kind: 'admin', user: null, share: null, online: [] });
    useMarks.getState().load({});

    useMarks.getState().applyRemote({ IMG_9: 'pick' }, { IMG_9: { by: 'u_bride', at: 7 } });
    expect(useMarks.getState().contrib.IMG_9).toEqual({ u_bride: { mark: 'pick', at: 7 } });

    useMarks.getState().applyRemote({ IMG_9: null }, { IMG_9: { by: 'u_bride', at: 8 } });
    expect(useMarks.getState().contrib.IMG_9).toBeUndefined();
  });
});
