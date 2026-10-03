import path from 'node:path';
import { appRoot, ensureAppDir } from './appdir.js';
import { readJson, writeJson, withFileLock } from './jsonstore.js';
import { newToken, newId } from './tokens.js';

// 存储路径与形状见计划 Task 3：~/.photocull/shares.json，
// { version: 1, shares: { <shareId>: Share } }。
// 有意不维护任何模块内的内存缓存——每次调用都直接读/写这一份文件。
// 这份数据量小（分享数以十计而非以万计），直接读写既简单又天然对得上
// "服务重启后数据仍在"这条持久化性质：没有缓存就没有"缓存和磁盘不一致"这类 bug。
const storePath = () => path.join(appRoot(), 'shares.json');

const emptyStore = () => ({ version: 1, shares: {} });

async function loadStore() {
  return readJson(storePath(), emptyStore());
}

/**
 * 写之前必须 ensureAppDir()。
 *
 * shares.json 是**顶层**文件，没有任何人替它把 `~/.photocull` 建出来：
 * users.js 和 audit.js 都建 `shares/<shareId>` 子目录，`recursive: true`
 * 顺带把父目录带出来了，于是这个缺口在它们身上不成立，只在这里成立。
 *
 * 漏掉它的后果不是边角情况，而是**每一个新用户的第一次**：开库一切正常，
 * 点「新建分享」直接 ENOENT，整个协同功能开箱即死。全套用例一条都没发现，
 * 因为它们的 PHOTOCULL_HOME 一律来自 mkdtemp——目录永远是已经存在的。
 */
async function saveStore(data) {
  await ensureAppDir();
  await writeJson(storePath(), data);
}

// updateShare 的白名单必须硬编码在这里，且只在这里。
// root 和 token 绝不能出现在这个列表里：改 root 等于把一条已经发出去的
// 分享链接静默指向另一个文件夹；改 token 等于让旧链接失效却不留痕迹。
const PATCHABLE_FIELDS = [
  'label', 'expiresAt', 'defaultRole', 'allowUserCreation', 'maxUsers', 'showPeerMarks', 'selectionLimit',
];

class ShareNotFoundError extends Error {
  constructor(id) {
    super(`share not found: ${id}`);
    this.code = 'share-not-found';
  }
}

/**
 * root 必须是调用方已经 realpath 过的绝对路径——本模块不做路径校验，
 * 那是调用方（管理接口）的职责，这里只负责存储。
 * token 永远由本模块生成；即使调用方在 options 里塞了 `token` 字段也会被忽略，
 * 防止调用方传入可预测值绕开随机性保证。
 */
// createShare/updateShare/revokeShare 都是"读 JSON -> 改内存对象 -> 写回"，
// 用 withFileLock 包住整个函数体，让同一份 shares.json 上的并发调用严格排队——
// 否则两个并发 createShare 可能都读到同一份旧数据、都写回，后写的覆盖先写的，
// 先写那条分享记录就从磁盘上消失了。
export async function createShare({
  root,
  label = '',
  expiresAt = null,
  defaultRole = 'editor',
  allowUserCreation = true,
  maxUsers = null,
  // 默认公开：那是改造前的行为。升级不该悄悄改变已经发出去的链接的表现——
  // 一条昨天发出去的链接，今天客户打开发现别人的标记都不见了，摄影师
  // 既不知道为什么，也无从解释。
  showPeerMarks = true,
  selectionLimit = null,
} = {}) {
  return withFileLock(storePath(), async () => {
    const data = await loadStore();
    const id = newId('sh');
    const share = {
      id,
      token: newToken(),
      root,
      label,
      createdAt: Date.now(),
      createdBy: 'admin', // 建分享目前只有管理员一条路径，见规格 3.2 节的持久化形状
      expiresAt,
      revoked: false,
      allowUserCreation,
      defaultRole,
      maxUsers,
      showPeerMarks,
      selectionLimit,
    };
    data.shares[id] = share;
    await saveStore(data);
    return share;
  });
}

export async function getShareById(id) {
  const data = await loadStore();
  return data.shares[id] ?? null;
}

// 只做查找，不判活。调用方（比如 /api/share/:token/*）要先拿到 share，
// 再用 shareStatus 单独判断是否可用——这样审计日志才能记下 expired / revoked
// 这样的真实原因，而 HTTP 响应仍然可以统一成 404，两者不冲突。
export async function resolveToken(token) {
  const data = await loadStore();
  for (const share of Object.values(data.shares)) {
    if (share.token === token) return share;
  }
  return null;
}

export async function listShares() {
  const data = await loadStore();
  return Object.values(data.shares).sort((a, b) => b.createdAt - a.createdAt);
}

export async function updateShare(id, patch) {
  return withFileLock(storePath(), async () => {
    const data = await loadStore();
    const share = data.shares[id];
    if (!share) throw new ShareNotFoundError(id);
    for (const key of PATCHABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        share[key] = patch[key];
      }
    }
    await saveStore(data);
    return share;
  });
}

// 软删：revoked = true，记录本身、以及它名下的用户表和审计日志全部保留。
// 「谁在什么时候进来过」是撤销之后才更需要的信息，不能因为撤销就抹掉。
export async function revokeShare(id) {
  return withFileLock(storePath(), async () => {
    const data = await loadStore();
    const share = data.shares[id];
    if (!share) throw new ShareNotFoundError(id);
    share.revoked = true;
    await saveStore(data);
    return share;
  });
}

/**
 * 纯函数：不读盘、不产生副作用，时间由调用方注入（测试可以精确摆边界，
 * 不必用真实时钟 sleep）。
 *
 * 判定顺序本身是要求：revoked 优先于 expired。
 * 一条分享可能同时"已撤销"又"已过期"——如果先判过期，撤销这个更强的原因
 * 就会被过期原因盖住，审计日志和管理台看到的都是错的解释。
 */
export function shareStatus(share, now) {
  if (!share) return 'missing';
  if (share.revoked) return 'revoked';
  if (share.expiresAt !== null && share.expiresAt !== undefined && now >= share.expiresAt) {
    return 'expired';
  }
  return 'active';
}
