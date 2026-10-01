import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminDelete, adminGet, adminPatch, adminPost } from './adminApi';

// 这个模块只是 fetch 的一层极薄封装，专供 web/src/admin/* 使用——不复用
// web/src/lib/api.ts，因为那个文件同一时间被别的并行任务（SSE 重连回调、
// 管理令牌头）修改，管理后台这几个文件的改动不该跟它产生交集。管理员身份
// 由 TCP 源地址（回环）判定，这几个请求不需要会话 id 或 Cookie。

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('adminGet/adminPost/adminPatch/adminDelete', () => {
  it('GET 成功时返回解析后的 JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ shares: [] }),
    })));
    await expect(adminGet('/api/admin/shares')).resolves.toEqual({ shares: [] });
  });

  it('POST 发送 JSON 请求体和 content-type 头', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    await adminPost('/api/admin/shares', { root: '/tmp/x', label: 'L' });
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/shares', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: '/tmp/x', label: 'L' }),
    }));
  });

  it('PATCH 发送 JSON 请求体', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    await adminPatch('/api/admin/shares/sh_1/users/u_1', { role: 'viewer' });
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/shares/sh_1/users/u_1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ role: 'viewer' }),
    }));
  });

  it('DELETE 不带请求体', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    await adminDelete('/api/admin/shares/sh_1');
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/shares/sh_1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('非 2xx 响应抛出的错误里带着服务端的 message 和机器码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 409, json: async () => ({ error: 'nickname-taken', message: '这个昵称已经有人在用了' }),
    })));
    await expect(adminGet('/api/admin/shares/sh_1/users')).rejects.toMatchObject({
      status: 409, code: 'nickname-taken', message: '这个昵称已经有人在用了',
    });
  });

  it('响应体不是合法 JSON 时仍能拿到状态码，不额外抛出解析错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500, statusText: 'Internal Server Error',
      json: async () => { throw new Error('not json'); },
    })));
    await expect(adminGet('/api/admin/shares')).rejects.toMatchObject({ status: 500 });
  });
});
