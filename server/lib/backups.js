import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertWithin } from './safepath.js';
import { writeJson } from './jsonstore.js';
import { sanitizeMarks } from './store.js';

const FILES = { marks: 'marks.json', annotations: 'annotations.json', selections: 'selections.json', review: 'review.json' };
const EMPTY = { annotations: { revision: 0, annotations: {} }, selections: { version: 1, people: {} }, review: { version: 1, people: {} } };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function safeFile(root, relative) {
  const dir = await assertWithin([root], path.join(root, '.photocull'));
  await fs.mkdir(dir, { recursive: true });
  const file = await assertWithin([root], path.join(dir, relative));
  await assertWithin([root], `${file}.bak`);
  if (relative === 'marks.json') {
    await assertWithin([root], path.join(dir, 'marks.bak.json'));
    await assertWithin([root], `${file}.tmp`);
  }
  return file;
}
async function readData(root, key) {
  const file = await safeFile(root, FILES[key]);
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return structuredClone(EMPTY[key]); throw err; }
}
export async function backupBundle(session) {
  await safeFile(session.root, 'marks.json');
  await session.markStore.flush();
  const data = { marks: structuredClone(session.markStore.data) };
  delete data.marks.recovered;
  for (const key of ['annotations', 'selections', 'review']) data[key] = await readData(session.root, key);
  return { format: 'photocull-backup', version: 1, createdAt: Date.now(),
    library: { name: path.basename(session.root), assetIds: session.assets.map((asset) => asset.id) }, data };
}

// 拒绝原型键与非法层级，上传包只包含固定的四份选片数据，从不接受目标文件路径。
export function validateBackup(bundle) {
  if (Buffer.byteLength(JSON.stringify(bundle) ?? '') > 24 * 1024 * 1024) throw fail('备份超过 24 MB，请使用较小的备份');
  const walk = (value, depth = 0) => {
    if (depth > 20) throw fail('备份层级不合法');
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw fail('备份包含非法字段');
      walk(child, depth + 1);
    }
  };
  walk(bundle);
  const ids = (value) => Array.isArray(value) && value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 4096);
  const revision = (value) => Number.isSafeInteger(value) && value >= 0;
  const notes = (value) => object(value) && Object.values(value).every((note) => typeof note === 'string' && note.length <= 8000);
  const history = (value) => Array.isArray(value) && value.every((v) => object(v) && typeof v.id === 'string'
    && typeof v.subject === 'string' && typeof v.name === 'string' && Number.isFinite(v.createdAt)
    && ['submit', 'confirm', 'reopen', 'final', 'export'].includes(v.action) && ids(v.pickedIds)
    && typeof v.note === 'string' && notes(v.photoNotes));
  const d = bundle?.data;
  if (bundle?.format !== 'photocull-backup' || bundle.version !== 1 || !Number.isFinite(bundle.createdAt)
    || !object(bundle.library) || typeof bundle.library.name !== 'string' || !ids(bundle.library.assetIds)
    || !object(d) || !object(d.marks) || !object(d.marks.marks) || !object(d.marks.settings)
    || !object(d.annotations) || !object(d.annotations.annotations) || !object(d.selections) || !object(d.selections.people)
    || !object(d.review) || !object(d.review.people)) throw fail('这不是有效的 PhotoCull 选片备份（版本 1）');
  if (!revision(d.marks.finalRevision) || !revision(d.marks.burstRevision ?? 0) || !revision(d.annotations.revision)
    || !Number.isInteger(d.marks.settings.burstThresholdMs) || d.marks.settings.burstThresholdMs < 0 || d.marks.settings.burstThresholdMs > 10000
    || !Number.isInteger(d.marks.settings.cellWidth) || d.marks.settings.cellWidth < 120 || d.marks.settings.cellWidth > 420
    || !ids(d.marks.hidden) || !object(d.marks.contrib) || !object(d.marks.finalMarks)
    || !object(d.marks.burstLeaders ?? {}) || !Object.values(d.marks.burstLeaders ?? {}).every((id) => typeof id === 'string')
    || !history(d.marks.finalHistory ?? []) || !Object.values(d.marks.marks).every((mark) => ['pick', 'reject'].includes(mark))
    || !Object.values(d.marks.finalMarks).every((v) => object(v) && ['pick', 'reject'].includes(v.mark) && Number.isFinite(v.at))
    || !Object.values(d.marks.contrib).every((votes) => object(votes) && Object.values(votes).every((v) => object(v) && ['pick', 'reject'].includes(v.mark) && Number.isFinite(v.at)))
    || !Object.values(d.review.people).every(ids)
    || !Object.values(d.selections.people).every((p) => object(p) && revision(p.revision) && ['draft', 'submitted', 'confirmed'].includes(p.status)
      && (!p.pickedIds || ids(p.pickedIds)) && (!p.photoNotes || notes(p.photoNotes))
      && (p.note === undefined || typeof p.note === 'string') && (!p.history || history(p.history)))
    || !Object.values(d.annotations.annotations).every((a) => object(a) && Number.isInteger(a.rating) && a.rating >= 0 && a.rating <= 5
      && ['none', 'red', 'yellow', 'green', 'blue', 'purple'].includes(a.label)
      && ['initial', 'retouch', 'delivery'].includes(a.stage) && Array.isArray(a.keywords) && a.keywords.length <= 10
      && a.keywords.every((k) => typeof k === 'string' && k.length <= 50))) throw fail('备份中的标记、版本、备注或后期数据不合法，请换用完整备份');
  return bundle;
}

