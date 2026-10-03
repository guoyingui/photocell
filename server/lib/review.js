import fs from 'node:fs/promises';
import path from 'node:path';
import { assertWithin } from './safepath.js';
import { readJson, writeJson, withFileLock } from './jsonstore.js';

async function reviewPath(root) {
  const dir = await assertWithin([root], path.join(root, '.photocull'));
  await fs.mkdir(dir, { recursive: true });
  return assertWithin([root], path.join(dir, 'review.json'));
}

const validIds = (value) => Array.isArray(value)
  ? [...new Set(value.filter((id) => typeof id === 'string' && id))] : [];

export async function readReview(root, actor) {
  const data = await readJson(await reviewPath(root), {});
  return validIds(data?.people?.[actor]);
}

/** 每个人只改自己的浏览进度；整次读改写串行，避免并发覆盖。 */
export async function updateReview(root, actor, ids, seen) {
  const file = await reviewPath(root);
  return withFileLock(file, async () => {
    const data = await readJson(file, {});
    const people = data?.people && typeof data.people === 'object' && !Array.isArray(data.people)
      ? { ...data.people } : {};
    const reviewed = new Set(validIds(people[actor]));
    for (const id of ids) { if (seen) reviewed.add(id); else reviewed.delete(id); }
    people[actor] = [...reviewed];
    await writeJson(file, { version: 1, people });
    return people[actor];
  });
}
