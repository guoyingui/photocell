export interface BlobCache {
  get(key: string): string | undefined;
  set(key: string, url: string): void;
  has(key: string): boolean;
  readonly size: number;
  clear(): void;
}

/**
 * blob URL 的 LRU。淘汰时必须 revokeObjectURL —— 不释放的话
 * 滚过几千张缩略图会攒下数百 MB 永不回收的内存。
 * Map 的迭代顺序即插入顺序，第一个 key 就是最久未使用的。
 *
 * capacity 必须是 >= 1 的整数：
 *   - 负数会让下面的淘汰循环 `map.size > capacity` 在 map 已空后依然为真，
 *     陷入不会返回的同步死循环（阻塞整个线程，20s 的测试超时都救不了）。
 *   - NaN 与任何数比较都是 false，会让淘汰循环永不触发，缓存无限增长——
 *     正是这个模块要防止的泄漏本身。
 * 构造时就拒绝非法值，比运行时静默出错更容易定位问题。
 */
export function createBlobCache(
  capacity: number,
  revoke: (url: string) => void = (url) => URL.revokeObjectURL(url),
): BlobCache {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(
      `createBlobCache: capacity 必须是 >= 1 的整数，收到 ${String(capacity)}`,
    );
  }

  const map = new Map<string, string>();

  return {
    get(key) {
      const url = map.get(key);
      if (url === undefined) return undefined;
      map.delete(key);      // 重新插入即提为最新
      map.set(key, url);
      return url;
    },
    set(key, url) {
      const old = map.get(key);
      if (old !== undefined) {
        map.delete(key);
        if (old !== url) revoke(old);
      }
      map.set(key, url);
      while (map.size > capacity) {
        const oldest = map.keys().next().value as string;
        const evicted = map.get(oldest)!;
        map.delete(oldest);
        revoke(evicted);
      }
    },
    has: (key) => map.has(key),
    get size() { return map.size; },
    clear() {
      for (const url of map.values()) revoke(url);
      map.clear();
    },
  };
}
