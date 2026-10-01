import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createShare,
  getShareById,
  resolveToken,
  listShares,
  updateShare,
  revokeShare,
  shareStatus,
} from './shares.js';

// 每个用例都把 PHOTOCULL_HOME 指向一次性临时目录，绝不能碰开发者真实的 ~/.photocull
// （里面可能有真实的分享令牌）。这与 appdir.test.js 用的是同一套约定。
let home;
let savedEnv;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-shares-'));
  savedEnv = process.env.PHOTOCULL_HOME;
  process.env.PHOTOCULL_HOME = home;
});
afterEach(async () => {
  if (savedEnv === undefined) delete process.env.PHOTOCULL_HOME;
  else process.env.PHOTOCULL_HOME = savedEnv;
  await fs.rm(home, { recursive: true, force: true });
});

/**
 * 全新安装：`~/.photocull` 还不存在。
 *
 * 上面那个 beforeEach 用 mkdtemp 造 home，**目录一定是存在的**——于是整份用例
 * 从来没有走过"应用目录还没建"这条路径，而那恰恰是每一个新用户的第一次。
 * 真机上的表现是：开库正常、点「新建分享」报
 * `ENOENT: ... open '/Users/x/.photocull/shares.json.<pid>.<uuid>.tmp'`，
 * 整个协同功能开箱即死。
 *
 * users.js 和 audit.js 各自 ensureAppDir 过（它们建的是 shares/<id> 子目录，
 * recursive 顺带把父目录带出来了），只有 shares.json 这个**顶层**文件没人管。
 */
describe('全新安装（应用目录尚不存在）', () => {
  it('createShare 自己把应用目录建出来，不要求别人先建过', async () => {
    const fresh = path.join(home, 'never-created');
    process.env.PHOTOCULL_HOME = fresh;
    await expect(fs.access(fresh)).rejects.toThrow();   // 前提：它真的不存在

    const share = await createShare({ root: '/tmp/a', label: '全新安装' });
    expect(share.token).toHaveLength(43);
    expect(await resolveToken(share.token)).toMatchObject({ label: '全新安装' });
  });

  it('建出来的应用目录是 0700（令牌等价于密码，同机其它账号不该读得到）', async () => {
    const fresh = path.join(home, 'never-created-2');
    process.env.PHOTOCULL_HOME = fresh;
    await createShare({ root: '/tmp/a' });
    const mode = (await fs.stat(fresh)).mode & 0o777;
    expect(mode.toString(8)).toBe('700');
  });
});

describe('createShare', () => {
  it('两条分享的 token 不相同，且长度为 43', async () => {
    const a = await createShare({ root: '/tmp/a' });
    const b = await createShare({ root: '/tmp/b' });
    expect(a.token).not.toBe(b.token);
    expect(a.token).toHaveLength(43);
    expect(b.token).toHaveLength(43);
  });

  it('id 以 sh_ 开头且互不相同', async () => {
    const a = await createShare({ root: '/tmp/a' });
    const b = await createShare({ root: '/tmp/b' });
    expect(a.id).toMatch(/^sh_/);
    expect(a.id).not.toBe(b.id);
  });

  it('token 由本模块生成，调用方传入的 token 字段必须被忽略', async () => {
    // 关键语义：如果实现不小心把整份 options 展开进 share 记录，
    // 调用方就能指定一个可预测的 token，等于绕开了随机性保证。
    const s = await createShare({ root: '/tmp/a', token: 'attacker-supplied-value' });
    expect(s.token).not.toBe('attacker-supplied-value');
    expect(s.token).toHaveLength(43);
  });

  it('未传的可选字段落到规格里写明的默认值', async () => {
    const s = await createShare({ root: '/tmp/a' });
    expect(s.allowUserCreation).toBe(true);
    expect(s.defaultRole).toBe('editor');
    expect(s.maxUsers).toBeNull();
    expect(s.revoked).toBe(false);
  });
});

