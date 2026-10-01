import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isWithin, realpathDeep, assertWithin, SafePathError } from './safepath.js';

describe('isWithin', () => {
  it('子路径在父路径内', () => {
    expect(isWithin('/a', '/a/b')).toBe(true);
  });
  it('自身算在内', () => {
    expect(isWithin('/a', '/a')).toBe(true);
  });
  it('多级子路径在内', () => {
    expect(isWithin('/a', '/a/b/c/d.jpg')).toBe(true);
  });
  it('拒绝 .. 穿越', () => {
    expect(isWithin('/a', '/a/../b')).toBe(false);
  });
  it('拒绝共同前缀的兄弟目录', () => {
    // 这是最容易写错的一条：字符串 startsWith 会误判 /ab 在 /a 内
    expect(isWithin('/a', '/ab')).toBe(false);
  });
  it('拒绝父目录', () => {
    expect(isWithin('/a/b', '/a')).toBe(false);
  });
  it('拒绝完全无关的路径', () => {
    expect(isWithin('/Users/me/photos', '/etc/passwd')).toBe(false);
  });
});

describe('realpathDeep', () => {
  let tmp;
  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sp-')));
  });
  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('已存在的路径直接解析', async () => {
    expect(await realpathDeep(tmp)).toBe(tmp);
  });

  it('多级尚不存在的路径也能解析出绝对路径', async () => {
    const target = path.join(tmp, 'a', 'b', 'c');
    expect(await realpathDeep(target)).toBe(target);
  });

  it('穿过符号链接后返回真实位置', async () => {
    const real = path.join(tmp, 'real');
    const link = path.join(tmp, 'link');
    await fs.mkdir(real);
    await fs.symlink(real, link);
    expect(await realpathDeep(path.join(link, 'x'))).toBe(path.join(real, 'x'));
  });

  it('路径中间遇到非目录文件（ENOTDIR）时包装为 SafePathError，而不是抛原始 fs 错误', async () => {
    const file = path.join(tmp, 'imafile');
    await fs.writeFile(file, 'x');
    const target = path.join(file, 'sub', 'thing.jpg');
    try {
      await realpathDeep(target);
      expect.unreachable('应当抛出 SafePathError');
    } catch (err) {
      expect(err).toBeInstanceOf(SafePathError);
      expect(err.code).toBe('ENOTDIR');
      expect(err.cause).toBeInstanceOf(Error);
      expect(err.cause.code).toBe('ENOTDIR');
    }
  });
});

describe('assertWithin', () => {
  let tmp, outside;
  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sp-root-')));
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sp-out-')));
    await fs.mkdir(path.join(tmp, 'sub'));
  });
  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('放行根目录内的路径并返回真实路径', async () => {
    const got = await assertWithin([tmp], path.join(tmp, 'sub'));
    expect(got).toBe(path.join(tmp, 'sub'));
  });

  it('放行尚不存在但将落在根内的路径', async () => {
    const got = await assertWithin([tmp], path.join(tmp, 'new', 'dir'));
    expect(got).toBe(path.join(tmp, 'new', 'dir'));
  });

  it('拒绝 ../ 穿越', async () => {
    await expect(assertWithin([tmp], path.join(tmp, '..', 'evil')))
      .rejects.toBeInstanceOf(SafePathError);
  });

  it('拒绝根外的绝对路径', async () => {
    await expect(assertWithin([tmp], '/etc/passwd'))
      .rejects.toBeInstanceOf(SafePathError);
  });

  it('拒绝指向根外的符号链接', async () => {
    const link = path.join(tmp, 'escape');
    await fs.symlink(outside, link);
    await expect(assertWithin([tmp], link))
      .rejects.toBeInstanceOf(SafePathError);
  });

  it('多个根中任一命中即放行', async () => {
    const got = await assertWithin([outside, tmp], path.join(tmp, 'sub'));
    expect(got).toBe(path.join(tmp, 'sub'));
  });

  it('路径中间遇到非目录文件时拒绝并抛 SafePathError（而不是原始 fs 错误）', async () => {
    const file = path.join(tmp, 'imafile');
    await fs.writeFile(file, 'x');
    await expect(assertWithin([tmp], path.join(file, 'sub', 'thing.jpg')))
      .rejects.toBeInstanceOf(SafePathError);
  });

  it('拒绝空字符串根目录，不静默放行为进程当前目录', async () => {
    await expect(assertWithin([''], path.join(tmp, 'sub')))
      .rejects.toBeInstanceOf(SafePathError);
  });

  it('拒绝非绝对路径的根目录', async () => {
    await expect(assertWithin(['relative/root'], path.join(tmp, 'sub')))
      .rejects.toBeInstanceOf(SafePathError);
  });
});
