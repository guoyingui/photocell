import { create } from 'zustand';
import { normalizeSort, type PhotoSort } from '../lib/photoSort';
import { useView } from './view';

export type FilterSection = 'capture' | 'opinions' | 'annotations';
const KEY = 'photocull.workspace.v1';
export function readWorkspace() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return { sort: normalizeSort(saved?.sort), collapsed: {
      capture: saved?.collapsed?.capture === true, opinions: saved?.collapsed?.opinions === true,
      annotations: saved?.collapsed?.annotations === true,
    } };
  } catch { return { sort: 'time-asc' as PhotoSort, collapsed: { capture: false, opinions: false, annotations: false } }; }
}

interface WorkspaceState {
  sort: PhotoSort;
  collapsed: Record<FilterSection, boolean>;
  storageError: string;
  setSort: (sort: PhotoSort) => void;
  toggleSection: (section: FilterSection) => void;
}
export const useWorkspace = create<WorkspaceState>((set, get) => {
  const persist = () => {
    try { const { sort, collapsed } = get(); localStorage.setItem(KEY, JSON.stringify({ sort, collapsed })); set({ storageError: '' }); }
    catch { set({ storageError: '浏览器未能记住布局设置，本次操作仍然生效。' }); }
  };
  return { ...readWorkspace(), storageError: '',
    setSort(sort) {
      if (sort === get().sort) return;
      useView.setState({ cursor: null, anchor: null, selection: new Set(), lightbox: null, compare: null });
      set({ sort: normalizeSort(sort) }); persist();
    },
    toggleSection(section) { set((state) => ({ collapsed: { ...state.collapsed, [section]: !state.collapsed[section] } })); persist(); },
  };
});
