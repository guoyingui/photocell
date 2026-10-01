import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appRoot, ensureAppDir } from './appdir.js';

// 每个用例都把 PHOTOCULL_HOME 指向一次性临时目录，
// 绝不能让测试碰到开发者真实的 ~/.photocull（里面可能有真实的分享令牌）。
let home;
let savedEnv;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-home-'));
  savedEnv = process.env.PHOTOCULL_HOME;
  process.env.PHOTOCULL_HOME = home;
});
afterEach(async () => {
  if (savedEnv === undefined) delete process.env.PHOTOCULL_HOME;
  else process.env.PHOTOCULL_HOME = savedEnv;
  await fs.rm(home, { recursive: true, force: true });
});

describe('appRoot', () => {
  it('返回 PHOTOCULL_HOME 覆盖值', () => {
    expect(appRoot()).toBe(home);
  });
});

describe('ensureAppDir', () => {
  it('目录以 0700 创建', async () => {
    const p = await ensureAppDir('shares/sh_test');
    const st = await fs.stat(p);
    expect(st.mode & 0o777).toBe(0o700);   // 令牌等价于密码，别让同机其它账号读到
  });

  it('递归创建多级不存在的子目录', async () => {
    const p = await ensureAppDir('a/b/c');
    expect(p).toBe(path.join(home, 'a/b/c'));
    const st = await fs.stat(p);
    expect(st.isDirectory()).toBe(true);
  });

  it('不传 sub 时返回并创建 appRoot 本身', async () => {
    const p = await ensureAppDir();
    expect(p).toBe(home);
    const st = await fs.stat(p);
    expect(st.mode & 0o777).toBe(0o700);
  });

  it('重复调用不报错（已存在的目录也会被重新 chmod 到 0700）', async () => {
    await ensureAppDir('shares');
    // 故意把权限改宽，验证第二次调用会收紧回 0700 而不是跳过。
    await fs.chmod(path.join(home, 'shares'), 0o755);
    const p = await ensureAppDir('shares');
    const st = await fs.stat(p);
    expect(st.mode & 0o777).toBe(0o700);
  });
});
