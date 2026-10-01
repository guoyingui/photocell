import { useEffect, useRef, useState } from 'react';
import { createThumbQueue } from './thumbQueue';
import { createBlobCache } from './blobCache';
import { withSid } from './api';

// 并发 6 对齐浏览器同域连接数；LRU 1200 张，约占 40–60MB
const queue = createThumbQueue({ concurrency: 6 });
const cache = createBlobCache(1200);
const failed = new Set<string>();

// <img src> 无法带请求头，缩略图/原图只能把会话 id 放进查询参数（见 api.ts 的 withSid）。
export const thumbUrl = (id: string, tier: 'grid' | 'preview' = 'grid') =>
  withSid(`/api/thumb?id=${encodeURIComponent(id)}&tier=${tier}`);

export const originalUrl = (id: string) =>
  withSid(`/api/original?id=${encodeURIComponent(id)}`);

export function clearThumbCache() {
  cache.clear();
  // failed 也必须清。少了这一行，在 A 文件夹失败过的 id 到了 B 文件夹会直接
  // 渲染成「无法预览」，一次请求都不会发 —— 而两台同型号机身拍出来的
  // IMG_0002 在两个文件夹里就是同一个 id，这是常态不是边角。
  failed.clear();
}

/** 仅供测试观察内部集合；生产代码不得使用（与 export.js 的 _test 同一约定）。 */
export const __test = { cache, failed };

/**
 * enabled 就是「在视口内」。转 false 时立刻 cancel —— 这是快速滚动时
 * 飞过的几百张图不会占带宽、不会堵后端队列的原因。
 */
export function useThumb(id: string, priority: number, enabled: boolean) {
  const [url, setUrl] = useState<string | null>(() => cache.get(id) ?? null);
  const [isFailed, setFailed] = useState(() => failed.has(id));
  const idRef = useRef(id);
  idRef.current = id;

  useEffect(() => {
    const cached = cache.get(id);
    if (cached) { setUrl(cached); return; }
    if (failed.has(id)) { setFailed(true); return; }
    if (!enabled) return;

    let alive = true;
    setUrl(null);

    queue.request(id, thumbUrl(id), priority)
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        cache.set(id, objectUrl);            // LRU 负责 revoke，这里不手动释放
        if (alive && idRef.current === id) setUrl(objectUrl);
      })
      .catch((err: Error) => {
        if (err.name === 'AbortError') return;   // 滚出视口，不是错误
        failed.add(id);
        if (alive && idRef.current === id) setFailed(true);
      });

    return () => {
      alive = false;
      queue.cancel(id);   // 滚出视口即 abort：飞过的图不占带宽、不堵后端队列
    };
    // 依赖数组刻意不含 priority —— priority 只作首次入队的初值，
    // 后续重排由 reprioritizeThumbs 负责。加进来会导致重复 fetch。
  }, [id, enabled]);

  // 注意：这里不能用 priority 再调一次 queue.request —— 已加载完的图既不在
  // 排队集合也不在进行中集合里，request 会把它当成新请求重新 fetch 一遍。
  // 滚动引起的优先级重排走 reprioritizeThumbs（Task 18），只动队列里还没发出的项。

  return { url, failed: isFailed };
}

/** 滚动停下后调用：按到视口中心的距离重排还在排队的请求。 */
export function reprioritizeThumbs(score: (id: string) => number) {
  queue.reprioritize(score);
}
