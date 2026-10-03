import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.js';
import { closeAllSessions, openSession } from '../lib/session.js';
import { createShare } from '../lib/shares.js';
import { createUser } from '../lib/users.js';
import { readAnnotations } from '../lib/annotations.js';
import { buildXmp, crc32, zipFiles } from '../lib/xmp.js';

let temp, root, oldHome, session, users, server, base;
const request = (who, url, method = 'GET', body) => fetch(base + url, { method,
  headers: { 'Content-Type': 'application/json', 'X-PhotoCull-Session': session.id, 'X-Test-Identity': who,
    ...(users[who] ? { cookie: `pc_user=${users[who].token}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
beforeEach(async () => {
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-annotations-')));
  root = path.join(temp, 'photos'); await fs.mkdir(path.join(root, '婚礼'), { recursive: true });
  oldHome = process.env.PHOTOCULL_HOME; process.env.PHOTOCULL_HOME = path.join(temp, 'home');
  await fs.writeFile(path.join(root, 'A.CR3'), 'raw'); await fs.writeFile(path.join(root, '婚礼', 'A.NEF'), 'raw');
  session = await openSession(root); const share = await createShare({ root });
  users = { editor: await createUser(share.id, '编辑', 'editor'), viewer: await createUser(share.id, '只读', 'viewer') };
  const app = createApp(); server = http.createServer((req, res) => {
    delete req.socket.remoteAddress;
    if (req.headers['x-test-identity'] !== 'admin') Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.1.55', configurable: true });
    app(req, res);
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await closeAllSessions(); await new Promise((resolve) => server.close(resolve));
  if (oldHome === undefined) delete process.env.PHOTOCULL_HOME; else process.env.PHOTOCULL_HOME = oldHome;
  await fs.rm(temp, { recursive: true, force: true });
});
const save = (ids, patch, who = 'admin') => request(who, '/api/library/annotations', 'PUT', { ids, patch });

describe('后期元数据与 XMP', () => {
  it('部分更新并发保存不覆盖其他字段，重新打开后仍可读取；访客只能读取', async () => {
    const id = session.assets.find((asset) => asset.dir === '').id;
    await Promise.all([save([id], { rating: 4 }), save([id], { stage: 'retouch', keywords: ['人像', '人像'] })]);
    const data = await readAnnotations(root);
    expect(data.annotations[id]).toEqual({ rating: 4, label: 'none', stage: 'retouch', keywords: ['人像'] });
    expect(data.revision).toBe(2);
    await closeAllSessions(); session = await openSession(root);
    expect((await (await request('viewer', '/api/library/annotations')).json()).annotations[id].rating).toBe(4);
    expect((await save([id], { rating: 1 }, 'editor')).status).toBe(403);
    expect((await request('viewer', '/api/export/xmp', 'POST', { assetIds: [id] })).status).toBe(403);
  });
  it('未知资产、无效星级和关键词整批拒绝，路径边界保护持久化目录', async () => {
    const id = session.assets[0].id;
    expect((await save([id, 'missing'], { rating: 3 })).status).toBe(400);
    expect((await save([id], { rating: 6 })).status).toBe(400);
    expect((await save([id], { keywords: ['x'.repeat(51)] })).status).toBe(400);
    expect((await readAnnotations(root)).annotations).toEqual({});
    const dir = path.join(root, '.photocull'); await fs.rm(dir, { recursive: true });
    await fs.mkdir(path.join(temp, 'escape')); await fs.symlink(path.join(temp, 'escape'), dir);
    expect((await save([id], { rating: 3 })).status).toBe(403);
    expect(await fs.readdir(path.join(temp, 'escape'))).toEqual([]);
  });
  it('ZIP 保留同名照片的相对目录、Unicode 文件名和标准星级；源照片与既有 XMP 不变', async () => {
    const ids = session.assets.map((asset) => asset.id);
    await save(ids, { rating: 5, label: 'green', stage: 'delivery', keywords: ['A&B <人像>'] });
    await fs.writeFile(path.join(root, 'A.xmp'), 'existing edits');
    const response = await request('admin', '/api/export/xmp', 'POST', { assetIds: ids });
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('application/zip');
    const zip = Buffer.from(await response.arrayBuffer()), entries = [];
    let offset = 0;
    while (zip.readUInt32LE(offset) === 0x04034b50) {
      const size = zip.readUInt32LE(offset + 18), length = zip.readUInt16LE(offset + 26);
      const name = zip.subarray(offset + 30, offset + 30 + length).toString('utf8');
      const body = zip.subarray(offset + 30 + length, offset + 30 + length + size);
      expect(crc32(body)).toBe(zip.readUInt32LE(offset + 14)); entries.push({ name, body: body.toString('utf8') }); offset += 30 + length + size;
    }
    expect(entries.map((entry) => entry.name).sort()).toEqual(['A.xmp', '婚礼/A.xmp']);
    expect(entries[0].body).toContain('xmp:Rating="5"'); expect(entries[0].body).toContain('xmp:Label="Green"');
    expect(entries[0].body).toContain('A&amp;B &lt;人像&gt;'); expect(entries[0].body).toContain('PhotoCull/交付');
    expect(await fs.readFile(path.join(root, 'A.CR3'), 'utf8')).toBe('raw');
    expect(await fs.readFile(path.join(root, 'A.xmp'), 'utf8')).toBe('existing edits');
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50); expect(zip.readUInt16LE(zip.length - 12)).toBe(2);
  });
  it('XML 转义和 ZIP 校验码符合独立已知值，拒绝重复名称和目录穿越', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(buildXmp({ keywords: ['"<人物>&\u0001'] })).toContain('&quot;&lt;人物&gt;&amp;');
    expect(() => zipFiles([{ name: '../escape.xmp', body: '' }])).toThrow('路径');
    expect(() => zipFiles([{ name: 'A.xmp', body: '' }, { name: 'a.xmp', body: '' }])).toThrow('路径');
  });
});
