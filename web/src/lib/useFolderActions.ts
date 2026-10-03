import { useEffect, useRef, useState } from 'react';
import { getJSON } from './api';
import { useFolders } from '../store/folders';
import { useLibrary } from '../store/library';

interface FolderAction { kind: 'open' | 'remove'; root: string }

/** 所有目录入口共用关闭检查；待确认的动作在访客确认后继续执行。 */
export function useFolderActions() {
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [pending, setPending] = useState<FolderAction | null>(null);
  const [failedRoot, setFailedRoot] = useState<string | null>(null);
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const run = async (action: FolderAction, force = false) => {
    const current = useLibrary.getState();
    if (running.current || current.phase === 'scanning' || current.refreshing) return;
    if (action.kind === 'open' && current.phase === 'ready' && current.root === action.root) return;
    if (action.kind === 'remove' && current.root !== action.root) {
      useFolders.getState().remove(action.root); return;
    }
    running.current = true; setBusyPath(action.root); setFailedRoot(null);
    try {
      let target = action.root;
      if (action.kind === 'open') {
        // 先检查目标是否仍存在；失效的移动硬盘路径不会先把当前选片关闭。
        target = (await getJSON<{ path: string }>(`/api/fs/list?path=${encodeURIComponent(target)}`)).path;
        if (!alive.current || useLibrary.getState().sessionId !== current.sessionId) return;
        if (target === current.root) { useFolders.getState().opened(target, action.root); return; }
      }
      if (current.phase === 'ready') {
        await current.close(force);
        if (!alive.current) return;
        const after = useLibrary.getState();
        if (after.closeBlocked) { setPending(action); return; }
        // 移动任务拦截、关闭失败或另一入口改变了会话时，不继续打开新目录。
        if (after.phase !== 'idle' || after.error) { setPending(null); return; }
      }
      setPending(null);
      if (action.kind === 'remove') useFolders.getState().remove(action.root);
      else {
        await useLibrary.getState().open(target);
        if (!alive.current) return;
        const opened = useLibrary.getState();
        if (opened.phase === 'ready' && opened.root) useFolders.getState().opened(opened.root, action.root);
        else setFailedRoot(action.root);
      }
    } catch (err) {
      if (alive.current) {
        setFailedRoot(action.kind === 'open' ? action.root : null);
        useLibrary.setState({ error: (err as Error).message, errorDetail: null });
      }
    } finally {
      running.current = false;
      if (alive.current) setBusyPath(null);
    }
  };

  useEffect(() => {
    const saved = useFolders.getState().reload();
    const current = useLibrary.getState();
    if (current.phase === 'ready' && current.root) useFolders.getState().opened(current.root);
    else if (current.phase === 'idle' && saved.lastRoot) void run({ kind: 'open', root: saved.lastRoot });
  }, []);

  return { busyPath, failedRoot,
    open: (root: string) => { void run({ kind: 'open', root }); },
    remove: (root: string) => { void run({ kind: 'remove', root }); },
    force: () => { if (pending) void run(pending, true); },
    cancel: () => { setPending(null); useLibrary.getState().dismissCloseBlock(); },
  };
}
