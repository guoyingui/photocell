import { useEffect, useRef } from 'react';
import { useView } from '../store/view';
import { useMarks } from '../store/marks';
import type { Asset } from '../types';
import type { Group } from './bursts';
import { readPosition, rememberPosition } from './resume';

/** 每个照片目录独立记住浏览位置，不把历史选区恢复成下一次批量操作的目标。 */
export function useResumePosition(root: string | null, ready: boolean, assets: Asset[], groups: Group[]) {
  const restored = useRef<string | null>(null);
  useEffect(() => {
    if (!root || !ready) return;
    const id = readPosition(root);
    if (id && assets.some((asset) => asset.id === id) && !useMarks.getState().hidden.has(id)
      && useView.getState().cursor === null) {
      restored.current = id;
      useView.getState().setCursor(id);
    }
    return useView.subscribe((next, previous) => {
      if (next.cursor === previous.cursor || !next.cursor) return;
      if (next.cursor !== restored.current) restored.current = null;
      rememberPosition(root, next.cursor);
    });
  }, [root, ready]);

  // EXIF 陆续载入后连拍分组可能变化；恢复的那张要始终露出来。
  useEffect(() => {
    const id = restored.current;
    if (!id || useView.getState().cursor !== id) return;
    const group = groups.find((entry) => entry.ids.includes(id));
    if (group && group.ids.length > 1 && !useView.getState().expanded.has(group.key)) {
      useView.getState().toggleExpand(group.key);
    }
  }, [groups]);
}
