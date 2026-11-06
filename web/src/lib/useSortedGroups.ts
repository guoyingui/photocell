import { useEffect, useMemo } from 'react';
import { useWorkspace } from '../store/workspace';
import { useLibrary } from '../store/library';
import { useAnnotations } from '../store/annotations';
import { sortPhotoGroups } from './photoSort';
import { getSessionId } from './api';
import { useBurstLeaders } from '../store/burstLeaders';
import type { Group } from './bursts';

export function useSortedGroups(groups: Group[]) {
  const sid = getSessionId();
  const saved = useBurstLeaders((s) => s.leaders);
  const savedSid = useBurstLeaders((s) => s.sid);
  useEffect(() => { void useBurstLeaders.getState().reload(); }, [sid]);
  const sort = useWorkspace((state) => state.sort);
  const assets = useLibrary((state) => state.assets);
  const metas = useLibrary((state) => state.metas);
  const annotations = useAnnotations((state) => state.annotations);
  return useMemo(() => sortPhotoGroups(groups, assets, metas, annotations, sort).map((group) => {
    const leader = savedSid === sid ? saved[group.key] : undefined;
    return leader && group.ids.includes(leader) ? { ...group, ids: [leader, ...group.ids.filter((id) => id !== leader)] } : group;
  }), [groups, assets, metas, annotations, sort, saved, savedSid, sid]);
}
