import { create } from 'zustand';
import { getJSON, getSessionId, putJSON } from '../lib/api';

interface Leaders { leaders: Record<string, string>; revision: number }
export const useBurstLeaders = create<Leaders & {
  sid: string | null; error: string; remote: (data: Leaders) => void;
  reload: () => Promise<void>; save: (key: string, id: string | null) => Promise<void>;
}>((set, get) => ({
  sid: null, leaders: {}, revision: -1, error: '',
  remote(data) {
    const sid = getSessionId();
    if (get().sid === sid && data.revision < get().revision) return;
    set({ ...data, sid, error: '' });
  },
  async reload() {
    const sid = getSessionId();
    if (get().sid !== sid) set({ sid, leaders: {}, revision: -1, error: '' });
    if (!sid) return;
    try {
      const result = await getJSON<Leaders>('/api/library/burst-leaders');
      if (sid === getSessionId()) get().remote(result);
    } catch (err) { if (sid === getSessionId()) set({ error: (err as Error).message }); }
  },
  async save(key, id) {
    const sid = getSessionId();
    const result = await putJSON<Leaders>('/api/library/burst-leaders', { key, id });
    if (sid === getSessionId()) get().remote(result);
  },
}));
