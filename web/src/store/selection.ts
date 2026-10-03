import { create } from 'zustand';
import { getJSON, getSessionId, postJSON, putJSON } from '../lib/api';
import { setSession } from './session';
import type { CustomerSelection } from '../types';

interface SelectionState {
  key: string | null; selection: CustomerSelection | null; loading: boolean; busy: boolean; error: string | null;
  activate: (sid: string, actor: string) => Promise<void>;
  reset: () => void;
  reload: () => Promise<void>;
  remote: (selection: CustomerSelection) => void;
  save: (patch: { note?: string; photoNotes?: Record<string, string> }) => Promise<boolean>;
  submit: () => Promise<boolean>;
}

export const useSelection = create<SelectionState>((set, get) => {
  let epoch = 0;
  let sid: string | null = null;
  const accept = (selection: CustomerSelection | null) => {
    const current = get().selection;
    if (current && (!selection || selection.userId !== current.userId || selection.revision < current.revision)) return;
    set({ selection, error: null });
    setSession({ selectionLocked: selection !== null && selection.status !== 'draft' });
  };
  const mutate = async (send: () => Promise<{ selection: CustomerSelection }>) => {
    if (!get().key || get().busy || getSessionId() !== sid) return false;
    const token = epoch;
    set({ busy: true, error: null });
    try {
      const result = await send();
      if (token !== epoch) return false;
      accept(result.selection); return true;
    } catch (err) {
      if (token === epoch) {
        await get().reload();
        if (token === epoch) set({ error: (err as Error).message });
      }
      return false;
    } finally { if (token === epoch) set({ busy: false }); }
  };
  return {
    key: null, selection: null, loading: false, busy: false, error: null,
    reset() { epoch++; sid = null; set({ key: null, selection: null, loading: false, busy: false, error: null });
      setSession({ selectionLocked: false }); },
    async activate(sessionId, actor) {
      get().reset(); sid = sessionId; set({ key: `${sid}:${actor}` }); await get().reload();
    },
    async reload() {
      if (!get().key || getSessionId() !== sid) return;
      const token = epoch; set({ loading: true });
      try {
        const result = await getJSON<{ selection: CustomerSelection | null }>('/api/library/selection');
        if (token === epoch) accept(result.selection);
      } catch (err) { if (token === epoch) set({ error: `提交状态未能载入：${(err as Error).message}` }); }
      finally { if (token === epoch) set({ loading: false }); }
    },
    remote(selection) {
      if (!get().key || getSessionId() !== sid) return;
      if (!get().key?.endsWith(`:${selection.userId}`)) return;
      if (get().selection && selection.userId !== get().selection?.userId) return;
      if (selection.revision < (get().selection?.revision ?? 0)) return;
      accept(selection);
    },
    save(patch) { return mutate(() => putJSON('/api/library/selection', patch)); },
    submit() {
      const selection = get().selection;
      if (!selection) return Promise.resolve(false);
      return mutate(() => postJSON('/api/library/selection/submit', {
        assetIds: selection.pickedIds, revision: selection.revision,
      }));
    },
  };
});
