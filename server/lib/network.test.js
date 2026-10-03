import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { NetworkController } from './network.js';
import { createApp, listenWithFallback, setNetworkController } from '../index.js';
import { createShare } from './shares.js';
vi.mock('./netaddr.js', () => ({ lanAddresses: () => [{ address: '192.168.1.55', family: 'IPv4', interface: 'test' }] }));
const active = [];
let temp, oldHome;
beforeEach(async () => { temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-network-')); oldHome = process.env.PHOTOCULL_HOME; process.env.PHOTOCULL_HOME = temp; });
afterEach(async () => {
  setNetworkController(null); for (const controller of active.splice(0)) await controller.close();
  if (oldHome === undefined) delete process.env.PHOTOCULL_HOME; else process.env.PHOTOCULL_HOME = oldHome;
  await fs.rm(temp, { recursive: true, force: true }); vi.restoreAllMocks();
});
async function fixture(app) {
  const local = await listenWithFallback(app, 0, 1, '127.0.0.1');
  const listen = vi.fn(listenWithFallback), controller = new NetworkController(app, local, listen); active.push(controller);
  return { controller, listen, base: `http://127.0.0.1:${local.address().port}` };
}
describe('局域网分享运行时开关', () => {
  it('二维码只编码当前分享的真实监听端口，未开启或未知网卡地址不生成二维码', async () => {
    const { controller, base } = await fixture(createApp()); setNetworkController(controller);
    const share = await createShare({ root: temp });
    const url = `${base}/api/admin/share-qr?id=${share.id}&address=192.168.1.55`;
    expect((await fetch(url)).status).toBe(409);
    await controller.setEnabled(true);
    expect((await fetch(`${base}/api/admin/share-qr?id=${share.id}&address=untrusted.example`)).status).toBe(400);
    const encoder = vi.spyOn(QRCode, 'toString'); const response = await fetch(url);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('<svg');
    expect(encoder.mock.calls[0][0]).toBe(`http://192.168.1.55:${controller.port}/s/${share.token}`);
  });
  it('默认仅本机，并发开启只建一个监听；关闭后真实端口与访客连接关闭，本机继续响应', async () => {
    const app = express(); app.get('/test', (_req, res) => res.json({ ok: true }));
    app.get('/stream', (_req, res) => { res.set('Content-Type', 'text/event-stream'); res.write('data: ready\n\n'); });
    const { controller, listen, base } = await fixture(app);
    expect(controller.enabled).toBe(false); expect(controller.port).toBeNull();
    await Promise.all([controller.setEnabled(true), controller.setEnabled(true)]);
    expect(listen).toHaveBeenCalledTimes(1); expect(listen.mock.calls[0][3]).toBe('0.0.0.0');
    const lan = `http://127.0.0.1:${controller.port}`;
    expect((await (await fetch(lan + '/test')).json()).ok).toBe(true);
    const response = await fetch(lan + '/stream');
    const reader = response.body.getReader(); await reader.read();
    const ended = reader.read().catch(() => ({ done: true }));
    await controller.setEnabled(false); expect((await ended).done).toBe(true);
    await expect(fetch(lan + '/test')).rejects.toThrow();
    expect((await (await fetch(base + '/test')).json()).ok).toBe(true);
    await controller.setEnabled(true); expect(controller.enabled).toBe(true);
  });
  it('开启失败保留本机服务，后续可以重试', async () => {
    const app = express(); app.get('/test', (_req, res) => res.send('alive'));
    const { controller, listen, base } = await fixture(app);
    listen.mockRejectedValueOnce(new Error('端口被占用'));
    await expect(controller.setEnabled(true)).rejects.toThrow('端口被占用'); expect(controller.enabled).toBe(false);
    expect(await (await fetch(base + '/test')).text()).toBe('alive');
    await controller.setEnabled(true); expect(controller.enabled).toBe(true);
  });
  it('真实 API 返回实际分享端口，参数不合法时不开放网络，关闭后不再展示可分享链接', async () => {
    const { controller, base } = await fixture(createApp()); setNetworkController(controller);
    const put = (body) => fetch(base + '/api/admin/network', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await put({ enabled: 'yes' })).status).toBe(400); expect(controller.enabled).toBe(false);
    const enabled = await (await put({ enabled: true })).json(); expect(enabled.share).toBe(true); expect(enabled.port).toBe(controller.port);
    expect((await (await fetch(base + '/api/admin/netaddr')).json()).port).toBe(enabled.port);
    expect((await (await put({ enabled: false })).json()).share).toBe(false);
  });
});
