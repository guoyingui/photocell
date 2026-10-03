import fs from 'node:fs/promises';
import path from 'node:path';
import { assertWithin } from './safepath.js';
import { readJson, writeJson, withFileLock } from './jsonstore.js';
import { emitPerListener } from './session.js';

async function selectionPath(root) {
  const dir = await assertWithin([root], path.join(root, '.photocull'));
  await fs.mkdir(dir).catch((err) => { if (err.code !== 'EEXIST') throw err; });
  return assertWithin([root], path.join(dir, 'selections.json'));
}

export async function readSelections(root) {
  const data = await readJson(await selectionPath(root), null);
  return { version: 1, people: data?.people && typeof data.people === 'object' && !Array.isArray(data.people)
    ? data.people : {} };
}

/** 提交、备注和标记共用同一把锁；提交落盘后，排队的标记必须重新检查锁定状态。 */
export async function withSelectionLock(root, callback) {
  const file = await selectionPath(root);
  return withFileLock(file, async () => {
    const data = await readSelections(root);
    return callback(data, () => writeJson(file, data));
  });
}

export function ownPickedIds(session, userId) {
  return session.assets.filter((asset) => session.markStore.data.contrib[asset.id]?.[userId]?.mark === 'pick')
    .map((asset) => asset.id);
}

export function selectionView(session, user, share, stored) {
  const status = ['submitted', 'confirmed'].includes(stored?.status) ? stored.status : 'draft';
  const pickedIds = status === 'draft' ? ownPickedIds(session, user.id)
    : (Array.isArray(stored?.pickedIds) ? stored.pickedIds.filter((id) => typeof id === 'string') : []);
  return {
    userId: user.id, nickname: user.nickname, shareId: share.id, shareLabel: share.label,
    status, revision: Number.isSafeInteger(stored?.revision) && stored.revision >= 0 ? stored.revision : 0, pickedIds, selectedCount: pickedIds.length,
    limit: Number.isInteger(share.selectionLimit) ? share.selectionLimit : null,
    note: typeof stored?.note === 'string' ? stored.note : '',
    photoNotes: Object.fromEntries(Object.entries(stored?.photoNotes ?? {}).filter(([, note]) => typeof note === 'string')),
    submittedAt: stored?.submittedAt ?? null, confirmedAt: stored?.confirmedAt ?? null,
    reopenedAt: stored?.reopenedAt ?? null,
    missingIds: pickedIds.filter((id) => !session.byId.has(id)),
  };
}

export function selectionError(message, status = 409) {
  return Object.assign(new Error(message), { status });
}

export async function guardSelectionWrite(req, entries, apply) {
  if (req.actor.kind === 'admin') return apply();
  return withSelectionLock(req.session.root, (data) => {
    if (['submitted', 'confirmed'].includes(data.people[req.actor.user.id]?.status)) {
      throw selectionError('选片已经提交并锁定，请联系摄影师重新开放修改');
    }
    const picked = new Set(ownPickedIds(req.session, req.actor.user.id));
    const previous = picked.size;
    for (const [id, mark] of entries) {
      if (!req.session.byId.has(id)) throw selectionError(`照片已不在当前目录，请刷新后重试：${id}`, 400);
      if (mark === 'pick') picked.add(id); else picked.delete(id);
    }
    const limit = req.actor.share.selectionLimit;
    if (Number.isInteger(limit) && picked.size > limit && picked.size > previous) {
      throw selectionError(`最多可收藏 ${limit} 张，请先取消部分收藏`, 400);
    }
    return apply();
  });
}

export async function publishSelection(session, user, share) {
  const data = await readSelections(session.root);
  const selection = selectionView(session, user, share, data.people[user.id]);
  emitPerListener(session, (listener) => listener.actor.kind === 'admin'
    ? { type: 'selection-updated', userId: user.id }
    : listener.actor.user.id === user.id ? { type: 'selection', selection } : null);
  return selection;
}
