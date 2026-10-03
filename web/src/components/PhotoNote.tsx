import { useEffect, useState } from 'react';
import { useSelection } from '../store/selection';
import { useSession } from '../store/session';

export function PhotoNote({ id }: { id: string }) {
  const selection = useSelection((state) => state.selection);
  const busy = useSelection((state) => state.busy);
  const canWrite = useSession((state) => state.canWrite());
  const stored = selection?.photoNotes[id] ?? '';
  const [note, setNote] = useState(stored);
  useEffect(() => { setNote(stored); }, [id, stored]);
  if (!selection) return null;
  return <div className="photo-note"><label>我的照片备注<textarea value={note} maxLength={2000}
    disabled={!canWrite || busy} onChange={(event) => setNote(event.target.value)} /></label>
    {canWrite && <button disabled={busy || note === stored}
      onClick={() => void useSelection.getState().save({ photoNotes: { [id]: note } })}>保存照片备注</button>}
  </div>;
}
