import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isLoopback, resolveActor, setAdminToken, USER_COOKIE, ADMIN_COOKIE } from './actor.js';
import { createShare, revokeShare } from './shares.js';
import { createUser, updateUser } from './users.js';

// 每个用例都把 PHOTOCULL_HOME 指向一次性临时目录，绝不能碰开发者真实的
// ~/.photocull（里面可能有真实的分享令牌）。与 shares.test.js / users.test.js 同一套约定。
let home;
let savedEnv;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-actor-'));
  savedEnv = process.env.PHOTOCULL_HOME;
  process.env.PHOTOCULL_HOME = home;
});

afterEach(async () => {
  setAdminToken(null);   // 模块级状态，必须逐例还原
  if (savedEnv === undefined) delete process.env.PHOTOCULL_HOME;
  else process.env.PHOTOCULL_HOME = savedEnv;
  await fs.rm(home, { recursive: true, force: true });
});

/** 远端地址是默认值：任何"不显式给回环地址"的用例都必须是非管理员。 */
function fakeReq({ ip = '192.168.1.50', headers = {}, cookie } = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  if (cookie !== undefined) h.cookie = cookie;
  return { socket: { remoteAddress: ip }, headers: h, method: 'GET', path: '/api/library/marks', query: {} };
}

const withCookie = (token, over = {}) => fakeReq({ ...over, cookie: `${USER_COOKIE}=${token}` });

async function makeUser({ role = 'editor', share: shareOver = {} } = {}) {
  const share = await createShare({ root: '/tmp/rootA', ...shareOver });
  const user = await createUser(share.id, '小林', role);
  return { share, user };
}

describe('isLoopback', () => {
  it('X-Forwarded-For 不能把远端请求伪装成管理员', async () => {
    const req = fakeReq({ ip: '192.168.1.50', headers: { 'x-forwarded-for': '127.0.0.1' } });
    expect(isLoopback(req)).toBe(false);
    expect((await resolveActor(req)).kind).toBe('none');
  });

  it.each([
    ['x-real-ip'],
    ['forwarded'],
    ['x-client-ip'],
  ])('%s 同样不被采信', async (header) => {
    const req = fakeReq({ headers: { [header]: '127.0.0.1' } });
    expect(isLoopback(req)).toBe(false);
    expect((await resolveActor(req)).kind).toBe('none');
  });

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('回环地址 %s 是管理员', async (ip) => {
    expect(isLoopback(fakeReq({ ip }))).toBe(true);
    expect((await resolveActor(fakeReq({ ip }))).kind).toBe('admin');
  });

  it.each([
    ['192.168.1.50'],
    ['10.0.0.2'],
    ['::ffff:192.168.1.50'],
    ['127.0.0.2'],          // 整个 127/8 都是回环，但判定式只认这三个字面量
    ['::ffff:127.0.0.2'],
    ['0:0:0:0:0:0:0:1'],    // ::1 的展开写法，Node 不会这样给，也不放行
  ])('非字面量回环地址 %s 不是管理员', (ip) => {
    expect(isLoopback(fakeReq({ ip }))).toBe(false);
  });
});

describe('resolveActor：admin 令牌', () => {
  it('未配置 admin 令牌时，带着任意 X-PhotoCull-Admin 头也不是管理员', async () => {
    const req = fakeReq({ headers: { 'x-photocull-admin': 'anything' } });
    expect((await resolveActor(req)).kind).toBe('none');
  });

  it('配置了 admin 令牌且完全相等时是管理员', async () => {
    setAdminToken('s3cret-admin-token');
    const req = fakeReq({ headers: { 'x-photocull-admin': 's3cret-admin-token' } });
    expect((await resolveActor(req)).kind).toBe('admin');
  });

  it('等长但不相等的令牌不通过', async () => {
    setAdminToken('s3cret-admin-token');
    const req = fakeReq({ headers: { 'x-photocull-admin': 's3cret-admin-tokeX' } });
    expect((await resolveActor(req)).kind).toBe('none');
  });

  it.each([
    ['s3cret-admin-toke'],          // 少一位：长度不等
    ['s3cret-admin-tokenn'],        // 多一位
    [''],                           // 空串
    ['s'],
  ])('长度不等的令牌 %j 直接判否，不抛错', async (presented) => {
    setAdminToken('s3cret-admin-token');
    const req = fakeReq({ headers: { 'x-photocull-admin': presented } });
    expect((await resolveActor(req)).kind).toBe('none');
  });

  it('admin 令牌不匹配时不会掉进 user 分支去认 Cookie 之外的东西', async () => {
    setAdminToken('s3cret-admin-token');
    const { user } = await makeUser();
    const req = withCookie(user.token, { headers: { 'x-photocull-admin': 'wrong-length' } });
    // 令牌不对不代表整个请求无效——Cookie 仍然是一个合法访客
    expect((await resolveActor(req)).kind).toBe('user');
  });
});

