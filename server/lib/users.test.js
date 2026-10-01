import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeNickname,
  createUser,
  findUserByToken,
  findUserByNicknameKey,
  listUsers,
  updateUser,
  deleteUser,
  touchUser,
  countUsers,
} from './users.js';

// 每个用例都把 PHOTOCULL_HOME 指向一次性临时目录，绝不能让测试碰到开发者
// 真实的 ~/.photocull（里面可能有真实的用户令牌）。见 appdir.test.js 的同款写法。
let home;
let savedEnv;
const shareId = 'sh_test1';

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-users-'));
  savedEnv = process.env.PHOTOCULL_HOME;
  process.env.PHOTOCULL_HOME = home;
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.PHOTOCULL_HOME;
  else process.env.PHOTOCULL_HOME = savedEnv;
  await fs.rm(home, { recursive: true, force: true });
});

describe('normalizeNickname', () => {
  it.each([
    ['  小林  ', '小林'],
    ['小  林', '小 林'], // 内部连续空白折叠成单个半角空格
  ])('归一化 %j -> %j', (raw, want) => {
    expect(normalizeNickname(raw)).toMatchObject({ ok: true, nickname: want });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['a'.repeat(25), 'too-long'],
    ['ab\tcd', 'bad-chars'], // 制表符
  ])('拒绝 %j，原因 %s', (raw, reason) => {
    expect(normalizeNickname(raw)).toMatchObject({ ok: false, reason });
  });

  // 响铃 (BEL, 0x07) 和 DEL (0x7F) 故意用 String.fromCharCode 构造，
  // 不写成 \u 转义字面量也不直接键入裸字节：
  // 裸控制字符在源码里是隐形的，历史上在这个项目里进过仓库一次
  // （一个字面 NUL 混进 thumbs.js，git diff 把整个文件当成二进制、grep 搜不到内容）。
  // 用 fromCharCode 从数值构造，可以保证源文件里不出现任何裸字节。
  it('拒绝响铃控制字符（BEL, 0x07），原因 bad-chars', () => {
    const raw = 'ab' + String.fromCharCode(7) + 'cd';
    expect(normalizeNickname(raw)).toMatchObject({ ok: false, reason: 'bad-chars' });
  });

  it('拒绝 DEL 控制字符（0x7F），原因 bad-chars', () => {
    const raw = 'ab' + String.fromCharCode(0x7f) + 'cd';
    expect(normalizeNickname(raw)).toMatchObject({ ok: false, reason: 'bad-chars' });
  });

  it('拒绝 NUL 字符（0x00），原因 bad-chars', () => {
    const raw = 'ab' + String.fromCharCode(0) + 'cd';
    expect(normalizeNickname(raw)).toMatchObject({ ok: false, reason: 'bad-chars' });
  });

  it('24 个 emoji 是允许的（按码点计长度，不是按 UTF-16 单元）', () => {
    // 这个 emoji 的 .length 是 2；用 s.length 判断的实现会在第 12 个就误判 too-long
    const e = '\u{1F600}';
    expect(normalizeNickname(e.repeat(24)).ok).toBe(true);
    expect(normalizeNickname(e.repeat(25))).toMatchObject({ ok: false, reason: 'too-long' });
  });

  it('恰好 24 个码点的汉字昵称是允许的边界值', () => {
    expect(normalizeNickname('林'.repeat(24)).ok).toBe(true);
    expect(normalizeNickname('林'.repeat(25))).toMatchObject({ ok: false, reason: 'too-long' });
  });
});

describe('唯一性判定：NFKC + 小写', () => {
  it.each([
    ['Amy', 'ａｍｙ'], // 全角 vs 半角
    ['Amy', 'AMY'], // 大小写
    ['小林', ' 小林 '], // 空白
  ])('%j 与 %j 视为同一个昵称，冲突就拒绝', async (a, b) => {
    await createUser(shareId, a, 'editor');
    await expect(createUser(shareId, b, 'editor')).rejects.toMatchObject({ code: 'nickname-taken' });
  });

  it('不同分享之间昵称互不冲突', async () => {
    const u1 = await createUser('sh_a', '小林', 'editor');
    const u2 = await createUser('sh_b', '小林', 'editor');
    expect(u1.nickname).toBe('小林');
    expect(u2.nickname).toBe('小林');
    expect(u1.id).not.toBe(u2.id);
  });

  it('同一分享内不冲突的昵称都能建成', async () => {
    const u1 = await createUser(shareId, '甲', 'editor');
    const u2 = await createUser(shareId, '乙', 'editor');
    expect(u1.id).not.toBe(u2.id);
  });
});

