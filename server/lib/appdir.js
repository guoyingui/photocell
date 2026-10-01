import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 测试用 PHOTOCULL_HOME 覆盖，避免把用例数据写进开发者真实的 ~/.photocull。
export function appRoot() {
  return process.env.PHOTOCULL_HOME || path.join(os.homedir(), '.photocull');
}

/**
 * 0o700 不是洁癖：这个目录里的分享令牌和用户令牌等价于密码，
 * 同一台机器上的其它账号不该读得到。
 * mkdir 的 mode 会被 umask 削减，所以创建后再 chmod 一次。
 */
export async function ensureAppDir(sub = '') {
  const dir = sub ? path.join(appRoot(), sub) : appRoot();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  return dir;
}