/**
 * `pc_admin` Cookie —— `--admin-token` 的第二条通道，也是**唯一一条浏览器用得上的**。
 *
 * 浏览器没有办法给导航请求加自定义请求头，所以 `X-PhotoCull-Admin` 对任何浏览器
 * （包括规格 §9.3 点名的电脑浏览器）都不可用。这枚 Cookie 由
 * `GET /admin-login?token=…` 种下（见 routes/adminlogin.js），
 * 之后每个请求自动带上，管理员身份这才在浏览器里成立。
 *
 * 两条通道走的是同一个定长比较，性质完全一致：令牌不对就是没有这条通道，
 * 令牌为 null（开关整个关着）时无论 Cookie 里写什么都不算数。
 */
describe('resolveActor：pc_admin Cookie', () => {
  const withAdminCookie = (value, over = {}) =>
    fakeReq({ ...over, cookie: `${ADMIN_COOKIE}=${value}` });

  it('未配置 admin 令牌时，带着任意 pc_admin Cookie 也不是管理员', async () => {
    // null 的语义是"这条通道整个关闭"，不是"空令牌"。
    expect((await resolveActor(withAdminCookie('anything'))).kind).toBe('none');
  });

  it('配置了 admin 令牌且 Cookie 值完全相等时是管理员', async () => {
    setAdminToken('s3cret-admin-token');
    expect((await resolveActor(withAdminCookie('s3cret-admin-token'))).kind).toBe('admin');
  });

  it('等长但不相等的 Cookie 值不通过', async () => {
    setAdminToken('s3cret-admin-token');
    expect((await resolveActor(withAdminCookie('s3cret-admin-tokeX'))).kind).toBe('none');
  });

  it.each([
    ['s3cret-admin-toke'],          // 少一位：长度不等
    ['s3cret-admin-tokenn'],        // 多一位
    [''],                           // 空串
    ['s'],
  ])('长度不等的 Cookie 值 %j 直接判否，不抛错', async (presented) => {
    setAdminToken('s3cret-admin-token');
    expect((await resolveActor(withAdminCookie(presented))).kind).toBe('none');
  });

  it('Cookie 值是百分号编码的也认得出来（下发时 encodeURIComponent 过）', async () => {
    // serializeCookie 对值一律 encodeURIComponent，浏览器原样带回来。
    // 少了这条往返，一个含 + 或 / 的令牌就会在 Cookie 通道上永远对不上。
    setAdminToken('a+b/c=d');
    expect((await resolveActor(withAdminCookie('a%2Bb%2Fc%3Dd'))).kind).toBe('admin');
  });

  it('正确的 Cookie 压过转发头否决：它是显式凭据，和请求头通道一样', async () => {
    setAdminToken('s3cret-admin-token');
    const req = withAdminCookie('s3cret-admin-token', {
      ip: '203.0.113.9', headers: { 'x-forwarded-for': '198.51.100.1' },
    });
    expect((await resolveActor(req)).kind).toBe('admin');
  });

  it('pc_admin 不匹配时不会吃掉访客身份：pc_user 仍然算数', async () => {
    setAdminToken('s3cret-admin-token');
    const { user } = await makeUser();
    const req = fakeReq({
      cookie: `${ADMIN_COOKIE}=wrong-length; ${USER_COOKIE}=${user.token}`,
    });
    expect((await resolveActor(req)).kind).toBe('user');
  });

  it('两枚 Cookie 都在且 pc_admin 正确时，管理员优先', async () => {
    setAdminToken('s3cret-admin-token');
    const { user } = await makeUser({ role: 'viewer' });
    const req = fakeReq({
      cookie: `${ADMIN_COOKIE}=s3cret-admin-token; ${USER_COOKIE}=${user.token}`,
    });
    expect((await resolveActor(req)).kind).toBe('admin');
  });

  it('请求头通道没被这条 Cookie 通道挤掉', async () => {
    // 对照组：curl / Postman 那条路必须照旧能用。
    setAdminToken('s3cret-admin-token');
    const req = fakeReq({ headers: { 'x-photocull-admin': 's3cret-admin-token' } });
    expect((await resolveActor(req)).kind).toBe('admin');
  });
});

