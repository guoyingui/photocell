import fs from 'node:fs/promises';
import path from 'node:path';
import { assertWithin } from './safepath.js';
import { readJson, writeJson, withFileLock } from './jsonstore.js';
import { csvRow } from './csv.js';
import { transferKey } from './transfer.js';

const ID = /^[a-f0-9-]{36}$/;
async function historyDir(root) {
  const dir = await assertWithin([root], path.join(root, '.photocull', 'exports'));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
async function historyPath(root, id) {
  if (typeof id !== 'string' || !ID.test(id)) throw Object.assign(new Error('未知导出记录'), { status: 404 });
  return assertWithin([root], path.join(await historyDir(root), `${id}.json`));
}

export async function saveExportHistory(root, record) {
  const file = await historyPath(root, record.id);
  await withFileLock(file, () => writeJson(file, record));
}

export async function readExportHistory(root, id) {
  const file = await historyPath(root, id);
  const record = await readJson(file, null);
  if (!record || record.id !== id || !Array.isArray(record.files)) {
    throw Object.assign(new Error('导出记录不存在或已损坏'), { status: 404 });
  }
  // 每文件追加一条小记录，避免一场几千张照片反复重写整份清单。
  const journal = await assertWithin([root], file + '.events');
  let lines = '';
  try { lines = await fs.readFile(journal, 'utf8'); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  const results = new Map();
  for (const line of lines.split('\n')) {
    try {
      const result = JSON.parse(line);
      if (result && typeof result.id === 'string') results.set(transferKey(result), result);
    } catch { /* 意外退出造成的尾行不完整，保留该文件的 pending 状态。 */ }
  }
  record.files = record.files.map((entry) => results.get(transferKey(entry)) ?? entry);
  return record;
}

export async function appendExportResult(root, id, result) {
  const file = await assertWithin([root], (await historyPath(root, id)) + '.events');
  await withFileLock(file, async () => {
    const handle = await fs.open(file, 'a', 0o600);
    // 前置换行隔开意外退出留下的半行，后续重试结果仍能独立读取。
    try { await handle.writeFile('\n' + JSON.stringify(result) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
  });
}

export async function listExportHistory(root) {
  const names = (await fs.readdir(await historyDir(root))).filter((name) => ID.test(name.replace(/\.json$/, '')) && name.endsWith('.json'));
  const records = [];
  for (const name of names) {
    try { records.push(await readExportHistory(root, name.slice(0, -5))); }
    catch (err) { if (err.status !== 404) throw err; }
  }
  return records.sort((a, b) => b.createdAt - a.createdAt);
}

// 已送达但删源失败不自动重试，保留源文件并明确提示人工检查。
export const retryableFiles = (record) => record.files.filter((file) => !file.resolvedBy && ['failed', 'pending', 'canceled'].includes(file.status));

/** 保留原任务结果，同时记录哪个重试任务补齐了文件，防止再次重试同一失败项。 */
export async function resolveRetriedFile(root, parentId, result, jobId, ancestors = new Map()) {
  if (!['exported', 'renamed', 'skipped', 'delete-failed'].includes(result.status)) return;
  const visited = new Set();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    let parent = ancestors.get(parentId);
    if (!parent) {
      const record = await readExportHistory(root, parentId);
      parent = { id: record.id, parentId: record.parentId,
        files: new Map(record.files.map((file) => [transferKey(file), file])) };
      ancestors.set(parentId, parent);
    }
    const original = parent.files.get(transferKey(result));
    if (original) await appendExportResult(root, parent.id, { ...original,
      resolvedBy: jobId, retryStatus: result.status, retryPath: result.path });
    parentId = parent.parentId;
  }
}

export function historyCsv(record) {
  return '\uFEFF' + csvRow(['照片', '源文件', '类型', '结果', '目标路径', '说明', '重试结果', '重试任务'])
    + record.files.map((file) => csvRow([file.id, [file.dir, file.name].filter(Boolean).join('/'),
      file.kind, file.status, file.retryPath ?? file.path ?? '', file.message ?? '',
      file.retryStatus ?? '', file.resolvedBy ?? ''])).join('');
}