describe('shareStatus（纯函数，时间可注入）', () => {
  it('恰好到期的瞬间算过期', async () => {
    const s = await createShare({ root: '/tmp/x', expiresAt: 1000 });
    expect(shareStatus(s, 999)).toBe('active');
    expect(shareStatus(s, 1000)).toBe('expired'); // 边界：>= 即过期
    expect(shareStatus(s, 1001)).toBe('expired');
  });

  it('expiresAt 为 null 表示永不过期', async () => {
    const s = await createShare({ root: '/tmp/x', expiresAt: null });
    expect(shareStatus(s, Number.MAX_SAFE_INTEGER)).toBe('active');
  });

  it('撤销压过未过期', async () => {
    const s = await createShare({ root: '/tmp/x', expiresAt: Date.now() + 1_000_000 });
    await revokeShare(s.id);
    const after = await getShareById(s.id);
    expect(shareStatus(after, Date.now())).toBe('revoked');
  });

  it('撤销压过已过期——两者都成立时结果仍是 revoked，而不是 expired', async () => {
    // 这一条是「优先级」真正的证据：如果实现先判过期、后判撤销，
    // 一条既撤销又已过期的分享会被误判成 'expired'，审计日志就记不下真实原因。
    const s = await createShare({ root: '/tmp/x', expiresAt: 1000 });
    await revokeShare(s.id);
    const after = await getShareById(s.id);
    expect(shareStatus(after, 5000)).toBe('revoked');
  });

  it('missing：share 为 null/undefined 时返回 missing', () => {
    expect(shareStatus(null, Date.now())).toBe('missing');
    expect(shareStatus(undefined, Date.now())).toBe('missing');
  });
});

describe('getShareById / resolveToken', () => {
  it('未知 id 返回 null', async () => {
    expect(await getShareById('sh_does-not-exist')).toBeNull();
  });

  it('未知 token 返回 null', async () => {
    expect(await resolveToken('not-a-real-token')).toBeNull();
  });

  it('撤销之后 resolveToken 仍能查到（判活是调用方的事）', async () => {
    const s = await createShare({ root: '/tmp/a' });
    await revokeShare(s.id);
    const found = await resolveToken(s.token);
    expect(found?.id).toBe(s.id);
    expect(shareStatus(found, Date.now())).toBe('revoked');
  });
});

describe('listShares', () => {
  it('按 createdAt 倒序', async () => {
    const a = await createShare({ root: '/tmp/a' });
    await new Promise((r) => setTimeout(r, 2));
    const b = await createShare({ root: '/tmp/b' });
    await new Promise((r) => setTimeout(r, 2));
    const c = await createShare({ root: '/tmp/c' });
    const ids = (await listShares()).map((s) => s.id);
    expect(ids).toEqual([c.id, b.id, a.id]);
  });
});

describe('updateShare', () => {
  it('不能改 root 或 token', async () => {
    const s = await createShare({ root: '/tmp/a' });
    const after = await updateShare(s.id, { root: '/tmp/b', token: 'x', label: '新标签' });
    expect(after.root).toBe('/tmp/a'); // 改 root = 把已发出的链接指向别的文件夹
    expect(after.token).toBe(s.token);
    expect(after.label).toBe('新标签');
  });

  it('允许改 expiresAt / defaultRole / allowUserCreation / maxUsers', async () => {
    const s = await createShare({ root: '/tmp/a' });
    const after = await updateShare(s.id, {
      expiresAt: 12345,
      defaultRole: 'viewer',
      allowUserCreation: false,
      maxUsers: 5,
    });
    expect(after.expiresAt).toBe(12345);
    expect(after.defaultRole).toBe('viewer');
    expect(after.allowUserCreation).toBe(false);
    expect(after.maxUsers).toBe(5);
  });

  it('未知字段被忽略，不会污染记录', async () => {
    const s = await createShare({ root: '/tmp/a' });
    const after = await updateShare(s.id, { revoked: true, createdAt: 1, id: 'hack' });
    expect(after.revoked).toBe(false);
    expect(after.id).toBe(s.id);
  });

  it('持久化：改动落盘，重新查询仍是新值', async () => {
    const s = await createShare({ root: '/tmp/a' });
    await updateShare(s.id, { label: '持久化标签' });
    const reread = await getShareById(s.id);
    expect(reread.label).toBe('持久化标签');
  });
});

describe('revokeShare', () => {
  it('软删：记录仍在，只是 revoked 变 true', async () => {
    const s = await createShare({ root: '/tmp/a' });
    const after = await revokeShare(s.id);
    expect(after.revoked).toBe(true);
    expect(after.id).toBe(s.id);
    expect(await getShareById(s.id)).not.toBeNull();
  });
});