describe('resolveActor：用户 Cookie', () => {
  it('有效令牌 + 活着的分享 -> user，并带上 user 与 share', async () => {
    const { share, user } = await makeUser({ role: 'viewer' });
    const actor = await resolveActor(withCookie(user.token));
    expect(actor.kind).toBe('user');
    expect(actor.user.id).toBe(user.id);
    expect(actor.user.role).toBe('viewer');
    expect(actor.share.id).toBe(share.id);
    expect(actor.share.root).toBe('/tmp/rootA');
  });

  it('被禁用的用户解析为 none', async () => {
    const { share, user } = await makeUser();
    await updateUser(share.id, user.id, { disabled: true });
    expect((await resolveActor(withCookie(user.token))).kind).toBe('none');
  });

  /**
   * `user.disabled !== false` 而不是 `!user.disabled`。
   *
   * 差别只在一条记录**缺了这个字段**（旧版本写的、被手工改坏的、或者某天
   * 多一条不走 createUser 的写入路径）时才显出来：`!user.disabled` 会把它
   * 当成"没被禁用"放进来，`!== false` 把它挡在外面。默认落点必须是拒绝——
   * 一条我们看不懂的用户记录不该等于一个可用的账户。
   *
   * 这条性质在源码注释里被当成性质写死，此前零测试：改成 `!user.disabled` 全绿。
   * 所以这里直接改盘上的 JSON，造出那几种真实存在过的形状。
   */
  it.each([
    ['字段整个缺失', undefined],
    ['null', null],
    ['0', 0],
    ['空串', ''],
    ['字符串 "false"', 'false'],
    ['true', true],
  ])('disabled 是「%s」时解析为 none（默认拒绝，不是默认可用）', async (_label, value) => {
    const { share, user } = await makeUser();
    const file = path.join(home, 'shares', share.id, 'users.json');
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (value === undefined) delete data.users[user.id].disabled;
    else data.users[user.id].disabled = value;
    await fs.writeFile(file, JSON.stringify(data));

    expect((await resolveActor(withCookie(user.token))).kind).toBe('none');
  });

  /** 对照：只有**恰好等于** false 才算数，上面那几条"拒绝"才有意义。 */
  it('disabled 恰好是 false 时才解析为 user', async () => {
    const { share, user } = await makeUser();
    const file = path.join(home, 'shares', share.id, 'users.json');
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(data.users[user.id].disabled).toBe(false);   // createUser 写的就是这个值
    expect((await resolveActor(withCookie(user.token))).kind).toBe('user');
  });

  it('分享过期后其用户解析为 none', async () => {
    const { user } = await makeUser({ share: { expiresAt: Date.now() - 1000 } });
    expect((await resolveActor(withCookie(user.token))).kind).toBe('none');
  });

  it('分享被撤销后其用户解析为 none', async () => {
    const { share, user } = await makeUser();
    await revokeShare(share.id);
    expect((await resolveActor(withCookie(user.token))).kind).toBe('none');
  });

  it('用户记录指向的分享不存在时解析为 none', async () => {
    const user = await createUser('sh_ghost', '小林', 'editor');
    expect((await resolveActor(withCookie(user.token))).kind).toBe('none');
  });

  it('伪造的用户令牌解析为 none', async () => {
    await makeUser();
    expect((await resolveActor(withCookie('a'.repeat(43)))).kind).toBe('none');
  });

  it('空 Cookie 值解析为 none', async () => {
    expect((await resolveActor(withCookie(''))).kind).toBe('none');
  });

  it('分享的令牌本身不能当用户令牌用', async () => {
    const { share } = await makeUser();
    expect((await resolveActor(withCookie(share.token))).kind).toBe('none');
  });

  it('判定顺序：回环地址优先于 Cookie，带着访客 Cookie 从本机来仍是管理员', async () => {
    const { user } = await makeUser({ role: 'viewer' });
    const actor = await resolveActor(withCookie(user.token, { ip: '127.0.0.1' }));
    expect(actor.kind).toBe('admin');
  });
});

/**
 * 同机反向代理（nginx / Caddy 反代 localhost，最常见的部署形态）下，
 * 每一个转发过来的请求，TCP 源地址都是 `127.0.0.1`。
 * 只看源地址的话，**每一个访客都会变成管理员**——能浏览整块硬盘、能触发导出、
 * move 模式下能删掉不可再生的 RAW。失败方向是开门，不是关门。
 *
 * 所以回环授予管理员身份这一条上加了两条否决（都在 resolveActor 里，
 * `isLoopback` 本身一个字不改，它仍然只看 TCP 源地址、绝不读转发头）：
 *
 *   1. 一旦设置了 `--admin-token`，回环本身不再算数，只有令牌算数；
 *   2. 请求带任何转发头时，一律不授予回环管理员身份。
 *
 * 第 2 条的方向是安全的：攻击者只能用它把自己**降级**。直连过来的攻击者本来
 * 就不是回环，加不加头都不是管理员；能被这条否决影响的只有真的从回环来的请求，
 * 而正常的本机浏览器不会自己加转发头。
 */
