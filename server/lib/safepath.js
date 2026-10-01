import fs from 'node:fs/promises';
import path from 'node:path';

export class SafePathError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SafePathError';
    this.status = 403;
    if (options.code !== undefined) this.code = options.code;
  }
}

/**
 * child 是否落在 parent 之内（含 parent 自身）。
 * 用 path.relative 而不是 startsWith —— 后者会把 /ab 误判成在 /a 内。
 */
export function isWithin(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}

/**
 * 解析真实路径。路径可以尚不存在（导出时要新建目录），
 * 此时向上找到最近的存在祖先做 realpath，再把剩余段拼回去。
 */
export async function realpathDeep(p) {
  const abs = path.resolve(p);
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      const real = await fs.realpath(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new SafePathError(`无法解析路径：${abs}（${err.code}）`, {
          cause: err,
          code: err.code,
        });
      }
      const parent = path.dirname(cur);
      if (parent === cur) throw new SafePathError(`无法解析路径：${abs}`);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * 断言 candidate 落在 roots 中至少一个之内，返回解析后的真实路径。
 * 所有接受客户端路径的接口都必须先过这里。
 */
export async function assertWithin(roots, candidate) {
  if (typeof candidate !== 'string' || candidate === '') {
    throw new SafePathError('路径不能为空');
  }
  for (const r of roots) {
    if (typeof r !== 'string' || r === '' || !path.isAbsolute(r)) {
      throw new SafePathError(`根目录配置无效：${JSON.stringify(r)}`);
    }
  }
  const real = await realpathDeep(candidate);
  const realRoots = await Promise.all(roots.map((r) => realpathDeep(r)));
  if (!realRoots.some((r) => isWithin(r, real))) {
    throw new SafePathError(`路径超出允许范围：${candidate}`);
  }
  return real;
}
