import { useEffect } from 'react';
import { getSessionId } from './api';
import { useReview } from '../store/review';
import { useView } from '../store/view';
import { useSession } from '../store/session';

export function useReviewProgress(ready: boolean) {
  const sid = getSessionId();
  const actor = useSession((s) => s.kind === 'admin' ? 'admin' : s.user?.id ?? null);
  const loaded = useReview((s) => s.ready);
  const lightbox = useView((s) => s.lightbox);
  const compare = useView((s) => s.compare);
  useEffect(() => {
    if (!ready || !sid || !actor) return;
    void useReview.getState().activate(sid, actor);
    return () => useReview.getState().reset();
  }, [sid, actor, ready]);
  useEffect(() => {
    if (!ready || !loaded) return;
    const ids = compare ? [compare.reference, compare.candidate] : lightbox ? [lightbox] : [];
    useReview.getState().setSeen(ids, true);
  }, [ready, loaded, lightbox, compare]);
}
