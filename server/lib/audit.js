import fs from 'node:fs/promises';
import path from 'node:path';
import { appRoot, ensureAppDir } from './appdir.js';
import { redactTokens } from './tokens.js';
import { csvRow, csvCell } from './csv.js';

// 单文件超过这个大小就轮转。规格 3.4：「单文件超过 16 MB 时改名为
// events.1.jsonl，保留 3 代」。做成常量默认值 + logEvent 的可选项，
// 是因为 16MB 在测试里没法在合理时间内真的写到——阈值必须能被测试注入一个
// 很小的数字，否则轮转这条分支永远测不到。
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

// 保留的轮转代数：events.1.jsonl .. events.3.jsonl。第 4 代（也就是本该
// 变成 events.4.jsonl 的那份最老数据）在轮转时被直接丢弃，不写出来。
const MAX_GENERATIONS = 3;

// 规格 3.4 的动作全集，冻结防止运行时被意外扩充。别的模块记审计事件时
// 应该用这里面的字面量，而不是自己现造字符串——那样才有"全集"这个说法。
export const ACTIONS = Object.freeze([
  'share.create',
  'share.update',
  'share.revoke',
  'user.join',
  'user.resume',
  'user.denied',
  'user.role-change',
  'user.disable',
  'user.enable',
  // 删除用户。禁用可以撤回，删除不能——两者必须是两个动作名，否则管理员事后
  // 分不清"这个人只是被停用"和"这个人连同他的令牌被彻底抹掉了"。
  'user.delete',
  'session.connect',
  'session.disconnect',
  'mark.set',
  'mark.bulk',
  'settings.update',
  'export.run',
]);

// shareId 总是由 tokens.js 的 newId('sh') 生成，字符集固定是 base64url
// （A-Za-z0-9-_）。这里的校验不是多余的洁癖：shareId 最终会拼进文件路径，
// 一旦哪天有调用方传了个没校验过的值（比如直接把 URL 里的 token 当 shareId
// 用），"../../etc/passwd" 这种输入就会变成路径穿越。宁可在这里多一道闸。
function assertSafeShareId(shareId) {
  if (typeof shareId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(shareId)) {
    throw new Error(`非法 shareId：${String(shareId)}`);
  }
}

function shareDir(shareId) {
  return path.join(appRoot(), 'shares', shareId);
}

/**
 * generation 0 = 当前文件 events.jsonl；1..3 = 轮转出去的旧文件，
 * 数字越大越老。测试直接用这个函数定位文件，所以名字和形状不能改。
 */
export function eventsPath(shareId, generation = 0) {
  assertSafeShareId(shareId);
  const dir = shareDir(shareId);
  return generation === 0
    ? path.join(dir, 'events.jsonl')
    : path.join(dir, `events.${generation}.jsonl`);
}

// 同一个 shareId 的所有写入（含轮转判断）必须严格串行。
// 这不是信任操作系统对 O_APPEND 单次 write() 的原子性——那个假设在 NFS
// 之类的场景上并不可靠，而且轮转本身牵涉多个 rename，跨越不了"单次系统调用
// 是原子的"这条线。进程内用一条 Promise 链把同一 shareId 的操作排成队列，
// 不管调用方发起时是不是并发的，真正落地时永远是一个接一个。
const writeQueues = new Map();
function withShareLock(shareId, fn) {
  const prev = writeQueues.get(shareId) || Promise.resolve();
  // then(fn, fn)：无论前一个任务成功还是失败，都要跑这一个——否则一次失败
  // 会卡住这个 shareId 之后所有的写入，永远排不上队。
  const run = prev.then(fn, fn);
  // 存进 map 的这个 promise 只用来排队，把错误吞掉，避免 unhandledRejection；
  // 真正的错误从 run（也就是这个函数的返回值）传给这次调用的调用方。
  writeQueues.set(shareId, run.catch(() => {}));
  return run;
}

/**
 * 检查当前文件是否超过阈值，超过就整条链路往后挪一格：
 *   events.3.jsonl（如果存在）直接丢弃 —— 这就是"第 4 代丢弃"。
 *   events.2.jsonl -> events.3.jsonl
 *   events.1.jsonl -> events.2.jsonl
 *   events.jsonl   -> events.1.jsonl
 * 必须从最老的一代开始处理，否则会互相覆盖（比如先把 .1 挪成 .2，
 * 再处理 .2 时会把刚挪过去的内容当成"原来的 .2"又挪一次）。
 * 挪空之后 events.jsonl 不存在了，下一次 appendFile 会用 'a' 标志自动创建。
 */
async function rotateIfNeeded(shareId, maxBytes) {
  const current = eventsPath(shareId, 0);
  let size = 0;
  try {
    size = (await fs.stat(current)).size;
  } catch (err) {
    if (err.code === 'ENOENT') return; // 还没写过东西，无需轮转
    throw err;
  }
  if (size <= maxBytes) return;

  for (let gen = MAX_GENERATIONS; gen >= 1; gen--) {
    const dst = eventsPath(shareId, gen);
    if (gen === MAX_GENERATIONS) {
      // 给最老一代腾位置：已存在的内容就是"第 4 代"，直接丢弃。
      await fs.rm(dst, { force: true });
    }
    const src = eventsPath(shareId, gen - 1);
    try {
      await fs.rename(src, dst);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // 这一代本来就不存在，跳过
    }
  }
}

