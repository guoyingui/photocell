import { create } from 'zustand';
export const usePreviewCache = create<{ version: number }>(() => ({ version: 0 }));
