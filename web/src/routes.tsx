import { App } from './App';
import { JoinGate } from './guest/JoinGate';
import { AdminApp } from './admin/AdminApp';

/**
 * 三条入口的判定结果。规格 §7.1：不引入路由库，三条路径、无嵌套、
 * 无参数解析，读 `location.pathname` 即可。
 *
 * - `local`：`/`，本地选片（现有全部功能），仅 admin 可用；
 * - `guest`：`/s/<token>`，访客选片；
 * - `admin`：`/admin`，管理后台；
 * - `notfound`：其它任何路径，包括 `/s/` 缺 token 的情形。
 */
export type Route = 'local' | 'guest' | 'admin' | 'notfound';

const GUEST_PREFIX = '/s/';

/** 纯函数：给一个 pathname，判定它落在哪一条入口。 */
export function routeFor(pathname: string): Route {
  if (pathname === '/') return 'local';
  if (pathname === '/admin') return 'admin';
  // 长度检查而不是只判断 startsWith：`/s/` 本身（没有 token）不算访客入口，
  // 落在这里就该是 notfound，而不是把空字符串当成一个合法 token 传下去。
  if (pathname.startsWith(GUEST_PREFIX) && pathname.length > GUEST_PREFIX.length) return 'guest';
  return 'notfound';
}

/**
 * 从访客路径里取出 token，原样返回，不做任何解码。
 * 令牌是 `crypto.randomBytes(32)` 的 base64url（43 字符，含 `-` 和 `_`），
 * 这两个字符本身就在 URL 安全字符集里，`decodeURIComponent` 之类的处理
 * 只会在猜错编码时把一个合法字符改写成别的东西——不做才是对的。
 * 非访客路径、或访客路径缺 token，返回 `null`。
 */
export function tokenFor(pathname: string): string | null {
  if (!pathname.startsWith(GUEST_PREFIX)) return null;
  const token = pathname.slice(GUEST_PREFIX.length);
  return token.length > 0 ? token : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 占位组件：/admin 目前还没有真正的界面（Task 19 的交付物）。这里只保证路由
// 能落地渲染点什么，不做任何交互或数据请求。
// `/s/<token>` 从 Task 15 起换上了真正的 JoinGate（见下方 Router）——它自己
// 处理昵称建号 / 回访恢复 / 各类拒绝文案；加入成功之后渲染什么由它的
// `children` 决定，目前没有传，等 Task 16 的 GuestApp 接上时再补。
// ─────────────────────────────────────────────────────────────────────────────

function PlaceholderScreen({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="route-placeholder">
      <h1>{title}</h1>
      <p>{detail}</p>
    </div>
  );
}

export function AdminPlaceholder() {
  return <PlaceholderScreen title="管理后台" detail="占位界面，完整界面见 Task 19。" />;
}

function NotFoundScreen() {
  return <PlaceholderScreen title="页面不存在" detail="这个地址没有对应的界面。" />;
}

/**
 * 顶层路由分发。main.tsx 用它替换掉原来直接渲染的 `<App/>`。
 *
 * `pathname` 由调用方传入而不是在这里读 `window.location`：这样测试
 * 不需要摆弄 jsdom 的 history/location，直接传不同字符串即可覆盖三条入口
 * 和 notfound。真正读 `location.pathname` 的地方只有 main.tsx 一处。
 */
export function Router({ pathname }: { pathname: string }) {
  const route = routeFor(pathname);
  switch (route) {
    case 'local': return <App />;
    case 'guest': return <JoinGate token={tokenFor(pathname)!} />;
    case 'admin': return <AdminApp />;
    case 'notfound': return <NotFoundScreen />;
  }
}
