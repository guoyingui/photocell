import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.js';
import { openSession, closeSession, closeAllSessions } from '../lib/session.js';
import { createShare } from '../lib/shares.js';
import { createUser } from '../lib/users.js';

let temp, root, savedHome, server, base, session, remote = null;
const users = {};
const request = (who, method = 'GET', body) => {
  remote = who === 'admin' ? null : '192.168.1.55';
  return fetch(`${base}/api/library/review`, {
    method, headers: { 'Content-Type': 'application/json', 'X-PhotoCull-Session': session.id,
      ...(users[who] ? { cookie: `pc_user=${users[who].token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
};
beforeAll(async () => {
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-review-')));
  root = path.join(temp, 'photos'); await fs.mkdir(root);
  savedHome = process.env.PHOTOCULL_HOME; process.env.PHOTOCULL_HOME = path.join(temp, 'home');
  for (const id of ['A', 'B']) await fs.writeFile(path.join(root, `${id}.CR3`), id);
  session = await openSession(root);
  const share = await createShare({ root });
  users.editor = await createUser(share.id, '编辑', 'editor');
  users.viewer = await createUser(share.id, '只读', 'viewer');
  const app = createApp();
  server = http.createServer((req, res) => {
    delete req.socket.remoteAddress;
    if (remote) Object.defineProperty(req.socket, 'remoteAddress', { value: remote, configurable: true });
    app(req, res);
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await closeAllSessions();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (savedHome === undefined) delete process.env.PHOTOCULL_HOME; else process.env.PHOTOCULL_HOME = savedHome;
  await fs.rm(temp, { recursive: true, force: true });
});

describe('个人浏览进度', () => {
  it('只读访客可写自己的进度，不能冒充摄影师或泄露给其他人', async () => {
    expect((await request('viewer', 'PUT', { ids: ['A'], seen: true, actor: 'admin' })).status).toBe(200);
    expect(await (await request('viewer')).json()).toEqual({ reviewed: ['A'] });
    expect(await (await request('admin')).json()).toEqual({ reviewed: [] });
    expect(await (await request('editor')).json()).toEqual({ reviewed: [] });
    expect(session.markStore.data.marks).toEqual({});
  });
  it('进度在关闭并重开照片目录后保留，可以独立恢复未看', async () => {
    await closeSession(session.id); session = await openSession(root);
    expect(await (await request('viewer')).json()).toEqual({ reviewed: ['A'] });
    expect((await request('viewer', 'PUT', { ids: ['A'], seen: false })).status).toBe(200);
    expect(await (await request('viewer')).json()).toEqual({ reviewed: [] });
  });
  it('混入不存在的照片时整批拒绝，无身份请求不能读写', async () => {
    expect((await request('editor', 'PUT', { ids: ['A', 'missing'], seen: true })).status).toBe(400);
    expect(await (await request('editor')).json()).toEqual({ reviewed: [] });
    expect((await request('none')).status).toBe(401);
  });
  it('实时进度只发给同一人的连接', async () => {
    const own = [], other = [];
    const listeners = [
      { actor: { kind: 'user', user: users.editor }, send: (event) => own.push(event) },
      { actor: { kind: 'admin' }, send: (event) => other.push(event) },
    ];
    for (const listener of listeners) session.listeners.add(listener);
    try {
      await request('editor', 'PUT', { ids: ['B'], seen: true });
      expect(own).toEqual([{ type: 'review', ids: ['B'], seen: true }]);
      expect(other).toEqual([]);
    } finally { for (const listener of listeners) session.listeners.delete(listener); }
  });
});