/**
 * logEvent(shareId, event, tokens, opts?) -> Promise<void>
 * event: { ts?, actor, nickname?, action, ...payload }
 * ts 缺省用 Date.now()；actor 为 userId 或字面量 'admin'。
 * tokens: 需要脱敏的令牌数组（该分享的 share.token + 其下全部 user.token）。
 * opts.maxBytes：轮转阈值，供测试注入；不传时用 16MB 的默认值。
 */
export async function logEvent(shareId, event, tokens, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  assertSafeShareId(shareId);
  // shareId / ts 由这里权威决定，即便调用方在 event 里也塞了同名字段。
  const record = { ...event, shareId, ts: event?.ts ?? Date.now() };
  // 写之前对整个 event 过一遍 redactTokens——这是令牌不落盘的唯一防线，
  // 必须在拼 JSON 字符串之前做，不能信任调用方已经脱敏过。
  const safe = redactTokens(record, tokens ?? []);
  const line = JSON.stringify(safe) + '\n';

  await withShareLock(shareId, async () => {
    await ensureAppDir(path.join('shares', shareId));
    await rotateIfNeeded(shareId, maxBytes);
    // 只追加，从不改写：flag 'a' 保证写入位置永远是文件末尾。
    await fs.appendFile(eventsPath(shareId, 0), line, { encoding: 'utf8', mode: 0o600 });
  });
}

/**
 * readEvents(shareId, { limit, before, actor, action }) -> Promise<Event[]>
 * 时间倒序（最新在前）。合并当前文件与全部轮转出去的旧文件，
 * 一行解析失败就跳过并计数，不让一条坏行拖垮整份日志。
 */
export async function readEvents(shareId, { limit, before, actor, action } = {}) {
  assertSafeShareId(shareId);

  // 从最老的一代读到当前文件，读出来的顺序就是真实的时间顺序（同一份文件内
  // 只追加不改写，先出现的行一定更早；跨文件时老一代整体早于新一代）。
  // 等价于 [3,2,1,0]，写成算式是为了 MAX_GENERATIONS 变了的时候不用手改这里。
  const orderedGenerations = Array.from({ length: MAX_GENERATIONS }, (_, i) => MAX_GENERATIONS - i).concat(0);

  let ascending = [];
  let badLines = 0;
  for (const gen of orderedGenerations) {
    const file = eventsPath(shareId, gen);
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue; // 这一代不存在，正常情况（还没轮转到那么多代）
      throw err; // 真正的 IO 错误（比如权限）不该被当成"坏行"吞掉
    }
    for (const rawLine of text.split('\n')) {
      if (rawLine.trim() === '') continue; // 结尾的空行 / 空文件
      try {
        ascending.push(JSON.parse(rawLine));
      } catch {
        // 一行解析失败：跳过并计数，绝不让它中断整个读取过程。
        badLines += 1;
      }
    }
  }

  if (badLines > 0) {
    // 只是观测用的告警，不影响返回值，也不抛错——见函数顶部的注释。
    console.warn(`[audit] shareId=${shareId} 跳过了 ${badLines} 行无法解析的日志`);
  }

  let events = ascending.reverse(); // 倒序：先写的在数组末尾，reverse 之后先写的排在后面
  if (actor !== undefined) events = events.filter((e) => e.actor === actor);
  if (action !== undefined) events = events.filter((e) => e.action === action);
  if (before !== undefined && before !== null) events = events.filter((e) => e.ts < before);
  if (typeof limit === 'number') events = events.slice(0, limit);
  return events;
}

// CSV 列固定为这几列：ts/actor/nickname/action 是所有事件都有的公共字段，
// 剩下五花八门的载荷（assetId/from/to/count/assetIds/...）按 action 各不相同，
// 没必要也不可能为每种都开一列，统一塞进 payload 一列的 JSON 字符串里。
const CSV_COLUMNS = ['ts', 'actor', 'nickname', 'action', 'payload'];

/** eventsToCsv(events) -> string —— 复用 csv.js 的转义，不另写一套。 */
export function eventsToCsv(events) {
  const header = csvRow(CSV_COLUMNS);
  const rows = events.map((e) => {
    const { ts, actor, nickname, action, shareId: _shareId, ...rest } = e;
    // ts 转成 ISO 字符串：这份 CSV 是给人在 Excel/表格软件里看的，
    // 裸的毫秒时间戳对着屏幕看不出是哪天。
    const tsOut = typeof ts === 'number' && Number.isFinite(ts) ? new Date(ts).toISOString() : (ts ?? '');
    const payload = Object.keys(rest).length ? JSON.stringify(rest) : '';
    return csvRow([tsOut, actor ?? '', nickname ?? '', action ?? '', payload]);
  });
  return header + rows.join('');
}

// 只是把 csvCell 顺手导出，方便调用方（或测试）需要单独转义一个字段时
// 不用再从 csv.js 里另外 import 一次。不是"另写一套"，是同一套的转发。
export { csvCell };