describe('并发安全（读-改-写竞态，Task 5b）', () => {
  // 没有跨调用互斥时，两个并发 createShare 大概率都读到同一份旧 shares.json、
  // 都往内存对象里加自己那条记录、再各自写回——后写的整份文件覆盖先写的，
  // 先写那条记录就从磁盘上消失了。10 路并发是为了让这条竞态在慢机器上也稳定触发，
  // 而不是恰好收敛成"看起来没事"。
  it('并发建分享：全部都在，没有互相覆盖', async () => {
    const created = await Promise.all(
      Array.from({ length: 10 }, (_, i) => createShare({ root: `/tmp/r${i}` })),
    );
    const ids = new Set(created.map((s) => s.id));
    expect(ids.size).toBe(10); // sanity：10 个调用确实产生了 10 个不同 id

    const list = await listShares();
    expect(list).toHaveLength(10);
    for (const s of created) {
      expect(list.find((x) => x.id === s.id)).toBeTruthy();
    }
  });
});

describe('持久化', () => {
  it('重新加载后分享仍在（清模块内缓存后重读，模拟服务重启）', async () => {
    const s = await createShare({ root: '/tmp/a', label: '重启测试' });
    vi.resetModules();
    const fresh = await import('./shares.js');
    const found = await fresh.getShareById(s.id);
    expect(found?.id).toBe(s.id);
    expect(found?.token).toBe(s.token);
    expect(found?.label).toBe('重启测试');
  });
});

/**
 * showPeerMarks：这条分享的客户彼此看不看得见对方的选片标记。
 *
 * 默认 true —— 那是改造前的行为。升级不该悄悄改变一条已经发出去的链接的表现。
 */
describe('showPeerMarks', () => {
  it('新建的分享默认公开', async () => {
    const share = await createShare({ root: '/tmp/x' });
    expect(share.showPeerMarks).toBe(true);
  });

  it('可以在新建时指定', async () => {
    const share = await createShare({ root: '/tmp/x', showPeerMarks: false });
    expect(share.showPeerMarks).toBe(false);
  });

  it('在可 PATCH 的白名单里', async () => {
    const share = await createShare({ root: '/tmp/x' });
    const updated = await updateShare(share.id, { showPeerMarks: false });
    expect(updated.showPeerMarks).toBe(false);
    // 落盘也要改。只看返回值的话，一个改了内存对象却忘了 saveStore 的实现
    // 照样能过——而这个开关一重启就弹回公开，客户的标记又都露出来了。
    expect((await getShareById(share.id))?.showPeerMarks).toBe(false);
  });

  it('root 和 token 仍然不在白名单里', async () => {
    // 改 root 等于把一条已经发出去的分享链接静默指向另一个文件夹；
    // 改 token 等于让旧链接失效却不留痕迹。加字段最容易顺手放宽白名单，
    // 所以每加一个可改字段，都要再钉一次这两个不可改的。
    const share = await createShare({ root: '/tmp/x' });
    const updated = await updateShare(share.id, { root: '/tmp/y', token: 'hacked' });
    expect(updated.root).toBe('/tmp/x');
    expect(updated.token).toBe(share.token);
  });

  it('老的 shares.json 里没有这个字段时，读出来是 undefined 而不是被补成 false', async () => {
    // 这条是给判据定口径的：所有地方都必须写 `!== false`，不能写 `!x` 或
    // `=== true`——undefined 在后两种写法下都会被当成"不公开"，于是升级之后
    // 每一条老链接的客户都会突然看不见彼此的标记，而摄影师完全不知道发生了什么。
    const share = await createShare({ root: '/tmp/x' });
    const raw = JSON.parse(await fs.readFile(path.join(home, 'shares.json'), 'utf8'));
    delete raw.shares[share.id].showPeerMarks;
    await fs.writeFile(path.join(home, 'shares.json'), JSON.stringify(raw));
    vi.resetModules();
    const fresh = await import('./shares.js');

    const reloaded = await fresh.getShareById(share.id);
    expect(reloaded.showPeerMarks).toBeUndefined();
    expect(reloaded.showPeerMarks !== false).toBe(true);
  });
});
