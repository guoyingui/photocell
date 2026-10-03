import { create } from 'zustand';
import { getJSON, getSessionId, putJSON } from '../lib/api';

interface ReviewState {
  key: string | null;
  ready: boolean;
  reviewed: Set<string>;
  error: string | null;
  activate: (sid: string, actor: string) => Promise<void>;
  reset: () => void;
  reload: () => Promise<void>;
  setSeen: (ids: string[], seen: boolean) => void;
  remote: (ids: string[], seen: boolean) => void;
}

export const useReview = create<ReviewState>((set, get) => {
  let epoch = 0;
  let serial = Promise.resolve();
  let sid: string | null = null;
  let confirmed = new Set<string>();
  const pending = new Map<string, number>();
  const merge = (ids: string[], seen: boolean) => {
    const reviewed = new Set(get().reviewed);
    for (const id of ids) { if (seen) reviewed.add(id); else reviewed.delete(id); }
    set({ reviewed });
  };
  return {
    key: null, ready: false, reviewed: new Set(), error: null,
    reset() { epoch++; sid = null; confirmed = new Set(); pending.clear(); serial = Promise.resolve();
      set({ key: null, ready: false, reviewed: new Set(), error: null }); },
    async activate(sessionId, actor) {
      get().reset(); sid = sessionId;
      set({ key: `${sessionId}:${actor}` });
      await get().reload();
    },
    async reload() {
      if (!get().key || getSessionId() !== sid) return;
      const token = epoch;
      try {
        const data = await getJSON<{ reviewed: string[] }>('/api/library/review');
        if (token !== epoch) return;
        const reviewed = new Set(Array.isArray(data.reviewed) ? data.reviewed : []);
        confirmed = new Set(reviewed);
        for (const id of pending.keys()) {
          if (get().reviewed.has(id)) reviewed.add(id); else reviewed.delete(id);
        }
        set({ reviewed, ready: true, error: null });
      } catch (err) {
        if (token === epoch) set({ error: `浏览进度未能载入：${(err as Error).message}` });
      }
    },
    setSeen(ids, seen) {
      if (!get().key || !get().ready || getSessionId() !== sid) return;
      const changed = [...new Set(ids)].filter((id) => get().reviewed.has(id) !== seen);
      if (!changed.length) return;
      if (changed.length > 1000) {
        for (let start = 0; start < changed.length; start += 1000) get().setSeen(changed.slice(start, start + 1000), seen);
        return;
      }
      const token = epoch;
      for (const id of changed) pending.set(id, (pending.get(id) ?? 0) + 1);
      merge(changed, seen);
      serial = serial.then(async () => {
        if (token !== epoch || getSessionId() !== sid) return;
        try {
          await putJSON('/api/library/review', { ids: changed, seen });
          if (token === epoch) {
            for (const id of changed) { if (seen) confirmed.add(id); else confirmed.delete(id); }
            set({ error: null });
          }
        } catch (err) {
          if (token !== epoch) return;
          const owned = changed.filter((id) => pending.get(id) === 1);
          merge(owned.filter((id) => confirmed.has(id)), true);
          merge(owned.filter((id) => !confirmed.has(id)), false);
          set({ error: `浏览进度保存失败，请重试：${(err as Error).message}` });
        } finally {
          if (token === epoch) for (const id of changed) {
            const count = (pending.get(id) ?? 1) - 1;
            if (count > 0) pending.set(id, count); else pending.delete(id);
          }
        }
      });
    },
    remote(ids, seen) {
      for (const id of ids) { if (seen) confirmed.add(id); else confirmed.delete(id); }
      merge(ids.filter((id) => !pending.has(id)), seen);
    },
  };
});
