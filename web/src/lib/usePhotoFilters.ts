import { useMemo } from 'react';
import { useLibrary } from '../store/library';
import { useView } from '../store/view';
import { useMarks } from '../store/marks';
import { useReview } from '../store/review';
import { matchesPhoto } from './photoFilters';
import type { Group } from './bursts';
import { matchesOpinion } from '../../../shared/opinions.js';
import { matchesAnnotation } from '../../../shared/annotations.js';
import { useAnnotations } from '../store/annotations';

export function usePhotoFilterAssets() {
  const assets = useLibrary((s) => s.assets);
  const metas = useLibrary((s) => s.metas);
  const filters = useView((s) => s.photoFilters);
  const reviewFilter = useView((s) => s.reviewFilter);
  const reviewed = useReview((s) => s.reviewed);
  const marks = useMarks((s) => s.marks);
  const lightbox = useView((s) => s.lightbox);
  const compare = useView((s) => s.compare);
  const opinionFilter = useView((s) => s.opinionFilter);
  const contrib = useMarks((s) => s.contrib);
  const annotations = useAnnotations((s) => s.annotations);
  const annotationFilters = useView((s) => s.annotationFilters);
  const matchedIds = useView((s) => s.matchedIds);
  const matched = useMemo(() => matchedIds === null ? null : new Set(matchedIds), [matchedIds]);
  return useMemo(() => assets.filter((asset) => {
    if (matched !== null && !matched.has(asset.id)) return false;
    if (!matchesPhoto(asset, metas.get(asset.id), filters)) return false;
    if (!matchesOpinion(contrib[asset.id], opinionFilter)) return false;
    if (!matchesAnnotation(annotations[asset.id], annotationFilters)) return false;
    // 查看中刚记成已看的照片保留到离开预览，避免「未看」视图把大图立即关掉。
    if (reviewFilter === 'all' || asset.id === lightbox
      || asset.id === compare?.reference || asset.id === compare?.candidate) return true;
    return reviewFilter === 'unseen' ? !reviewed.has(asset.id)
      : reviewed.has(asset.id) && (reviewFilter !== 'undecided' || marks[asset.id] === undefined);
  }), [assets, metas, filters, reviewFilter, reviewed, marks, lightbox, compare, opinionFilter, contrib, annotations, annotationFilters, matched]);
}

export function usePhotoFilterGroups(groups: Group[]): Group[] {
  const assets = usePhotoFilterAssets();
  return useMemo(() => {
    const allowed = new Set(assets.map((asset) => asset.id));
    return groups.flatMap((group) => {
      const ids = group.ids.filter((id) => allowed.has(id));
      return ids.length ? [ids.length === group.ids.length ? group : { ...group, ids }] : [];
    });
  }, [groups, assets]);
}
