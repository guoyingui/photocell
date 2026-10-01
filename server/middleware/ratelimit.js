/**
 * 按 key 的失败计数闸门。join 用它按 IP 限流：60 秒 20 次失败之后 429。
 *
 * 滑动窗口而不是固定窗口：固定窗口在两个窗口的交界处允许 2×max 的突发
 * （窗口末尾 20 次 + 下一个窗口开头 20 次），对"猜 token"这件事来说
 * 那正是最值钱的一段时间。存时间戳数组的代价在 max=20 这个量级完全可以忽略。
 */

// key 数量超过这个数就顺手清一次过期条目。攻击者换不了源 IP（判定基于 TCP
// 源地址，不读任何请求头），所以这里只是防常驻内存慢慢涨，不是防对抗。
const SWEEP_THRESHOLD = 1024;

/**
 * @param {object} options
 * @param {number} options.windowMs 窗口长度（毫秒），必须是正整数
 * @param {number} options.max 窗口内允许的次数，必须是非负整数
 * @param {() => number} [options.now] 时钟注入口，测试用；默认 Date.now
 * @returns {{ hit(key: string): boolean, reset(key?: string): void, size(): number }}
 *
 * **`hit(key)` 返回的是"这一次放行吗"**：true = 还在额度内，false = 超了，
 * 调用方据此返回 429。命名上 hit 是"记一次"，返回值是"记完之后还允许吗"。
 * max=20 时前 20 次返回 true，第 21 次返回 false。
 */
export function createRateLimiter(options) {
  const { windowMs, max, now = Date.now } = options ?? {};

  if (!Number.isInteger(windowMs) || windowMs <= 0) {
    throw new TypeError(`windowMs 必须是正整数，收到 ${JSON.stringify(windowMs)}`);
  }
  if (!Number.isInteger(max) || max < 0) {
    throw new TypeError(`max 必须是非负整数，收到 ${JSON.stringify(max)}`);
  }
  if (typeof now !== 'function') {
    throw new TypeError('now 必须是一个返回毫秒数的函数');
  }

  /** @type {Map<string, number[]>} key -> 窗口内的命中时间戳 */
  const hits = new Map();

  function prune(list, cutoff) {
    let i = 0;
    while (i < list.length && list[i] <= cutoff) i++;
    return i === 0 ? list : list.slice(i);
  }

  function sweep(cutoff) {
    for (const [key, list] of hits) {
      const kept = prune(list, cutoff);
      if (kept.length === 0) hits.delete(key);
      else hits.set(key, kept);
    }
  }

  function hit(key) {
    // 拿不到 key（调用方没解析出来源地址）时按拒绝处理。
    // 这里唯一的替代方案是"没 key 就不限流"，那等于给攻击者一个开关。
    if (typeof key !== 'string' || key === '') return false;

    const t = now();
    const cutoff = t - windowMs;

    if (hits.size > SWEEP_THRESHOLD) sweep(cutoff);

    const list = prune(hits.get(key) ?? [], cutoff);
    list.push(t);
    hits.set(key, list);
    return list.length <= max;
  }

  function reset(key) {
    if (key === undefined) hits.clear();
    else hits.delete(key);
  }

  /** 测试与自检用：当前正在跟踪的 key 数。 */
  function size() {
    return hits.size;
  }

  return { hit, reset, size };
}