describe('createUser / findUserByToken / deleteUser', () => {
  it('两个用户的令牌不相同，且长度为 43', async () => {
    const a = await createUser(shareId, '甲', 'editor');
    const b = await createUser(shareId, '乙', 'editor');
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBe(43);
  });

  it('删除用户后其令牌立即失效', async () => {
    const u = await createUser(shareId, '小林', 'editor');
    expect(await findUserByToken(u.token)).toMatchObject({ id: u.id });
    await deleteUser(shareId, u.id);
    expect(await findUserByToken(u.token)).toBeNull();
  });

  it('禁用用户仍可被令牌查到（判活交给调用方），但 disabled 为 true', async () => {
    const u = await createUser(shareId, '小林', 'viewer');
    await updateUser(shareId, u.id, { disabled: true });
    const found = await findUserByToken(u.token);
    expect(found).toMatchObject({ id: u.id, disabled: true });
  });

  it('跨分享查找令牌（同进程内，靠创建时维护的内存索引）', async () => {
    const u1 = await createUser('sh_x', '小林', 'editor');
    const u2 = await createUser('sh_y', '小王', 'editor');
    expect((await findUserByToken(u1.token))?.id).toBe(u1.id);
    expect((await findUserByToken(u2.token))?.id).toBe(u2.id);
  });

  it('伪造的令牌查不到任何用户', async () => {
    expect(await findUserByToken('this-token-does-not-exist')).toBeNull();
  });
});

describe('updateUser', () => {
  it('updateUser 只能改 role 和 disabled', async () => {
    const u = await createUser(shareId, '小林', 'viewer');
    const after = await updateUser(shareId, u.id, { role: 'editor', token: 'hack', nickname: '别人' });
    expect(after.role).toBe('editor');
    expect(after.token).toBe(u.token);
    expect(after.nickname).toBe('小林');
  });
});

describe('listUsers / countUsers / touchUser / findUserByNicknameKey', () => {
  it('listUsers 返回该分享下的全部用户', async () => {
    await createUser(shareId, '甲', 'editor');
    await createUser(shareId, '乙', 'viewer');
    const list = await listUsers(shareId);
    expect(list.map((u) => u.nickname).sort()).toEqual(['乙', '甲'].sort());
  });

  it('countUsers 返回该分享的用户数', async () => {
    expect(await countUsers(shareId)).toBe(0);
    await createUser(shareId, '甲', 'editor');
    expect(await countUsers(shareId)).toBe(1);
  });

  it('touchUser 更新 lastSeenAt', async () => {
    const u = await createUser(shareId, '甲', 'editor');
    const before = u.lastSeenAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await touchUser(shareId, u.id);
    const after = (await listUsers(shareId)).find((x) => x.id === u.id);
    expect(after.lastSeenAt).toBeGreaterThan(before);
  });

  it('findUserByNicknameKey 按归一化后的 key 查找', async () => {
    const u = await createUser(shareId, 'Amy', 'editor');
    const found = await findUserByNicknameKey(shareId, 'amy');
    expect(found?.id).toBe(u.id);
    expect(await findUserByNicknameKey(shareId, 'nobody')).toBeNull();
  });
});

describe('并发安全（读-改-写竞态，Task 5b）', () => {
  // 触发场景：摄影师把同一条分享链接发给一对新人，两个人同时点开、同时建号。
  // 没有跨调用互斥时，两个并发 createUser 大概率都读到同一份旧 users.json、
  // 都通过（各自角度看是独立的）唯一性检查、再各自写回——后写的整份文件
  // 覆盖先写的，先写那条用户记录就从磁盘上消失了，那个人手里的令牌解析不出用户。
  it('并发建号：不同昵称，两条记录都活着', async () => {
    await Promise.all([
      createUser(shareId, 'A', 'editor'),
      createUser(shareId, 'B', 'editor'),
    ]);
    expect(await listUsers(shareId)).toHaveLength(2); // 没有锁时这里会是 1
  });

  it('并发建号：相同昵称，恰好一个成功一个 409', async () => {
    const r = await Promise.allSettled([
      createUser(shareId, '小林', 'editor'),
      createUser(shareId, '小林', 'editor'),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'rejected')).toHaveLength(1);
    const rejected = r.find((x) => x.status === 'rejected');
    expect(rejected.reason).toMatchObject({ code: 'nickname-taken' });
    expect(await listUsers(shareId)).toHaveLength(1);
  });
});

describe('持久化与跨进程重建索引', () => {
  it('重新加载模块（模拟进程重启）后仍能靠磁盘惰性重建令牌索引', async () => {
    const u = await createUser(shareId, '小林', 'editor');
    vi.resetModules();
    const fresh = await import('./users.js');
    const found = await fresh.findUserByToken(u.token);
    expect(found).toMatchObject({ id: u.id, nickname: '小林' });
  });
});
