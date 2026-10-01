/**
 * 前端的路径处理。同时吃 `/` 和 `\` —— 服务端在 Windows 上给出来的路径是
 * `D:\照片\婚礼`，而前端拿不到 node 的 `path`，只能自己写。
 *
 * 大小写一律按原样比较，不做归一。两处调用点（`fsRoots.within`、
 * `TopBar` 的显示）拿到的路径两端都来自同一个服务端响应，不存在
 * 「一边大写一边小写」的情形；为一个不存在的输入引入归一，只会让
 * `D:\A` 和 `d:\a` 这种真正不同的输入被悄悄合并。
 */

/** 把反斜杠统一成正斜杠并剥掉末尾分隔符。空串（POSIX 根）归一成 `/`。 */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
}

/** 路径的最后一段。`D:\` 这样的盘符根返回 `D:`。 */
export function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return at === -1 ? trimmed : trimmed.slice(at + 1);
}

/** p 是否落在 root 之内（含 root 自身）。按整段比对，不用裸 startsWith。 */
export function within(p: string, root: string): boolean {
  const a = norm(p);
  const b = norm(root);
  if (a === b) return true;
  return a.startsWith(b.endsWith('/') ? b : `${b}/`);
}
