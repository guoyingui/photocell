import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.js';
import { closeAllSessions, closeSession, openSession } from '../lib/session.js';
import { createShare, updateShare } from '../lib/shares.js';
import { createUser } from '../lib/users.js';
import { resolveExportScope } from '../../shared/exportScope.js';

let temp, root, savedHome, session, share, server, base, users;
const request = (who, url, method = 'GET', body) => fetch(base + '/api/library' + url, {
  method, headers: { 'Content-Type': 'application/json', 'X-PhotoCull-Session': session.id,
    'X-Test-Identity': who, ...(users[who] ? { cookie: `pc_user=${users[who].token}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe('摄影师最终名单', () => {
  it('客户只收到自己的原始意见，最终决定不变时仍可同步自己的意见', async () => {
    await mark('alice', { A: 'reject' }); await mark('bob', { B: 'pick' });
    await request('admin', '/final-marks', 'PUT', { marks: { A: 'pick' } });
    for (const showPeerMarks of [true, false]) {
      await updateShare(share.id, { showPeerMarks });
      const body = await (await request('alice', '/marks')).json();
      expect(body.marks.A).toBe('pick'); expect(body.contrib).toBeUndefined();
      expect(body.ownContrib).toEqual({ A: { mark: 'reject', at: expect.any(Number) } });
      expect(JSON.stringify(body.ownContrib)).not.toContain(users.bob.id);
    }
    const events = { alice: [], bob: [] };
    const listeners = Object.keys(events).map((who) => ({
      actor: { kind: 'user', user: users[who], share: { ...share, showPeerMarks: false } },
      send: (event) => events[who].push(event),
    }));
    listeners.forEach((listener) => session.listeners.add(listener));
    try {
      const cleared = await (await mark('alice', { A: null })).json();
      expect(cleared.marks.A).toBe('pick'); expect(cleared.ownContrib).toEqual({});
      const event = events.alice.find((value) => value.type === 'marks');
      expect(event.changes).toEqual({});
      expect(event.ownContribChanges).toEqual({ A: { mark: null, at: expect.any(Number) } });
      expect(events.bob.filter((value) => value.type === 'marks')).toEqual([]);
    } finally { listeners.forEach((listener) => session.listeners.delete(listener)); }
  });
  it('最终决定保留客户意见，其他客户继续投票不会改动最终名单和导出结果', async () => {
    await mark('alice', { A: 'pick' }); await mark('bob', { A: 'reject' });
    expect((await request('alice', '/final-marks', 'PUT', { marks: { A: 'pick' } })).status).toBe(403);
    expect((await request('admin', '/final-marks', 'PUT', { marks: { A: 'pick' } })).status).toBe(200);
    await mark('bob', { A: null }); await mark('bob', { A: 'reject' });
    expect(session.markStore.data.marks.A).toBe('pick');
    expect(session.markStore.data.contrib.A[users.bob.id].mark).toBe('reject');
    expect(resolveExportScope(session.assets, session.markStore.data).marks.A).toBe('pick');
    await closeSession(session.id); session = await openSession(root);
    expect(session.markStore.data.marks.A).toBe('pick');
    expect((await request('admin', '/final-marks', 'PUT', { marks: { A: null } })).status).toBe(200);
    expect(session.markStore.data.marks.A).toBe('reject');
  });
  it('没有原始意见的最终决定在重启后清除时，不会被误迁移成摄影师投票', async () => {
    await request('admin', '/final-marks', 'PUT', { marks: { C: 'pick' } });
    await closeSession(session.id); session = await openSession(root);
    expect(session.markStore.data.contrib.C).toBeUndefined();
    await request('admin', '/final-marks', 'PUT', { marks: { C: null } });
    expect(session.markStore.data.marks.C).toBeUndefined();
    expect((await request('admin', '/final-marks', 'PUT', { marks: { A: 'pick', missing: 'pick' } })).status).toBe(400);
    expect(session.markStore.data.finalMarks.A).toBeUndefined();
  });
});
const mark = (who, marks) => request(who, '/marks', 'PUT', { marks });
const own = async (who) => (await (await request(who, '/selection')).json()).selection;
beforeEach(async () => {
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-selections-')));
  root = path.join(temp, 'photos'); await fs.mkdir(root);
  savedHome = process.env.PHOTOCULL_HOME; process.env.PHOTOCULL_HOME = path.join(temp, 'home');
  for (const id of ['A', 'B', 'C']) await fs.writeFile(path.join(root, `${id}.CR3`), id);
  session = await openSession(root); share = await createShare({ root, selectionLimit: 2 });
  users = { alice: await createUser(share.id, '客户甲', 'editor'),
    bob: await createUser(share.id, '客户乙', 'editor'), viewer: await createUser(share.id, '只读', 'viewer') };
  const app = createApp();
  server = http.createServer((req, res) => {
    delete req.socket.remoteAddress;
    if (req.headers['x-test-identity'] !== 'admin') Object.defineProperty(req.socket, 'remoteAddress', {
      value: '192.168.1.55', configurable: true });
    app(req, res);
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await closeAllSessions();
  await new Promise((resolve) => server.close(resolve));
  if (savedHome === undefined) delete process.env.PHOTOCULL_HOME; else process.env.PHOTOCULL_HOME = savedHome;
  await fs.rm(temp, { recursive: true, force: true });
});

describe('客户提交、锁定和摄影师确认', () => {
  it('按自己的收藏计数，整批超限拒绝，减少收藏后可继续选择', async () => {
    expect((await mark('alice', { A: 'pick', B: 'pick' })).status).toBe(200);
    expect((await mark('bob', { A: 'reject' })).status).toBe(200);
    expect((await own('alice')).pickedIds).toEqual(['A', 'B']);
    expect((await mark('alice', { A: null, B: 'pick', C: 'pick' })).status).toBe(200);
    expect((await mark('alice', { A: 'pick', C: 'reject' })).status).toBe(200);
    expect((await mark('alice', { C: 'pick' })).status).toBe(400);
    expect((await own('alice')).pickedIds).toEqual(['A', 'B']);
    expect((await own('bob')).selectedCount).toBe(0);
  });
  it('备注与提交持久化，其他人的标记不改提交，确认后只由摄影师重新开放', async () => {
    await mark('alice', { A: 'pick', B: 'pick' });
    await request('alice', '/selection', 'PUT', { note: '自然肤色', photoNotes: { A: '保留表情', B: '去掉背景杂物' }, userId: users.bob.id });
    const draft = await own('alice');
    expect((await request('alice', '/selection/submit', 'POST', { assetIds: ['A', 'C'], revision: draft.revision })).status).toBe(409);
    expect((await request('alice', '/selection/submit', 'POST', { assetIds: draft.pickedIds, revision: draft.revision })).status).toBe(200);
    expect((await mark('alice', { A: null })).status).toBe(409);
    expect((await request('alice', '/selection', 'PUT', { note: '修改' })).status).toBe(409);
    await mark('bob', { A: 'reject', B: 'reject' });
    await closeSession(session.id); session = await openSession(root);
    const locked = await own('alice');
    expect(locked).toMatchObject({ status: 'submitted', pickedIds: ['A', 'B'], note: '自然肤色', photoNotes: { A: '保留表情' } });
    expect((await request('bob', `/selections/${users.alice.id}/reopen`, 'POST', {})).status).toBe(403);
    expect((await request('admin', `/selections/${users.alice.id}/confirm`, 'POST', {})).status).toBe(200);
    expect((await own('alice')).status).toBe('confirmed');
    expect((await mark('alice', { A: null })).status).toBe(409);
    expect((await request('admin', `/selections/${users.alice.id}/reopen`, 'POST', {})).status).toBe(200);
    expect((await mark('alice', { A: null, C: 'pick' })).status).toBe(200);
    const listed = await (await request('admin', '/selections')).json();
    expect(listed.selections.find((entry) => entry.userId === users.alice.id).pickedIds).toEqual(['B', 'C']);
    expect(JSON.stringify(listed)).not.toContain(users.alice.token);
  });
  it('备注只发给本人，摄影师收到更新通知，只读和无身份不能提交', async () => {
    const events = { own: [], other: [], admin: [] };
    const listeners = [
      { actor: { kind: 'user', user: users.alice, share }, send: (event) => events.own.push(event) },
      { actor: { kind: 'user', user: users.bob, share }, send: (event) => events.other.push(event) },
      { actor: { kind: 'admin' }, send: (event) => events.admin.push(event) },
    ];
    listeners.forEach((listener) => session.listeners.add(listener));
    try {
      await request('alice', '/selection', 'PUT', { note: '只有摄影师应该看到的备注' });
      expect(events.own[0].selection.note).toContain('备注');
      expect(events.other).toEqual([]);
      expect(events.admin).toEqual([{ type: 'selection-updated', userId: users.alice.id }]);
      expect((await own('bob')).note).toBe('');
      expect((await request('viewer', '/selection/submit', 'POST', {})).status).toBe(403);
      expect((await request('none', '/selection', 'PUT', { note: '冒充' })).status).toBe(401);
    } finally { listeners.forEach((listener) => session.listeners.delete(listener)); }
  });
  it('并发收藏不能绕过数量上限，并发提交与修改不会产生锁定后仍可修改的窗口', async () => {
    await updateShare(share.id, { selectionLimit: 1 });
    const results = await Promise.all([mark('alice', { A: 'pick' }), mark('alice', { B: 'pick' })]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 400]);
    const draft = await own('alice'); expect(draft.selectedCount).toBe(1);
    const id = draft.pickedIds[0];
    const [submitted, changed] = await Promise.all([
      request('alice', '/selection/submit', 'POST', { assetIds: draft.pickedIds, revision: draft.revision }),
      mark('alice', { [id]: null }),
    ]);
    if (submitted.status === 200) {
      expect(changed.status).toBe(409); expect((await own('alice')).pickedIds).toEqual([id]);
    } else {
      expect([400, 409]).toContain(submitted.status); expect(changed.status).toBe(200);
      expect((await own('alice')).status).toBe('draft');
    }
  });
});
