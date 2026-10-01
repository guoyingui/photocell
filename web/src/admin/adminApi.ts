/**
 * 管理后台专用的最小 fetch 封装。
 *
 * 不复用 `web/src/lib/api.ts` 是一个**边界**决定，不是回避冲突：
 * `/admin` 这条入口不开库、没有会话，管理员身份完全由 TCP 源地址（回环）
 * 判定，既不读 Cookie 也不需要 `X-PhotoCull-Session`。lib/api.ts 的 `req()`
 * 围绕"当前会话"建了一整套状态（注入会话头、409 `session-gone` 时触发全局
 * 复位退回文件夹选择器），那套东西在这里一条都用不上——真接上去，管理后台
 * 反而会因为一个它根本没有的会话概念而被复位。
 *
 * 代价是错误解析这一段两边各有一份（都是"message 优先、其次 error、
 * 最后 statusText"）。这段重复是有意留下的：它换来的是管理后台不依赖
 * 会话状态这条更值钱的性质，而且它有 `adminApi.test.ts` 完整覆盖。
 */
export interface AdminApiError extends Error {
  status?: number;
  code?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    // 服务端的错误体形如 { error: <机器码>, message: <给人看的话> }
    // （见 server/routes/admin.js 的 badRequest / 各处 res.status(...).json(...)）。
    // 响应体解析失败（比如 500 时中间件吐的不是这个形状，或者根本不是 JSON）
    // 时兜底成 {}，不让"报错的过程本身又抛错"。
    const body: Record<string, unknown> = await res.json().catch(() => ({}));
    const message = typeof body.message === 'string' ? body.message
      : typeof body.error === 'string' ? body.error
        : res.statusText;
    const err: AdminApiError = Object.assign(new Error(message), {
      status: res.status,
      code: typeof body.error === 'string' ? body.error : undefined,
    });
    throw err;
  }
  return res.json() as Promise<T>;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const adminGet = <T,>(path: string) => request<T>(path);
export const adminPost = <T,>(path: string, body: unknown = {}) => request<T>(path, jsonInit('POST', body));
export const adminPatch = <T,>(path: string, body: unknown) => request<T>(path, jsonInit('PATCH', body));
export const adminDelete = <T,>(path: string) => request<T>(path, { method: 'DELETE' });
