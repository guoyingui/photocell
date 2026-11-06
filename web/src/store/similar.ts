import { create } from 'zustand';

/**
 * 「相似照片」扫描进度。
 *
 * 扫描由面板发起，但进度是服务端经同一条 SSE 推回来的——面板自己再开一条
 * EventSource 会和现有的在线成员计数、断线重连逻辑各记一套，没有必要。
 * 这里只放进度，最终分组仍以 HTTP 响应为准：进度帧可能丢，结果不能靠猜。
 */
export interface SimilarProgress {
  /** 客户端每次扫描生成的随机串；面板只认自己这一次。 */
  scan: string;
  done: number;
  total: number;
  running: boolean;
  seq: number;
}

interface SimilarState {
  progress: SimilarProgress | null;
  setProgress: (progress: SimilarProgress) => void;
  reset: () => void;
}

function sanitize(value: unknown): SimilarProgress | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  if (typeof p.scan !== 'string' || p.scan === '') return null;
  if (typeof p.done !== 'number' || typeof p.total !== 'number') return null;
  if (!Number.isFinite(p.done) || !Number.isFinite(p.total)) return null;
  return {
    scan: p.scan,
    done: Math.max(0, p.done),
    total: Math.max(0, p.total),
    running: p.running === true,
    seq: typeof p.seq === 'number' && Number.isFinite(p.seq) ? p.seq : 0,
  };
}

export const useSimilar = create<SimilarState>((set) => ({
  progress: null,
  setProgress(progress) {
    const next = sanitize(progress);
    if (!next) return;
    // 迟到的旧帧不能把新扫描的进度盖回去。
    set((state) => (state.progress && next.seq < state.progress.seq ? state : { progress: next }));
  },
  reset: () => set({ progress: null }),
}));
