import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { createApp } from '../index.js';
import { openSession, closeAllSessions } from '../lib/session.js';
import { _test } from './export.js';
import { readExportHistory, saveExportHistory, appendExportResult } from '../lib/exportHistory.js';

let temp, root, dest, savedHome, server, base, session;
async function request(url, body) {
  return fetch(base + url, { method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-PhotoCull-Session': session.id },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function finish(id) {
  const response = await request(`/api/export/${id}/stream`);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('缺少结束事件');
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (!line.startsWith('data: ')) continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === 'done') return event.summary;
        if (event.type === 'error') throw new Error(event.message);
      }
    }
  } finally { await reader.cancel(); }
}
beforeAll(async () => {
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-history-')));
  root = path.join(temp, 'photos'); dest = path.join(temp, 'export');
  await fs.mkdir(root); await fs.mkdir(dest);
  savedHome = process.env.PHOTOCULL_HOME; process.env.PHOTOCULL_HOME = path.join(temp, 'home');
  for (const name of ['A.CR3', 'A.NEF', 'B.CR3']) await fs.writeFile(path.join(root, name), name);
  await sharp({ create: { width: 32, height: 32, channels: 3, background: '#336699' } }).jpeg().toFile(path.join(root, 'A.JPG'));
  session = await openSession(root);
  session.markStore.setMark('A', 'pick'); session.markStore.setMark('B', 'pick');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await closeAllSessions();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (savedHome === undefined) delete process.env.PHOTOCULL_HOME; else process.env.PHOTOCULL_HOME = savedHome;
  await fs.rm(temp, { recursive: true, force: true });
});

describe('持久化导出历史和逐文件重试', () => {
  it('RAW 成功、JPG 失败，任务内存丢失后仍能找到清单且只重试 JPG', async () => {
    await fs.writeFile(path.join(dest, 'JPG'), '阻挡 JPG 子目录');
    const initial = await (await request('/api/export', { destRoot: dest, includeJpg: true, jpgSubdir: 'JPG' })).json();
    const summary = await finish(initial.jobId);
    expect(summary.exported).toBe(3); expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].file).toBe('A.JPG');
    _test.jobs.delete(initial.jobId);
    const record = await (await request(`/api/export/history/${initial.jobId}`)).json();
    expect(record.retryCount).toBe(1); expect(record.files).toHaveLength(4);
    const listing = await (await request('/api/export/history')).json();
    expect(listing.records.find((entry) => entry.id === initial.jobId).completed).toBe(3);
    const csv = await (await request(`/api/export/history/${initial.jobId}/csv`)).text();
    expect(csv).toContain('A.JPG'); expect(csv).toContain('failed');

    // 标记后来改变也不影响重试清单。
    session.markStore.setMark('A', 'reject');
    await fs.rm(path.join(dest, 'JPG'));
    const retried = await (await request(`/api/export/history/${initial.jobId}/retry`, {})).json();
    expect(retried.total).toBe(1);
    const retriedSummary = await finish(retried.jobId);
    expect(retriedSummary.exported).toBe(1); expect(retriedSummary.errors).toEqual([]);
    expect(retriedSummary.files.map((file) => file.name)).toEqual(['A.JPG']);
    expect(retriedSummary.missingRaw).toEqual([]);
    const final = await readExportHistory(root, retried.jobId);
    expect(final.parentId).toBe(initial.jobId);
    expect(final.status).toBe('complete');
    expect((await (await request(`/api/export/history/${initial.jobId}`)).json()).retryCount).toBe(0);
    expect((await request(`/api/export/history/${initial.jobId}/retry`, {})).status).toBe(400);
    expect(await fs.readFile(path.join(dest, 'A.CR3'), 'utf8')).toBe('A.CR3');
    expect((await fs.readdir(dest)).filter((file) => file.endsWith('.CR3'))).toEqual(['A.CR3', 'B.CR3']);
  });

  it('中断任务合并已落盘的文件结果，移动重试仍独立校验数量', async () => {
    const id = crypto.randomUUID();
    await saveExportHistory(root, { id, createdAt: Date.now(), status: 'running', mode: 'move',
      destRoot: path.join(temp, 'retry-move'), options: { includeJpg: false, manifest: false },
      files: ['A.CR3', 'B.CR3'].map((name) => ({ id: name[0], dir: '', name, kind: 'raw', status: 'pending' })),
    });
    // 崩溃时留下的半行不能吞掉之后新增的有效结果。
    await fs.writeFile(path.join(root, '.photocull', 'exports', `${id}.json.events`), '{"id":"unfinished');
    await appendExportResult(root, id, { id: 'A', dir: '', name: 'A.CR3', kind: 'raw', status: 'exported', path: '/already-delivered' });
    const record = await (await request(`/api/export/history/${id}`)).json();
    expect(record.status).toBe('interrupted'); expect(record.retryCount).toBe(1);
    expect((await request(`/api/export/history/${id}/retry`, { mode: 'move', confirmCount: 2 })).status).toBe(400);
    expect(await fs.readFile(path.join(root, 'B.CR3'), 'utf8')).toBe('B.CR3');
    const retried = await (await request(`/api/export/history/${id}/retry`, { mode: 'move', confirmCount: 1 })).json();
    expect((await finish(retried.jobId)).exported).toBe(1);
    await expect(fs.access(path.join(root, 'B.CR3'))).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'A.CR3'), 'utf8')).toBe('A.CR3');
  });

  it('多次重试仍属于同一任务链，不能从原任务和中间记录同时重试', async () => {
    const familyId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    for (const id of [familyId, childId]) await saveExportHistory(root, {
      id, familyId, parentId: id === familyId ? null : familyId, createdAt: Date.now(),
      status: 'failed', mode: 'copy', destRoot: dest, options: {},
      files: [{ id: 'A', dir: '', name: 'A.CR3', kind: 'raw', status: 'failed' }],
    });
    const grandchild = _test.createJob();
    Object.assign(grandchild, { root, parentId: childId, familyId });
    try {
      for (const id of [familyId, childId]) {
        expect((await request(`/api/export/history/${id}/retry`, {})).status).toBe(409);
      }
      expect(await fs.readFile(path.join(root, 'A.CR3'), 'utf8')).toBe('A.CR3');
    } finally { _test.jobs.delete(grandchild.id); }
  });

  it('已送达但删源失败的记录不自动再复制，历史 id 不接受路径', async () => {
    const id = crypto.randomUUID();
    await saveExportHistory(root, { id, createdAt: Date.now(), status: 'partial', mode: 'move', destRoot: dest,
      options: {}, files: [{ id: 'A', dir: '', name: 'A.CR3', kind: 'raw', status: 'delete-failed' }],
    });
    expect((await request(`/api/export/history/${id}/retry`, {})).status).toBe(400);
    expect((await request('/api/export/history/not-a-job')).status).toBe(404);
    const previous = session;
    const other = path.join(temp, 'other'); await fs.mkdir(other); session = await openSession(other);
    try { expect((await request(`/api/export/history/${id}`)).status).toBe(404); }
    finally { session = previous; }
  });
});
