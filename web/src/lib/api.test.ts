import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getJSON, putJSON, patchJSON, deleteJSON, openStream, setSessionId, getSessionId, withSid,
  setSessionGoneHandler, type ApiError,
} from './api';
import { thumbUrl, originalUrl } from './thumbSource';

let streams: FakeEventSource[];

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(public url: string) { streams.push(this); }
  close() { /* 测试里不关心 */ }
}

/** 拿到一个必定 reject 的请求的错误对象；没 reject 就直接把测试判失败。 */
async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('这个请求本该失败');
}

function replyWith(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    json: async () => body,
  })));
}

beforeEach(() => {
  streams = [];
  setSessionId(null);
  setSessionGoneHandler(null);
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  setSessionId(null);
  setSessionGoneHandler(null);
  vi.unstubAllGlobals();
});

describe('会话 id 的注入', () => {
  it('没有会话时不加请求头，也不动 URL', async () => {
    replyWith(200, { ok: true });
    await getJSON('/api/library/assets');
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-PhotoCull-Session']).toBeUndefined();
    expect(withSid('/api/thumb?id=x')).toBe('/api/thumb?id=x');
  });

  it('设了会话之后 fetch 带 X-PhotoCull-Session 头', async () => {
    setSessionId('sid-1');
    replyWith(200, { ok: true });
    await putJSON('/api/library/marks', { marks: {} });
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-PhotoCull-Session']).toBe('sid-1');
    // 原有的 content-type 不能被覆盖掉
    expect(headers['content-type']).toBe('application/json');
    expect(getSessionId()).toBe('sid-1');
  });

  it('withSid 对已有查询串用 &、对没有的用 ?，并转义', () => {
    setSessionId('a/b c');
    expect(withSid('/api/thumb?id=x&tier=grid')).toBe('/api/thumb?id=x&tier=grid&sid=a%2Fb%20c');
    expect(withSid('/api/library/stream')).toBe('/api/library/stream?sid=a%2Fb%20c');
  });

  it('缩略图与原图 URL 走查询参数带会话（<img src> 设不了请求头）', () => {
    setSessionId('sid-1');
    expect(thumbUrl('IMG_0002')).toBe('/api/thumb?id=IMG_0002&tier=grid&sid=sid-1');
    expect(thumbUrl('IMG_0002', 'preview')).toBe('/api/thumb?id=IMG_0002&tier=preview&sid=sid-1');
    expect(originalUrl('IMG_0002')).toBe('/api/original?id=IMG_0002&sid=sid-1');
  });

  it('SSE URL 同样带会话', () => {
    setSessionId('sid-1');
    openStream('/api/library/stream', () => {});
    expect(streams[0].url).toBe('/api/library/stream?sid=sid-1');
  });

  // PATCH / DELETE 以前是 SharePanel 自己那份 fetch 封装，Task 17 并了回来。
  // 并回来的意义就在这两条：会话头和 409 session-gone 的全局复位，
  // 原来那份都没有（少一处，就是少一处能悄悄绕过 CSRF 第二道防线的地方）。
  it('patchJSON / deleteJSON 同样带 X-PhotoCull-Session 头', async () => {
    setSessionId('sid-1');
    replyWith(200, { ok: true });
    await patchJSON('/api/admin/shares/sh_1', { allowUserCreation: false });
    await deleteJSON('/api/admin/shares/sh_1');

    const headersOf = (i: number) =>
      (vi.mocked(fetch).mock.calls[i][1] as RequestInit).headers as Record<string, string>;
    expect(headersOf(0)['X-PhotoCull-Session']).toBe('sid-1');
    expect(headersOf(1)['X-PhotoCull-Session']).toBe('sid-1');
  });

  it('patchJSON 带 JSON 请求体；deleteJSON 不带 body，也不声明 content-type', async () => {
    replyWith(200, { ok: true });
    await patchJSON('/api/admin/shares/sh_1', { allowUserCreation: false });
    await deleteJSON('/api/admin/shares/sh_1');

    const patchInit = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(patchInit.method).toBe('PATCH');
    expect(patchInit.body).toBe(JSON.stringify({ allowUserCreation: false }));
    expect((patchInit.headers as Record<string, string>)['content-type']).toBe('application/json');

    const deleteInit = vi.mocked(fetch).mock.calls[1][1] as RequestInit;
    expect(deleteInit.method).toBe('DELETE');
    expect(deleteInit.body).toBeUndefined();
    // 带一个空 body 的 content-type 只会让中间件去解析一段不存在的负载。
    expect((deleteInit.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('patchJSON / deleteJSON 的错误走同一套解析（message 优先）', async () => {
    replyWith(403, { error: 'not-admin', message: '只有本机可以管理分享' });
    const err = await failure(patchJSON('/api/admin/shares/sh_1', {}));
    expect(err.message).toBe('只有本机可以管理分享');
    expect(err.code).toBe('not-admin');
    expect(err.status).toBe(403);
  });
});

describe('SSE 的 onOpen（重连补拉的挂点）', () => {
  it('连接建立时触发；EventSource 每次自动重连成功都会再触发一次', () => {
    const onOpen = vi.fn();
    openStream('/api/library/stream', () => {}, onOpen);

    streams[0].onopen?.();
    expect(onOpen).toHaveBeenCalledTimes(1);
    // 断线之后 EventSource 自己重连，连上时会再触发一次 —— 这一次正是
    // "全量补拉断开期间漏掉的标记"唯一的时机。
    streams[0].onerror?.();
    streams[0].onopen?.();
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('不传 onOpen 时连接建立不抛异常', () => {
    openStream('/api/library/stream', () => {});
    expect(() => streams[0].onopen?.()).not.toThrow();
  });
});

describe('错误响应的解析', () => {
  it('结构化错误：message 是给人看的话，error 是机器码', async () => {
    replyWith(400, {
      error: 'not-writable',
      message: '这个文件夹不可写，选片进度和缩略图缓存都无法保存。',
      detail: "EACCES: permission denied, mkdir '/card/.photocull'",
    });
    const err = await failure(getJSON('/x'));
    expect(err.message).toBe('这个文件夹不可写，选片进度和缩略图缓存都无法保存。');
    expect(err.code).toBe('not-writable');
    expect(err.detail).toContain('EACCES');
    expect(err.status).toBe(400);
  });

  it('旧形状（只有 error，里面就是人话）仍然原样透出', async () => {
    replyWith(403, { error: '路径超出允许范围' });
    const err = await failure(getJSON('/x'));
    expect(err.message).toBe('路径超出允许范围');
  });

  it('机器码放在 code 字段时也认得出来', async () => {
    replyWith(409, { error: '正在移动文件，请稍后再切换文件夹', code: 'move-in-progress' });
    const err = await failure(getJSON('/x'));
    expect(err.message).toBe('正在移动文件，请稍后再切换文件夹');
    expect(err.code).toBe('move-in-progress');
  });

  it('响应体不是 JSON 时退回状态文本', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 502, statusText: 'HTTP 502',
      json: async () => { throw new Error('not json'); },
    })));
    const err = await failure(getJSON('/x'));
    expect(err.message).toBe('HTTP 502');
  });
});

describe('409 session-gone 的全局钩子', () => {
  it('命中时触发一次，并且照样把错误抛给调用方', async () => {
    const onGone = vi.fn();
    setSessionGoneHandler(onGone);
    replyWith(409, { error: 'session-gone', message: '会话已失效或已被替换，请重新打开文件夹' });

    await expect(getJSON('/api/library/assets')).rejects.toThrow();
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it('别的 409（比如 move 任务在跑）不触发', async () => {
    const onGone = vi.fn();
    setSessionGoneHandler(onGone);
    replyWith(409, { error: '正在移动文件（会删除源文件）', code: 'move-in-progress' });

    await expect(getJSON('/api/library/close')).rejects.toThrow();
    expect(onGone).not.toHaveBeenCalled();
  });

  it('别的状态码带同一个 error 码也不触发', async () => {
    const onGone = vi.fn();
    setSessionGoneHandler(onGone);
    replyWith(500, { error: 'session-gone' });

    await expect(getJSON('/x')).rejects.toThrow();
    expect(onGone).not.toHaveBeenCalled();
  });
});
