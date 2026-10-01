import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.js';
import { openSession, closeAllSessions } from '../lib/session.js';

let tmp, root, session, server, base, savedHome;
const post = (body) => fetch(`${base}/api/export`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'X-PhotoCull-Session': session.id }, body: JSON.stringify(body) });
async function finish(jobId) {
  const response = await fetch(`${base}/api/export/${jobId}/stream`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('导出结束事件缺失');
      text += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = text.indexOf('\n\n')) !== -1) {
        const line = text.slice(0, boundary); text = text.slice(boundary + 2);
        if (!line.startsWith('data: ')) continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === 'done') return event.summary;
        if (event.type === 'error') throw new Error(event.message);
      }
    }
  } finally { await reader.cancel(); }
}
beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-scope-')));
  savedHome = process.env.PHOTOCULL_HOME;
  process.env.PHOTOCULL_HOME = path.join(tmp, 'home');
  root = path.join(tmp, 'photos'); await fs.mkdir(root);
  for (const id of ['A', 'B', 'C']) await fs.writeFile(path.join(root, `${id}.CR3`), `raw-${id}`);
  session = await openSession(root);
  session.markStore.setMark('A', 'pick', { by: 'admin', at: 1 });
  session.markStore.setMark('B', 'pick', { by: 'client', at: 1 });
  session.markStore.setMark('B', 'reject', { by: 'admin', at: 2 });
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await closeAllSessions();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (savedHome === undefined) delete process.env.PHOTOCULL_HOME;
  else process.env.PHOTOCULL_HOME = savedHome;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe('导出范围的服务端执行', () => {
  it('客户收藏实际导出客户那一票，保留库中的最终标记', async () => {
    const destRoot = path.join(tmp, 'client-export');
    const response = await post({ destRoot, scope: { kind: 'client', clientId: 'client' } });
    expect(response.status).toBe(200);
    const job = await response.json(); expect(job.total).toBe(1);
    expect((await finish(job.jobId)).exported).toBe(1);
    expect(await fs.readFile(path.join(destRoot, 'B.CR3'), 'utf8')).toBe('raw-B');
    expect(session.markStore.data.marks.B).toBe('reject');
    await expect(fs.access(path.join(destRoot, 'A.CR3'))).rejects.toThrow();
  });
  it('手动范围可以复制未标记照片，不能伪造资产路径', async () => {
    const destRoot = path.join(tmp, 'selection-export');
    const job = await (await post({ destRoot, scope: { kind: 'selection', assetIds: ['C'] } })).json();
    await finish(job.jobId);
    expect(await fs.readFile(path.join(destRoot, 'C.CR3'), 'utf8')).toBe('raw-C');
    expect(session.markStore.data.marks.C).toBeUndefined();
    expect((await post({ destRoot, scope: { kind: 'selection', assetIds: ['../A'] } })).status).toBe(400);
  });
  it('移动确认按服务端重新计算的范围核对，错误数量不移动任何文件', async () => {
    const response = await post({ destRoot: path.join(tmp, 'move'), mode: 'move', confirmCount: 2,
      scope: { kind: 'client', clientId: 'client' } });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('应为 1');
    expect(await fs.readFile(path.join(root, 'B.CR3'), 'utf8')).toBe('raw-B');
  });
  it('当前排除筛选不导出全库收藏', async () => {
    const job = await (await post({ destRoot: path.join(tmp, 'filtered'),
      scope: { kind: 'filtered', tab: 'reject' } })).json();
    expect(job.total).toBe(0);
    expect((await finish(job.jobId)).exported).toBe(0);
  });
});
