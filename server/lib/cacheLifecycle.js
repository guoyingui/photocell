import { withFileLock } from './jsonstore.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertWithin } from './safepath.js';

export async function ensureCacheDir(root, folder) {
  const parent = await assertWithin([root], path.join(root, '.photocull'));
  const dir = await assertWithin([root], path.join(parent, folder));
  // 非递归创建，已拔走的照片目录不能被后台任务重新建成空文件夹。
  for (const target of [parent, dir]) await fs.mkdir(target).catch((err) => { if (err.code !== 'EEXIST') throw err; });
}
const states = new Map();
const stateFor = (root) => {
  if (!states.has(root)) states.set(root, { active: new Set(), barrier: null });
  return states.get(root);
};
export async function withCacheWork(root, fn) {
  const state = stateFor(root);
  while (state.barrier) await state.barrier;
  const task = Promise.resolve().then(fn); state.active.add(task);
  try { return await task; } finally { state.active.delete(task); }
}
export function withCacheMaintenance(root, fn) {
  return withFileLock(`cache:${root}`, async () => {
    const state = stateFor(root); let release;
    state.barrier = new Promise((resolve) => { release = resolve; });
    let timer;
    try {
      const completed = await Promise.race([Promise.allSettled([...state.active]).then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), 5000); })]);
      if (!completed) throw Object.assign(new Error('缓存仍在生成中，请稍后重试清理'), { status: 409 });
      return await fn();
    } finally { clearTimeout(timer); state.barrier = null; release(); }
  });
}
