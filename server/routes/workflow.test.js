import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { _test as exports } from './export.js';
import { createApp } from '../index.js';
import { closeAllSessions, closeSession, openSession } from '../lib/session.js';
import { createShare } from '../lib/shares.js';
import { createUser } from '../lib/users.js';
import { selectionDiff } from '../../shared/selectionVersions.js';

let temp, root, savedHome, session, server, base, user;
const request = (url, method = 'GET', body, guest = false) => fetch(base + '/api/library' + url, {
  method, headers: { 'Content-Type': 'application/json', 'X-PhotoCull-Session': session.id,
    ...(guest ? { 'X-Test-Guest': '1', cookie: `pc_user=${user.token}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const json = async (url, method, body, guest) => {
  const response = await request(url, method, body, guest);
  const data = await response.json(); expect(response.status, JSON.stringify(data)).toBe(200); return data;
};
beforeEach(async () => {
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-workflow-')));
  root = path.join(temp, 'photos'); await fs.mkdir(root);
  savedHome = process.env.PHOTOCULL_HOME; process.env.PHOTOCULL_HOME = path.join(temp, 'home');
  for (const id of ['A', 'B', 'C']) await fs.writeFile(path.join(root, `${id}.CR3`), id);
  session = await openSession(root);
  const share = await createShare({ root }); user = await createUser(share.id, '客户', 'editor');
  const app = createApp(); server = http.createServer((req, res) => {
    delete req.socket.remoteAddress;
    if (req.headers['x-test-guest']) Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.1.55', configurable: true });
    app(req, res);
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await closeAllSessions(); await new Promise((resolve) => server.close(resolve));
  if (savedHome === undefined) delete process.env.PHOTOCULL_HOME; else process.env.PHOTOCULL_HOME = savedHome;
  await fs.rm(temp, { recursive: true, force: true });
});

describe('连拍代表图与不可变选片版本', () => {
  it('代表图重开后保留，访客可读不可写，隐藏和未知照片被拒绝', async () => {
    await json('/burst-leaders', 'PUT', { key: 'A', id: 'B' });
    await closeSession(session.id); session = await openSession(root);
    expect((await json('/burst-leaders', 'GET', undefined, true)).leaders).toEqual({ A: 'B' });
    expect((await request('/burst-leaders', 'PUT', { key: 'A', id: 'C' }, true)).status).toBe(403);
    await json('/hidden', 'PUT', { ids: ['C'], hidden: true });
    expect((await request('/burst-leaders', 'PUT', { key: 'A', id: 'C' })).status).toBe(400);
    expect((await request('/burst-leaders', 'PUT', { key: 'missing', id: 'B' })).status).toBe(400);
  });
  it('提交、确认、重开、再次提交分别留存，备注变化和撤回可以比较', async () => {
    await json('/marks', 'PUT', { marks: { A: 'pick' } }, true);
    await json('/selection', 'PUT', { note: '第一轮', photoNotes: { A: '保留' } }, true);
    let own = (await json('/selection', 'GET', undefined, true)).selection;
    await json('/selection/submit', 'POST', { assetIds: own.pickedIds, revision: own.revision }, true);
    await json(`/selections/${user.id}/confirm`, 'POST');
    await json(`/selections/${user.id}/reopen`, 'POST');
    await json('/marks', 'PUT', { marks: { A: null, B: 'pick' } }, true);
    await json('/selection', 'PUT', { note: '第二轮', photoNotes: { A: '', B: '自然' } }, true);
    own = (await json('/selection', 'GET', undefined, true)).selection;
    await json('/selection/submit', 'POST', { assetIds: own.pickedIds, revision: own.revision }, true);
    await closeSession(session.id); session = await openSession(root);
    const versions = (await json('/versions')).versions;
    expect(versions).toHaveLength(4);
    const submits = versions.filter((v) => v.action === 'submit');
    expect(selectionDiff(submits[1], submits[0])).toEqual({ added: ['B'], removed: ['A'], noteChanged: true,
      photoNotes: [{ id: 'A', before: '保留', after: '' }, { id: 'B', before: '', after: '自然' }] });
    expect((await request('/versions', 'GET', undefined, true)).status).toBe(403);
  });
  it('最终决定快照独立于后续标记，清除最终决定保留历史', async () => {
    await json('/final-marks', 'PUT', { marks: { A: 'pick' } });
    await json('/final-marks', 'PUT', { marks: { A: null, B: 'pick' } });
    const versions = (await json('/versions')).versions;
    expect(versions.map((v) => v.pickedIds)).toEqual([['B'], ['A']]);
    expect(versions[1].finalMarks.A.mark).toBe('pick');
  });
});

describe('备份与恢复', () => {
  it('完整恢复四类数据及代表图，自动留存恢复前快照并使旧会话失效', async () => {
    await json('/marks', 'PUT', { marks: { A: 'pick' } });
    await json('/burst-leaders', 'PUT', { key: 'A', id: 'B' });
    await json('/annotations', 'PUT', { ids: ['A'], patch: { rating: 4 } });
    await json('/review', 'PUT', { ids: ['A'], seen: true });
    await json('/selection', 'PUT', { note: '原始备注' }, true);
    const { bundle } = await json('/backups', 'POST');
    expect(JSON.stringify(bundle)).not.toContain(user.token);
    await json('/marks', 'PUT', { marks: { A: 'reject', B: 'pick' } });
    await json('/annotations', 'PUT', { ids: ['A'], patch: { rating: 1 } });
    await json('/selection', 'PUT', { note: '新的备注' }, true);
    const preview = await json('/backups/preview', 'POST', { bundle });
    expect(preview.changes).toContain('客户提交与版本');
    const restored = await json('/backups/restore', 'POST', { bundle, token: preview.token, confirmName: 'photos' });
    expect((await request('/marks')).status).toBe(409);
    session = await openSession(root);
    expect((await json('/marks')).marks).toEqual({ A: 'pick' });
    expect((await json('/annotations')).annotations.A.rating).toBe(4);
    expect((await json('/selection', 'GET', undefined, true)).selection.note).toBe('原始备注');
    const safety = await json(`/backups/${restored.safetyId}`);
    expect(safety.data.marks.marks).toEqual({ A: 'reject', B: 'pick' });
    expect(safety.data.selections.people[user.id].note).toBe('新的备注');
    expect(await fs.readFile(path.join(root, 'A.CR3'), 'utf8')).toBe('A');
  });
  it('预览后并发修改、错误目录名、恶意包及不匹配目录均不写入', async () => {
    const { bundle } = await json('/backups', 'POST');
    const preview = await json('/backups/preview', 'POST', { bundle });
    expect((await request('/backups/restore', 'POST', { bundle, token: preview.token, confirmName: 'wrong' })).status).toBe(400);
    await json('/marks', 'PUT', { marks: { C: 'pick' } });
    expect((await request('/backups/restore', 'POST', { bundle, token: preview.token, confirmName: 'photos' })).status).toBe(409);
    const malicious = JSON.parse(JSON.stringify(bundle)); malicious.data.marks.finalHistory = [{ pickedIds: ['C'] }];
    expect((await request('/backups/preview', 'POST', { bundle: malicious })).status).toBe(400);
    malicious.data.marks = JSON.parse('{"__proto__":{"polluted":true}}');
    expect((await request('/backups/preview', 'POST', { bundle: malicious })).status).toBe(400);
    bundle.library.assetIds = ['other-folder/file'];
    expect((await request('/backups/preview', 'POST', { bundle })).status).toBe(400);
    expect((await json('/marks')).marks).toEqual({ C: 'pick' });
    expect({}.polluted).toBeUndefined();
  });
  it('恢复日志在重开时回滚不完整恢复，旧文件也可正常开库', async () => {
    await json('/marks', 'PUT', { marks: { A: 'pick' } });
    const { bundle } = await json('/backups', 'POST');
    await closeSession(session.id);
    await fs.writeFile(path.join(root, '.photocull/restore-pending.json'), JSON.stringify(bundle));
    await fs.writeFile(path.join(root, '.photocull/marks.json'), JSON.stringify({ marks: { B: 'reject' } }));
    session = await openSession(root);
    expect((await json('/marks')).marks).toEqual({ A: 'pick' });
    await expect(fs.stat(path.join(root, '.photocull/restore-pending.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('同一库请求等待实际处理完成，不因下一条请求而丢失并发标记', async () => {
    await Promise.all(['A', 'B', 'C'].map((id) => json('/marks', 'PUT', { marks: { [id]: 'pick' } })));
    const { bundle } = await json('/backups', 'POST');
    expect(bundle.data.marks.marks).toEqual({ A: 'pick', B: 'pick', C: 'pick' });
    expect((await json('/backups')).backups.filter((b) => b.reason === 'daily')).toHaveLength(1);
  });
  it('单次磁盘写入失败回滚所有文件，不留下半份恢复状态', async () => {
    await json('/marks', 'PUT', { marks: { A: 'pick' } });
    await json('/annotations', 'PUT', { ids: ['A'], patch: { rating: 4 } });
    const { bundle } = await json('/backups', 'POST');
    await json('/marks', 'PUT', { marks: { A: 'reject' } });
    const preview = await json('/backups/preview', 'POST', { bundle });
    const original = fs.rename.bind(fs); let failed = false;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (!failed && target === path.join(root, '.photocull/annotations.json')) {
        failed = true; throw Object.assign(new Error('模拟磁盘写入失败'), { code: 'EIO' });
      }
      return original(source, target);
    });
    try {
      expect((await request('/backups/restore', 'POST', { bundle, token: preview.token, confirmName: 'photos' })).status).toBe(500);
    } finally { spy.mockRestore(); }
    expect((await json('/marks')).marks).toEqual({ A: 'reject' });
    expect((await json('/annotations')).annotations.A.rating).toBe(4);
    await expect(fs.stat(path.join(root, '.photocull/restore-pending.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('复制或移动导出进行中不能恢复且保持当前数据', async () => {
    const { bundle } = await json('/backups', 'POST');
    const preview = await json('/backups/preview', 'POST', { bundle });
    for (const mode of ['copy', 'move']) {
      const job = exports.createJob(mode); job.root = session.root;
      try {
        expect((await request('/backups/restore', 'POST', { bundle, token: preview.token, confirmName: 'photos' })).status).toBe(409);
      } finally { exports.jobs.delete(job.id); }
    }
    expect((await json('/marks')).marks).toEqual({});
  });
  it('备份目录符号链接越界时拒绝', async () => {
    const dir = path.join(root, '.photocull/backups');
    await fs.rm(dir, { recursive: true });
    await fs.symlink(temp, dir);
    expect((await request('/backups', 'POST')).status).toBe(403);
    await fs.unlink(dir);
  });
});