async function backupDirectory(root) {
  const dir = await safeFile(root, 'backups');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
export async function listBackups(root) {
  const dir = await backupDirectory(root), records = [];
  for (const name of await fs.readdir(dir)) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
    const file = await assertWithin([root], path.join(dir, name));
    try {
      const bundle = JSON.parse(await fs.readFile(file, 'utf8'));
      records.push({ id: name.slice(0, -5), createdAt: bundle.createdAt, reason: bundle.reason,
        count: bundle.library.assetIds.length });
    } catch { /* 不把损坏快照显示成可恢复的文件 */ }
  }
  return records.sort((a, b) => b.createdAt - a.createdAt);
}
export async function readBackup(root, id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw fail('备份编号不合法');
  try { return validateBackup(JSON.parse(await fs.readFile(await safeFile(root, `backups/${id}.json`), 'utf8'))); }
  catch (err) { if (err.code === 'ENOENT') throw fail('备份不存在，请刷新列表', 404); throw err; }
}
export async function createBackup(session, reason = 'manual', supplied) {
  const previous = await listBackups(session.root);
  if (reason === 'daily' && previous.some((item) => item.reason === 'daily'
    && new Date(item.createdAt).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10))) return null;
  const bundle = supplied ?? await backupBundle(session);
  validateBackup(bundle);
  const id = crypto.randomUUID();
  await writeJson(await safeFile(session.root, `backups/${id}.json`), { ...bundle, reason });
  // 仅轮转自动开库快照，手动及恢复前快照始终保留。
  for (const old of previous.filter((item) => item.reason === 'daily').slice(reason === 'daily' ? 9 : 10)) {
    await fs.unlink(await safeFile(session.root, `backups/${old.id}.json`));
  }
  return id;
}

export async function previewRestore(session, bundle) {
  validateBackup(bundle);
  const current = await backupBundle(session);
  const present = new Set(session.assets.map((asset) => asset.id));
  const matched = bundle.library.assetIds.filter((id) => present.has(id));
  if (bundle.library.assetIds.length && !matched.length) throw fail('备份与当前目录没有匹配照片，请打开对应目录');
  const missing = bundle.library.assetIds.filter((id) => !present.has(id));
  const fields = [['marks', '标记与最终名单'], ['annotations', '后期信息'], ['selections', '客户提交与版本'], ['review', '浏览进度']];
  return { token: hash({ data: current.data, assets: current.library.assetIds, backup: bundle }),
    source: bundle.library.name, target: current.library.name, createdAt: bundle.createdAt,
    matched: matched.length, missing, extra: present.size - matched.length,
    changes: fields.filter(([key]) => hash(bundle.data[key]) !== hash(current.data[key])).map(([, name]) => name) };
}
async function writeData(root, data) {
  for (const [key, name] of Object.entries(FILES)) await writeJson(await safeFile(root, name), data[key]);
}
// 恢复中断时，下次开库先还原恢复前快照，避免读取跨文件的半份状态。
export async function recoverRestore(root) {
  const file = await safeFile(root, 'restore-pending.json');
  let journal;
  try { journal = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return; throw err; }
  validateBackup(journal);
  await writeData(root, journal.data);
  await fs.unlink(file);
}
export async function restoreBackup(session, bundle, token, confirmName) {
  const preview = await previewRestore(session, bundle);
  if (preview.token !== token) throw fail('当前选片或备份已变化，请重新预览后恢复', 409);
  if (confirmName !== path.basename(session.root)) throw fail('请输入当前目录名称以确认覆盖');
  const before = await backupBundle(session);
  const safetyId = await createBackup(session, 'before-restore', before);
  const journal = await safeFile(session.root, 'restore-pending.json');
  await writeJson(journal, before);
  const next = structuredClone(bundle.data);
  next.marks = sanitizeMarks(next.marks);
  next.marks.finalRevision = Math.max(next.marks.finalRevision, before.data.marks.finalRevision) + 1;
  next.marks.burstRevision = Math.max(next.marks.burstRevision, before.data.marks.burstRevision) + 1;
  for (const [id, person] of Object.entries(next.selections.people)) person.revision = Math.max(person.revision ?? 0, before.data.selections.people[id]?.revision ?? 0) + 1;
  next.annotations.revision = Math.max(next.annotations.revision ?? 0, before.data.annotations.revision ?? 0) + 1;
  session.restoring = true;
  try {
    await writeData(session.root, next);
    session.markStore.replace(next.marks);
    await session.markStore.flush();
    await fs.unlink(journal);
  } catch (err) {
    // 回滚也失败时保持维护状态并留下日志，下次开库继续恢复。
    await writeData(session.root, before.data);
    session.markStore.replace(before.data.marks);
    await session.markStore.flush();
    await fs.unlink(journal);
    session.restoring = false;
    throw err;
  }
  session.restoring = false;
  return { safetyId };
}
