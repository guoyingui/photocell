import fs from 'node:fs/promises';
import path from 'node:path';
import { assertWithin } from './safepath.js';
import { readJson, writeJson, withFileLock } from './jsonstore.js';
import { normalizeAnnotation } from '../../shared/annotations.js';

async function annotationsPath(root) {
  const dir = await assertWithin([root], path.join(root, '.photocull'));
  await fs.mkdir(dir).catch((err) => { if (err.code !== 'EEXIST') throw err; });
  return assertWithin([root], path.join(dir, 'annotations.json'));
}
function normalize(data) {
  return { revision: Number.isSafeInteger(data?.revision) && data.revision >= 0 ? data.revision : 0,
    annotations: Object.fromEntries(Object.entries(data?.annotations ?? {})
      .map(([id, entry]) => [id, normalizeAnnotation(entry)])) };
}
export async function readAnnotations(root) {
  return normalize(await readJson(await annotationsPath(root), {}));
}
export async function updateAnnotations(root, ids, patch) {
  const file = await annotationsPath(root);
  return withFileLock(file, async () => {
    const data = normalize(await readJson(file, {}));
    for (const id of ids) data.annotations[id] = normalizeAnnotation({ ...normalizeAnnotation(data.annotations[id]), ...patch });
    data.revision++;
    await writeJson(file, { version: 1, ...data });
    return data;
  });
}
