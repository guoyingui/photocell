import { setTimeout as delay } from 'node:timers/promises';
import { getThumb } from './thumbs.js';
import { emit } from './session.js';

const state = new WeakMap();   // session -> { queue: string[], queued: Set, stopped: boolean, current: Promise|null }

// stopBake() 最多等这么久，就放弃等正在进行的那一次 getThumb()，继续收尾。
// getThumb() 本身不抛错，只有真正卡死的情况（比如一张损坏到把 libvips 憋死的图）
// 才会触发这个超时——几秒钟对一张缩略图来说绰绰有余，同时也保证 closeSession()
// （每次 openSession() 和 SIGINT/SIGTERM 退出都会调用它）不会被一次异常的生成
// 卡到永远不返回。
export const DRAIN_TIMEOUT_MS = 3000;

export function startBake(session, { tier = 'grid' } = {}) {
  if (state.has(session)) return;   // 幂等

  const queue = session.assets.filter((a) => a.jpg).map((a) => a.id);
  const st = { queue, queued: new Set(queue), stopped: false, current: null };
  state.set(session, st);

  session.bake.running = true;
  emit(session, { type: 'bake', ...session.bake });

  (async () => {
    while (st.queue.length > 0) {
      if (st.stopped || session.aborted) break;
      const id = st.queue.shift();
      st.queued.delete(id);
      const asset = session.byId.get(id);
      if (!asset) continue;

      const job = getThumb(session.root, asset, tier);   // 失败也算处理过，不重试
      st.current = job;   // stopBake() 需要能等到这一次真正落地，见下方注释
      await job;
      st.current = null;
      session.bake.done++;

      // 每 20 张播报一次，避免 SSE 刷屏
      if (session.bake.done % 20 === 0 || st.queue.length === 0) {
        emit(session, { type: 'bake', ...session.bake });
      }
      await delay(0);   // 让出事件循环，实时请求得以插队进入 sharp 闸门
    }
    // 这一轮已经被取代了（stopBake 删了条目，或者重扫之后新起了一条队列）：
    // 收尾的写状态和广播都不再属于我们。这个 delay(0) 是宏任务，而
    // stopBake → rescanSession 换上新 session.bake → 新一轮 startBake 设
    // running=true 这一整条链全在微任务队列里，保证抢在这次宏任务醒来之前
    // 跑完——届时 session.bake 这个属性访问取到的已经是新对象，照写下去会把
    // 新那一轮刚设好的 running 砸成 false。running 只在 startBake 顶部设一次
    // true，循环体内不会重置，一旦被砸就会一直错到新这一轮自然结束。
    if (state.get(session) !== st) return;
    session.bake.running = false;
    if (!session.aborted) emit(session, { type: 'bake', ...session.bake });
  })().catch((err) => {
    console.error('[bake] 队列异常', err);
    session.bake.running = false;
  });
}

/**
 * 停止烘焙。清空待处理队列后，还要等正在进行的那一次 getThumb()（真实的
 * sharp 读写）落地，调用方 await 完这个函数才能放心地做后续清理（比如删掉
 * 库所在的文件夹）——否则队列虽然空了，但上一次已经提交给 sharp 的读写
 * 还在后台跑，紧接着删目录会跟它撞车（ENOENT / libvips "unable to open
 * for read"）。
 *
 * 但这个等待是有上限的：`drainTimeoutMs` 到了还没等到，就放弃等待、正常返回——
 * 宁可留一次孤儿般的 sharp 调用在后台跑完（反正 getThumb 不抛错，跑完了也没人
 * 再理会它的结果），也不能让 closeSession() 被一次真正卡死的生成拖到永远不
 * 返回。第二个参数只是给测试用一个更短的超时，好让测试不用真的等上生产环境的
 * 那几秒；生产代码路径（session.js 的 closeSession()）永远用默认值调用。
 */
export async function stopBake(session, { drainTimeoutMs = DRAIN_TIMEOUT_MS } = {}) {
  const st = state.get(session);
  if (!st) return;
  st.stopped = true;
  st.queue.length = 0;
  st.queued.clear();
  session.bake.running = false;
  if (st.current) {
    const current = st.current;
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), drainTimeoutMs);
    });
    try {
      const outcome = await Promise.race([
        current.then(() => 'settled', () => 'settled'), // getThumb 自身不抛，这里只是防御
        timedOut,
      ]);
      if (outcome === 'timeout') {
        console.warn(`[bake] 等待正在进行的缩略图生成超过 ${drainTimeoutMs}ms，放弃等待，继续收尾`);
      }
    } finally {
      clearTimeout(timer);
      // 不管是等到了还是超时放弃，这次的"正在进行"都已经处理完毕——
      // 清掉引用，避免同一个 session 上再调用一次 stopBake()（比如
      // closeSession() 的 afterEach 兜底）时，对着同一个（可能永远
      // 不落地的）promise 又重新等一整个超时窗口。
      if (st.current === current) st.current = null;
    }
  }
  // 这条队列已经停且排空了：留着这个条目在 state 里唯一的作用，是挡住将来的
  // startBake（它的幂等守卫只看 state.has(session)，不区分"活跃"还是"已耗尽"，
  // 而且从不自己过期）。closeSession() 是这条路径原来唯一的调用方，紧接着就会
  // 把整个 session 从注册表里摘掉、引用一起丢弃，删不删这个 WeakMap 条目对它
  // 没有任何区别；但 rescanSession()（第二个调用方）要在同一个 session 上
  // 第二次 startBake，不删的话那次调用会直接因为幂等守卫而 no-op——刷新新增
  // 的照片永远进不了烘焙队列，session.bake 也会永久停在重扫刚重置出来的
  // {done:0, running:false} 上。
  state.delete(session);
}

/** 把可视区的 id 提到队首。已烤过的 id 不在队列里，自然被忽略。 */
export function prioritizeBake(session, ids) {
  const st = state.get(session);
  if (!st) return;
  const hoist = [];
  for (const id of ids) {
    if (st.queued.has(id)) {
      st.queued.delete(id);
      hoist.push(id);
    }
  }
  if (!hoist.length) return;
  // 用 Set 而不是 hoist.includes(id)：这个函数在滚动时每 250ms 就被调一次，
  // ids 上限 400、队列上限是整个库，Array.includes 放在 filter 里是 O(n·m)，
  // 全程占着服务端的事件循环。
  const hoisted = new Set(hoist);
  st.queue = [...hoist, ...st.queue.filter((id) => !hoisted.has(id))];
  for (const id of hoist) st.queued.add(id);
}
