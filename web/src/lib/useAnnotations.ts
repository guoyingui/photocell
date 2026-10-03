import { useEffect } from 'react';
import { getSessionId } from './api';
import { useAnnotations } from '../store/annotations';

export function usePhotoAnnotations(ready: boolean) {
  const sid = getSessionId();
  useEffect(() => {
    if (!ready || !sid) return;
    void useAnnotations.getState().activate(sid);
    return () => useAnnotations.getState().reset();
  }, [ready, sid]);
}
