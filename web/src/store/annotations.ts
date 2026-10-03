import { create } from 'zustand';
import { getJSON, getSessionId, putJSON } from '../lib/api';
import { normalizeAnnotation, type Annotation } from '../../../shared/annotations.js';

export interface AnnotationSnapshot { annotations: Record<string, Annotation>; revision: number }
interface State extends AnnotationSnapshot {
  sid: string | null; ready: boolean; busy: boolean; error: string | null;
  activate: (sid: string) => Promise<void>;
  reset: () => void; reload: () => Promise<void>; remote: (data: AnnotationSnapshot) => void;
  save: (ids: string[], patch: Partial<Annotation>) => Promise<boolean>;
}
export const useAnnotations = create<State>((set, get) => {
  let epoch = 0;
  const current = (token: number) => token === epoch && getSessionId() === get().sid;
  return {
    sid: null, annotations: {}, revision: -1, ready: false, busy: false, error: null,
    reset() { epoch++; set({ sid: null, annotations: {}, revision: -1, ready: false, busy: false, error: null }); },
    async activate(sid) { get().reset(); set({ sid }); await get().reload(); },
    remote(data) {
      if (!get().sid || !Number.isSafeInteger(data.revision) || data.revision < get().revision || !data.annotations) return;
      set({ annotations: Object.fromEntries(Object.entries(data.annotations).map(([id, entry]) => [id, normalizeAnnotation(entry)])),
        revision: data.revision, ready: true, error: null });
    },
    async reload() {
      if (!get().sid || getSessionId() !== get().sid) return;
      const token = epoch;
      try { const result = await getJSON<AnnotationSnapshot>('/api/library/annotations');
        if (current(token)) get().remote(result);
      } catch (err) { if (current(token)) set({ error: `星级与标签未能载入：${(err as Error).message}` }); }
    },
    async save(ids, patch) {
      if (!ids.length || !get().ready || get().busy || getSessionId() !== get().sid) return false;
      const token = epoch; set({ busy: true, error: null });
      try { const result = await putJSON<AnnotationSnapshot>('/api/library/annotations', { ids, patch });
        if (!current(token)) return false;
        get().remote(result); return true;
      } catch (err) { if (current(token)) set({ error: `星级与标签保存失败，请重试：${(err as Error).message}` }); return false; }
      finally { if (current(token)) set({ busy: false }); }
    },
  };
});
