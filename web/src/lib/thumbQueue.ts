interface Entry {
  key: string;
  url: string;
  priority: number;
  controller: AbortController;
  promise: Promise<Blob>;
  resolve: (blob: Blob) => void;
  reject: (err: Error) => void;
  started: boolean;
}

export interface ThumbQueue {
  request(key: string, url: string, priority: number): Promise<Blob>;
  cancel(key: string): void;
  reprioritize(score: (key: string) => number): void;
  readonly pending: number;
  readonly active: number;
}

function abortError() {
  const err = new Error('请求已取消');
  err.name = 'AbortError';
  return err;
}

/**
 * 缩略图请求队列。三件事：
 *   1. 并发闸门 —— 对齐浏览器同域连接数，避免请求互相饿死
 *   2. 优先级出队 —— 距视口中心近的先发，滚动停下时眼睛看的那行最先出图
 *   3. cancel 即 abort —— 快速滚动掠过的图，请求在半路被掐断，不占带宽也不堵后端
 */
export function createThumbQueue({
  concurrency,
  fetchImpl = fetch,
}: { concurrency: number; fetchImpl?: typeof fetch }): ThumbQueue {
  // concurrency 必须是 >= 1 的整数：pump() 用 `running.size < concurrency` 作为放行闸门，
  // 0、负数或 NaN 都会让这个比较永远为 false —— 条目能排进 queued，却永远不会被 pump()
  // 挑出来跑，promise 永远不 resolve/reject，且没有任何报错信号，比崩溃更难排查。
  // 构造时就拒绝非法值，比运行时静默挂起更容易定位问题。
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(
      `createThumbQueue: concurrency 必须是 >= 1 的整数，收到 ${String(concurrency)}`,
    );
  }

  const queued = new Map<string, Entry>();
  const running = new Map<string, Entry>();

  function pump() {
    while (running.size < concurrency && queued.size > 0) {
      let best: Entry | null = null;
      for (const entry of queued.values()) {
        if (best === null || entry.priority < best.priority) best = entry;
      }
      if (best === null) return;

      queued.delete(best.key);
      running.set(best.key, best);
      best.started = true;
      void start(best);
    }
  }

  async function start(entry: Entry) {
    try {
      const res = await fetchImpl(entry.url, { signal: entry.controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      entry.resolve(await res.blob());
    } catch (err) {
      entry.reject(err as Error);
    } finally {
      // 只删自己：cancel() 已经把被取消的 entry 同步移出 running，
      // 如果同一 key 在这条 await 挂起期间被重新 request 过，running 里
      // 现在存的是一个新 entry —— 不能让这条迟到的 finally 把它删掉。
      if (running.get(entry.key) === entry) running.delete(entry.key);
      pump();
    }
  }

  return {
    request(key, url, priority) {
      const existing = queued.get(key) ?? running.get(key);
      if (existing) {
        existing.priority = Math.min(existing.priority, priority);
        return existing.promise;
      }

      let resolve!: (blob: Blob) => void;
      let reject!: (err: Error) => void;
      const promise = new Promise<Blob>((res, rej) => { resolve = res; reject = rej; });

      const entry: Entry = {
        key, url, priority, controller: new AbortController(),
        promise, resolve, reject, started: false,
      };
      queued.set(key, entry);
      pump();
      return promise;
    },

    cancel(key) {
      const waiting = queued.get(key);
      if (waiting) {
        queued.delete(key);
        waiting.reject(abortError());
        return;
      }
      const active = running.get(key);
      if (active) {
        // 必须在这里同步把 entry 移出 running，而不是等 start() 的 finally
        // （那是下一个微任务才跑）。否则同一 tick 内 cancel 后立刻用同一 key
        // 重新 request，会在 dedupe 检查里捡到这个正在死亡的 entry，拿到一个
        // 注定 reject 的 promise，且从未发出新的 fetch —— 缩略图永远不出图。
        running.delete(key);
        active.controller.abort();
        pump();   // 空出的并发槽位立刻放行下一个排队项
      }
    },

    reprioritize(score) {
      for (const entry of queued.values()) entry.priority = score(entry.key);
    },

    get pending() { return queued.size; },
    get active() { return running.size; },
  };
}
