import crypto from 'node:crypto';

/** 32 字节随机 -> 43 字符 base64url。可猜性等同于一个 256 位密钥。 */
export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('base64url')}`;
}

/**
 * 写审计日志之前的最后一道闸。
 *
 * 令牌一旦进了 events.jsonl 就等于把密码写进了一个会被导出成 CSV、
 * 会被管理员在屏幕上打开、会被截图的地方。这个函数不追求聪明，
 * 只做一件事：深走一遍对象，把任何**等于**已知令牌的字符串替换掉。
 *
 * 深拷贝是有意的：调用方传进来的 event 对象后面可能还要接着用
 * （比如广播给 SSE 监听者），脱敏绝不能就地改写调用方还需要的数据。
 */
export function redactTokens(value, tokens) {
  const set = new Set([...tokens].filter((t) => typeof t === 'string' && t.length > 0));
  const walk = (v) => {
    if (typeof v === 'string') return set.has(v) ? '[redacted]' : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value);
}
