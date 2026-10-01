/**
 * 由 userId 稳定派生一个用于圆形色块的 CSS 颜色。规格 §7.5：
 * "颜色由 userId 哈希得到，稳定不变"——同一个 id 在任意时刻、任意进程里
 * 必须得到同一个颜色，所以这里只能是纯函数（不能引入随机数、时间戳）。
 *
 * 用简单的 djb2 变体把字符串折叠成一个整数，取模 360 当色相，
 * 饱和度/亮度固定，保证色块在浅色/深色背景下都还算可读。
 */
export function avatarColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0; // |0 折回 32 位有符号整数，避免精度丢失
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 45%)`;
}

/**
 * 圆形色块里显示的首字，取自昵称（不是 userId）——按 Unicode 码点取第一个，
 * 而不是按 UTF-16 code unit：昵称允许中文/emoji，用 `[0]` 或 `charAt(0)`
 * 在代理对上会切出半个乱码字符。
 * 空昵称（正常流程不会出现，昵称规则要求 1-24 个码点）兜底显示 '?'。
 */
export function avatarInitial(nickname: string): string {
  const trimmed = nickname.trim();
  if (trimmed === '') return '?';
  return Array.from(trimmed)[0];
}
