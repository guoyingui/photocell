/** 服务端结构化错误：{ error: <机器码>, message: <给人看的话>, detail? }。 */
export interface ApiError extends Error {
  status?: number;
  /** 机器可判定的错误码，来自响应体的 `error` 字段（如 'session-gone' / 'not-writable'）。 */
  code?: string;
  detail?: string;
  /**
   * 解析出来的整个错误响应体。
   *
   * status / code / message / detail 是每种错误都有的那几样，单独提出来；
   * 某些错误还会多带几个**机器可判定**的字段（`guests-online` 的 `online` 就是
   * 在线人数），它们没有必要每来一个就往这个接口上加一行。调用方自己按
   * `typeof` 收窄——不 `as`，因为这份东西完全由服务端决定形状。
   * 响应体不是 JSON 时是 `{}`，永远不会是 undefined。
   */
  body?: Record<string, unknown>;
}

// 当前会话 id。openSession 的响应写入，close()/会话失效时清空。
//
// 服务端认两条通道，但**不是平权的**（CSRF 第二道防线，见 middleware/auth.js）：
//   - `X-PhotoCull-Session` 请求头：所有方法都认。fetch 走这条（下面的 req()）。
//   - `?sid=` 查询参数：**只有 GET / HEAD 认**。它存在的唯一理由是 <img src> 和
//     EventSource 设不了请求头，而那两者发出来的都是 GET。
// 所以 withSid() 只该用在缩略图 / 原图 / SSE 这三类 URL 上；任何写请求都必须
// 走 req()，靠请求头带会话——非 GET 带着 ?sid= 会被服务端 403 csrf-header-required。
let sessionId: string | null = null;

export function setSessionId(id: string | null) { sessionId = id; }
export function getSessionId(): string | null { return sessionId; }

/**
 * 给一个前端自己拼出来、不经过 fetch 的 URL 追加 sid 查询参数。
 * 缩略图 / 原图 / SSE 三类 URL 都必须过这个函数，否则服务端会当成无会话请求 409。
 *
 * **只用于 GET。** 服务端对非 GET 请求不认 `?sid=`（见上面那段注释）。
 */
export function withSid(url: string): string {
  if (!sessionId) return url;
  return `${url}${url.includes('?') ? '&' : '?'}sid=${encodeURIComponent(sessionId)}`;
}

// 会话失效（HTTP 409 且 error === 'session-gone'）是一个全局事件：不管是哪一个
// 请求撞上的，整个前端都必须退回选择器。这里用「注册回调」而不是让 api.ts 直接
// import store/library.ts —— 后者依赖 api.ts，直接 import 会形成模块环。
let onSessionGone: (() => void) | null = null;
export function setSessionGoneHandler(fn: (() => void) | null) { onSessionGone = fn; }

async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (sessionId) headers['X-PhotoCull-Session'] = sessionId;

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body: Record<string, unknown> = await res.json().catch(() => ({}));
    // 结构化错误里 error 是机器码、message 才是给人看的话；旧的错误中间件只有
    // { error: <给人看的话> }。所以 message 优先，两者都没有才退回状态文本。
    const message = typeof body.message === 'string' ? body.message
      : typeof body.error === 'string' ? body.error
        : res.statusText;
    const err: ApiError = Object.assign(new Error(message), {
      status: res.status,
      // 服务端有两种错误形状：结构化的把机器码放在 error、人话放在 message；
      // 另一些把人话放在 error、机器码放在 code。两个位置都认。
      code: typeof body.code === 'string' ? body.code
        : typeof body.error === 'string' ? body.error : undefined,
      detail: typeof body.detail === 'string' ? body.detail : undefined,
      body,
    });
    if (res.status === 409 && err.code === 'session-gone') onSessionGone?.();
    throw err;
  }
  return res;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  return (await request(path, init)).json() as Promise<T>;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const getJSON = <T,>(path: string) => req<T>(path);
export const postJSON = <T,>(path: string, body: unknown = {}) => req<T>(path, jsonInit('POST', body));
export const putJSON = <T,>(path: string, body: unknown = {}) => req<T>(path, jsonInit('PUT', body));
export const patchJSON = <T,>(path: string, body: unknown = {}) => req<T>(path, jsonInit('PATCH', body));
// DELETE 不带请求体，因此也不设 content-type——带一个空 body 的 content-type
// 只会让某些代理和中间件去解析一段不存在的负载。
export const deleteJSON = <T,>(path: string) => req<T>(path, { method: 'DELETE' });
export const postBlob = async (path: string, body: unknown): Promise<Blob> =>
  (await request(path, jsonInit('POST', body))).blob();

/**
 * 订阅 SSE，返回取消订阅函数。
 *
 * `onOpen` 在连接建立时触发——**包括 EventSource 自己完成的每一次重连**。
 * 这是"断线期间漏掉的东西"唯一的补救挂点：SSE 只推增量，连接断开的那段时间
 * 里别人做的标记不会在重连后补发，不趁这个时机全量拉一次，两边就会一直不一致，
 * 而且不会有任何报错提示这件事正在发生。
 */
export function openStream(
  path: string,
  onEvent: (event: any) => void,
  onOpen?: () => void,
): () => void {
  const source = new EventSource(withSid(path));
  source.onmessage = (e) => {
    try { onEvent(JSON.parse(e.data)); } catch { /* 忽略心跳等非 JSON 帧 */ }
  };
  source.onopen = () => { onOpen?.(); };
  // EventSource 会自动重连，但调用方需要知道连接目前不健康，
  // 所以把错误也当作一个事件转发出去，交给 onEvent 的调用方决定怎么展示。
  source.onerror = () => { onEvent({ type: 'error' }); };
  return () => source.close();
}
