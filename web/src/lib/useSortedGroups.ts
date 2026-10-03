import { useMemo } from 'react';
import { useWorkspace } from '../store/workspace';
import { useLibrary } from '../store/library';
import { useAnnotations } from '../store/annotations';
import { sortPhotoGroups } from './photoSort';
import type { Group } from './bursts';

export function useSortedGroups(groups: Group[]) {
  const sort = useWorkspace((state) => state.sort);
  const assets = useLibrary((state) => state.assets);
  const metas = useLibrary((state) => state.metas);
  const annotations = useAnnotations((state) => state.annotations);
  return useMemo(() => sortPhotoGroups(groups, assets, metas, annotations, sort), [groups, assets, metas, annotations, sort]);
}