describe('resolveActor：回环管理员的两条否决', () => {
  it.each([
    ['x-forwarded-for', '203.0.113.9'],
    ['x-real-ip', '203.0.113.9'],
    ['forwarded', 'for=203.0.113.9;proto=http'],
  ])('同机反代：remoteAddress 是回环但带着 %s，不是管理员', async (header, value) => {
    const req = fakeReq({ ip: '127.0.0.1', headers: { [header]: value } });
    // isLoopback 的判定式不变——它看到的确实是回环，否决发生在 resolveActor 里。
    expect(isLoopback(req)).toBe(true);
    expect((await resolveActor(req)).kind).toBe('none');
  });

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    '三个回环写法都受转发头否决（%s）', async (ip) => {
      const req = fakeReq({ ip, headers: { 'x-forwarded-for': '203.0.113.9' } });
      expect((await resolveActor(req)).kind).toBe('none');
    });

  it('转发头是空串时同样否决——代理有没有填上值，改变不了"前面有代理"这件事', async () => {
    const req = fakeReq({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '' } });
    expect((await resolveActor(req)).kind).toBe('none');
  });

  it('转发头是数组（同名头出现多次）时同样否决', async () => {
    const req = fakeReq({ ip: '127.0.0.1' });
    req.headers['x-forwarded-for'] = ['203.0.113.9', '198.51.100.1'];
    expect((await resolveActor(req)).kind).toBe('none');
  });

  it('同机反代 + 访客 Cookie：降级成 user，而不是管理员', async () => {
    const { user } = await makeUser({ role: 'viewer' });
    const req = withCookie(user.token, {
      ip: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    const actor = await resolveActor(req);
    expect(actor.kind).toBe('user');
    expect(actor.user.id).toBe(user.id);
  });

  it('设了 --admin-token 之后，纯回环、无令牌不再是管理员', async () => {
    setAdminToken('s3cret-admin-token');
    expect((await resolveActor(fakeReq({ ip: '127.0.0.1' }))).kind).toBe('none');
  });

  it('设了 --admin-token 之后，回环 + 正确令牌仍是管理员', async () => {
    setAdminToken('s3cret-admin-token');
    const req = fakeReq({ ip: '127.0.0.1', headers: { 'x-photocull-admin': 's3cret-admin-token' } });
    expect((await resolveActor(req)).kind).toBe('admin');
  });

  it('设了 --admin-token 之后，回环 + 错误令牌不是管理员', async () => {
    setAdminToken('s3cret-admin-token');
    const req = fakeReq({ ip: '127.0.0.1', headers: { 'x-photocull-admin': 's3cret-admin-tokeX' } });
    expect((await resolveActor(req)).kind).toBe('none');
  });

  it('正确令牌压过转发头否决：令牌是显式凭据，不受"前面有没有代理"影响', async () => {
    setAdminToken('s3cret-admin-token');
    const req = fakeReq({
      ip: '203.0.113.9',
      headers: { 'x-photocull-admin': 's3cret-admin-token', 'x-forwarded-for': '198.51.100.1' },
    });
    expect((await resolveActor(req)).kind).toBe('admin');
  });

  // ── 反向对照 ────────────────────────────────────────────────────────────
  // 这一条和上面几条同等重要：单机流程（`npm start`，不开分享、不配令牌，
  // 浏览器直连 127.0.0.1）里，回环**必须**仍然是管理员。它一旦变红，
  // 摄影师连自己这台机器上的界面都打不开——两条否决把门关得过头了。
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    '反向对照：没设令牌、没有转发头的纯回环 %s 仍然是管理员', async (ip) => {
      expect((await resolveActor(fakeReq({ ip }))).kind).toBe('admin');
    });

  it('反向对照：无关的自定义头不会误伤单机流程', async () => {
    const req = fakeReq({
      ip: '127.0.0.1',
      headers: { 'x-photocull-session': 'sess-1', 'user-agent': 'Chrome', accept: '*/*' },
    });
    expect((await resolveActor(req)).kind).toBe('admin');
  });
});
