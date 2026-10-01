import fs from 'node:fs/promises';
import path from 'node:path';
import { appRoot, ensureAppDir } from './appdir.js';
import { readJson, writeJson, withFileLock } from './jsonstore.js';
import { newId, newToken } from './tokens.js';

// 用户记录形状：{ id, shareId, nickname, nicknameKey, token, role, createdAt, lastSeenAt, disabled }
// 存储路径：~/.photocull/shares/<shareId>/users.json，形状 { version: 1, users: {} }

const MAX_NICKNAME_CODEPOINTS = 24;

// 逐字照用计划给出的判定式：控制字符区间必须写成转义序列。
// 裸控制字符在源码里是隐形的——上一阶段真的有一个字面 NUL 混进 thumbs.js，
// 代码照常工作、测试照常通过，但 git diff 把整个文件当成二进制、grep 搜不到内容。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

// "内部连续空白折叠成单个半角空格"里的"空白"特指 Unicode 的 Zs（Space Separator）
// 类别——普通全角/半角空格、不换行空格等，*不*包含 tab/换行这些控制字符。
// 这个边界很关键：tab、响铃、DEL 这些控制字符必须原样保留到下面的 CONTROL_CHARS
// 检测那一步才被拒绝，如果这里用泛泛的 \s 去折叠，tab 会在检测之前就被吃掉，
// 于是"制表符 -> bad-chars"这条用例永远测不到。
const FOLD_WHITESPACE = /\p{Zs}+/gu;

/**
 * 昵称归一化。
 *
 * 顺序（逐字照用计划）：
 * 1. 去首尾空白，内部连续空白折叠成单个半角空格
 * 2. 拒绝任何控制字符 -> bad-chars
 * 3. 空 -> empty；按码点计长度 > 24 -> too-long
 * 4. key = nickname.normalize('NFKC').toLowerCase()
 */
export function normalizeNickname(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' };

  const folded = raw.trim().replace(FOLD_WHITESPACE, ' ');

  if (CONTROL_CHARS.test(folded)) return { ok: false, reason: 'bad-chars' };
  if (folded.length === 0) return { ok: false, reason: 'empty' };
  // 按码点计长度，不是 UTF-16 单元长度：emoji 和不少汉字是代理对，
  // 用 folded.length 会把一个字符算成两个，24 个 emoji 的昵称会在第 12 个就误判 too-long。
  if ([...folded].length > MAX_NICKNAME_CODEPOINTS) return { ok: false, reason: 'too-long' };

  // 半角 Amy 与全角 Ａｍｙ、amy 与 AMY 在屏幕上是两个人还是一个人，人眼分不清。
  // 审计日志的全部价值在于"这条操作是谁做的"，所以唯一性判定必须做 NFKC + 小写归一。
  const key = folded.normalize('NFKC').toLowerCase();

  return { ok: true, nickname: folded, key };
}

export class NicknameTakenError extends Error {
  constructor(message = '这个昵称已经有人在用了，换一个吧') {
    super(message);
    this.name = 'NicknameTakenError';
    this.code = 'nickname-taken';
  }
}

// 给 createUser 内部用的输入校验失败信号。不是计划显式要求的契约（计划只点了
// NicknameTakenError），但 createUser 是可能被路由直接传入未校验昵称调用的公共
// 入口，裸调用一个不合法昵称不该悄悄建出一个 key 为空字符串之类的怪记录。
export class InvalidNicknameError extends Error {
  constructor(reason) {
    super(`昵称不合法：${reason}`);
    this.name = 'InvalidNicknameError';
    this.code = 'invalid-nickname';
    this.reason = reason;
  }
}

function usersFilePath(shareId) {
  return path.join(appRoot(), 'shares', shareId, 'users.json');
}

async function loadUsersFile(shareId) {
  return readJson(usersFilePath(shareId), { version: 1, users: {} });
}

async function saveUsersFile(shareId, data) {
  await ensureAppDir(path.join('shares', shareId));
  await writeJson(usersFilePath(shareId), data);
}

// findUserByToken 需要跨全部分享查找。维护一张内存索引（token -> {shareId, userId}），
// 第一次查询时惰性加载全部分享的用户表；createUser/deleteUser 之后增量维护这张索引，
// 避免每次 findUserByToken 都要扫全部分享目录。
let tokenIndexLoaded = false;
const tokenIndex = new Map();

async function ensureTokenIndexLoaded() {
  if (tokenIndexLoaded) return;
  const sharesDir = path.join(appRoot(), 'shares');
  let entries = [];
  try {
    entries = await fs.readdir(sharesDir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const data = await loadUsersFile(entry.name);
    for (const user of Object.values(data.users)) {
      tokenIndex.set(user.token, { shareId: entry.name, userId: user.id });
    }
  }
  tokenIndexLoaded = true;
}

function indexUser(user) {
  tokenIndex.set(user.token, { shareId: user.shareId, userId: user.id });
}

function unindexToken(token) {
  tokenIndex.delete(token);
}

// 昵称的语法校验是纯函数，不碰磁盘、不依赖共享状态，放在锁外面即可。
// 真正的竞态在"读现有用户表 -> 查唯一性 -> 写回"这一段——两个并发 createUser
// 可能都读到同一份旧 users.json、都通过（各自看来是独立的）唯一性检查、
// 再各自写回，后写的整份文件覆盖先写的。用 withFileLock 包住这一段，
// 让同一个 shareId 的 users.json 上的调用严格排队。
export async function createUser(shareId, nickname, role) {
  const normalized = normalizeNickname(nickname);
  if (!normalized.ok) throw new InvalidNicknameError(normalized.reason);

  return withFileLock(usersFilePath(shareId), async () => {
    const data = await loadUsersFile(shareId);
    const clash = Object.values(data.users).find((u) => u.nicknameKey === normalized.key);
    // 冲突就拒绝，不自动加后缀：两个显示上难以区分的昵称会直接毁掉审计日志
    // "这条操作是谁做的"这条价值。
    if (clash) throw new NicknameTakenError();

    const now = Date.now();
    const user = {
      id: newId('u'),
      shareId,
      nickname: normalized.nickname,
      nicknameKey: normalized.key,
      token: newToken(),
      role,
      createdAt: now,
      lastSeenAt: now,
      disabled: false,
    };

    data.users[user.id] = user;
    await saveUsersFile(shareId, data);
    indexUser(user);
    return user;
  });
}

export async function findUserByToken(token) {
  await ensureTokenIndexLoaded();
  const ref = tokenIndex.get(token);
  if (!ref) return null;
  const data = await loadUsersFile(ref.shareId);
  const user = data.users[ref.userId];
  if (!user) {
    // 索引里有、文件里没有：大概率是被别的进程删掉了。清掉这条陈旧索引。
    tokenIndex.delete(token);
    return null;
  }
  return user;
}

export async function findUserByNicknameKey(shareId, key) {
  const data = await loadUsersFile(shareId);
  return Object.values(data.users).find((u) => u.nicknameKey === key) ?? null;
}

export async function listUsers(shareId) {
  const data = await loadUsersFile(shareId);
  return Object.values(data.users).sort((a, b) => a.createdAt - b.createdAt);
}

const UPDATABLE_USER_FIELDS = ['role', 'disabled'];

export async function updateUser(shareId, userId, patch) {
  return withFileLock(usersFilePath(shareId), async () => {
    const data = await loadUsersFile(shareId);
    const user = data.users[userId];
    if (!user) throw new Error(`用户不存在：${userId}`);

    // 白名单必须硬编码：token/nickname/nicknameKey/id/shareId/createdAt 一律不可通过
    // updateUser 改动，否则一次不小心的 patch 就能把令牌或昵称换掉。
    for (const field of UPDATABLE_USER_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, field)) {
        user[field] = patch[field];
      }
    }

    await saveUsersFile(shareId, data);
    return user;
  });
}

export async function deleteUser(shareId, userId) {
  return withFileLock(usersFilePath(shareId), async () => {
    const data = await loadUsersFile(shareId);
    const user = data.users[userId];
    if (!user) return;
    delete data.users[userId];
    await saveUsersFile(shareId, data);
    unindexToken(user.token);
  });
}

export async function touchUser(shareId, userId) {
  return withFileLock(usersFilePath(shareId), async () => {
    const data = await loadUsersFile(shareId);
    const user = data.users[userId];
    if (!user) return;
    user.lastSeenAt = Date.now();
    await saveUsersFile(shareId, data);
  });
}

export async function countUsers(shareId) {
  const data = await loadUsersFile(shareId);
  return Object.keys(data.users).length;
}
