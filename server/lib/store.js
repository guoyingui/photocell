import fs from 'node:fs/promises';
import path from 'node:path';
import { backfill, evaluate, sanitizeContrib, setContribution } from './contrib.js';

export const CELL_WIDTH_MIN = 120;
export const CELL_WIDTH_MAX = 420;
const CELL_WIDTH_DEFAULT = 210;

/** 三档旧值 -> 像素宽度。数值正好是改造前 Grid.tsx 里 CELL_W 表的三个值。 */
const LEGACY_GRID_SIZE = { small: 150, medium: 210, large: 290 };

export const DEFAULT_SETTINGS = {
  burstThresholdMs: 1000,
  cellWidth: CELL_WIDTH_DEFAULT,
  sort: 'time',
};

/**
 * 把任意输入归一成一个合法的格子宽度。
 *
 * 三档枚举（'small' / 'medium' / 'large'）是**改造前**存在磁盘上的形状，
 * 迁移必须落在原来那三个像素值上——否则摄影师昨天调好的网格今天会变一个样，
 * 而他并没有动过任何设置。
 */
export function normalizeCellWidth(value) {
  if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_GRID_SIZE, value)) {
    return LEGACY_GRID_SIZE[value];
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return CELL_WIDTH_DEFAULT;
  return Math.min(CELL_WIDTH_MAX, Math.max(CELL_WIDTH_MIN, Math.round(value)));
}

const VALID_MARKS = new Set(['pick', 'reject']);

export const marksDir = (root) => path.join(root, '.photocull');
const marksPath = (root) => path.join(marksDir(root), 'marks.json');
const bakPath = (root) => path.join(marksDir(root), 'marks.bak.json');

function isPlainObject(obj) {
  return obj !== null && typeof obj === 'object' && Object.getPrototypeOf(obj) === Object.prototype;
}

/**
 * 归属信息（谁在什么时候标的）走这张**平行表**，绝不塞进 marks 的值里。
 *
 * marks 的形状是 `Record<id, 'pick'|'reject'>`，导出链路、前端 derive.ts、
 * 既有的乐观更新与回滚全都按这个读法工作——把值换成 `{mark, by, at}`
 * 会同时打断这三条，而且是静默打断（导出会挑出零张照片，界面照常显示）。
 *
 * 旧文件没有 marksMeta 字段，这里按空表处理，不报错：升级不该让摄影师
 * 昨天的选片打不开。同理，字段坏成任何别的形状也只是退化成"不显示归属"。
 */
function sanitizeMarksMeta(field, marks) {
  const meta = {};
  if (!isPlainObject(field)) return meta;
  for (const [id, entry] of Object.entries(field)) {
    // marks 里没有的 id 一律丢弃：归属描述的是"这条标记是谁做的"，
    // 标记不存在时它只是一条会无限增长的垃圾。两张表因此永远对得上。
    if (!Object.prototype.hasOwnProperty.call(marks, id)) continue;
    if (!isPlainObject(entry)) continue;
    const { by, at } = entry;
    if (typeof by !== 'string' || by === '') continue;
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    meta[id] = { by, at };
  }
  return meta;
}

/**
 * 隐藏集合的归一。
 *
 * **已标记的一律剔除**（规格 §1.5 不变量 4）。不变量不能只靠写入层挡——
 * 那假设了所有写入都经过我们的代码，而脏数据、并发、手改文件都不经过。
 */
export function sanitizeHidden(field, marks) {
  if (!Array.isArray(field)) return [];
  const out = [];
  const seen = new Set();
  for (const id of field) {
    if (typeof id !== 'string' || id === '') continue;
    if (seen.has(id)) continue;
    if (Object.prototype.hasOwnProperty.call(marks, id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 从 contrib 求出 marks 与 marksMeta 两张表。
 *
 * 它们仍然**落盘**（不是每次读取现算）：导出、filterAssets、countByTab
 * 都直接读 marks，改成派生会把一个 O(1) 的查表变成对整库的遍历。
 * 落盘的那份是求值结果的缓存，写入路径负责让它和 contrib 保持一致。
 */
function deriveFromContrib(contrib) {
  const marks = {};
  const marksMeta = {};
  for (const [id, entry] of Object.entries(contrib)) {
    const best = evaluate(entry);
    if (!best) continue;
    marks[id] = best.mark;
    marksMeta[id] = { by: best.by, at: best.at };
  }
  return { marks, marksMeta };
}

/**
 * 设置的归一。
 *
 * `gridSize` 是旧字段，读进来之后**不写回**——`cellWidth` 优先，两者都没有
 * 才回落默认值。留着 gridSize 的话，磁盘上会同时存在两个描述同一件事的字段，
 * 而下一个读它的人没有任何依据知道该信哪个。
 */
function sanitizeSettings(field) {
  const raw = isPlainObject(field) ? field : {};
  const { gridSize, cellWidth, ...rest } = raw;
  return {
    ...DEFAULT_SETTINGS,
    ...rest,
    cellWidth: normalizeCellWidth(cellWidth !== undefined ? cellWidth : gridSize),
  };
}

function sanitize(parsed) {
  const marksField = parsed?.marks;
  // 非 plain object 的 marks 字段（数组、字符串、数字等）视为损坏。
  const rawMarks = {};
  if (isPlainObject(marksField)) {
    for (const [id, mark] of Object.entries(marksField)) {
      if (VALID_MARKS.has(mark)) rawMarks[id] = mark;
    }
  }

  // contrib 是权威。旧文件没有它时用 marks + marksMeta 回填（规格 §1.4）——
  // 回填失败只会退化成"贡献表是空的"，不阻塞开库。
  const stored = sanitizeContrib(parsed?.contrib);
  const contrib = Object.keys(stored).length > 0
    ? stored
    : backfill(rawMarks, sanitizeMarksMeta(parsed?.marksMeta, rawMarks));

  const { marks, marksMeta } = deriveFromContrib(contrib);

  return {
    version: 1,
    updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : '',
    marks,
    settings: sanitizeSettings(parsed?.settings),
    marksMeta,
    contrib,
    hidden: sanitizeHidden(parsed?.hidden, marks),
  };
}

const empty = () => sanitize(null);

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function readMarksFile(root) {
  try {
    return { ...sanitize(await readJson(marksPath(root))), recovered: false };
  } catch (err) {
    if (err.code === 'ENOENT') return { ...empty(), recovered: false };
  }
  // 主文件存在但坏了 —— 试备份
  try {
    return { ...sanitize(await readJson(bakPath(root))), recovered: true };
  } catch {
    return { ...empty(), recovered: false };
  }
}

export async function writeMarksFile(root, data) {
  const dir = marksDir(root);
  await fs.mkdir(dir, { recursive: true });

  // 先把现有主文件备份走
  try {
    await fs.copyFile(marksPath(root), bakPath(root));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const payload = { ...sanitize(data), updatedAt: new Date().toISOString() };
  delete payload.recovered;

  const tmp = marksPath(root) + '.tmp';
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(payload, null, 2), 'utf8');
    await handle.sync();            // 数据落盘后再 rename
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, marksPath(root));   // 同文件系统内 rename 是原子的
}

export async function createMarkStore(root, { debounceMs = 500 } = {}) {
  const data = await readMarksFile(root);
  let timer = null;
  let writing = null;
  let dirty = false;
  let closed = false;
  let lastError = null;
  // 有没有"还没落盘的改动"。跟上面那个 dirty 不是一回事：dirty 只在一次写入进行中
  // 用来合并期间到达的新改动，写完就清；unsaved 记的是"自上一次成功落盘以来有没有人
  // 改过东西"，落盘失败时会被重新置回 true。
  //
  // 没有它的时候 flush() 会无条件写一次，于是每一次 open→close 都会重写 marks.json
  // 并把旧的轮转成 marks.bak.json——哪怕这一场摄影师一个标记都没动。备份因此永远
  // 等于主文件，只能防住"同一场里写坏了"，从来防不住"昨天手滑标错了"。
  let unsaved = false;

  async function persist() {
    timer = null;
    // F1: Proper serialization with coalescing via dirty flag.
    // If a write is already in flight, mark dirty and return.
    // The in-flight write will check dirty after finishing and
    // do one more write if needed, capturing all intermediate changes.
    if (writing) {
      dirty = true;
      return;
    }

    writing = (async () => {
      try {
        do {
          dirty = false;
          unsaved = false;
          await writeMarksFile(root, data);
        } while (dirty);
        lastError = null;
      } catch (e) {
        lastError = e;
        unsaved = true;   // 没写成功，这些改动还欠着
        throw e;
      }
    })().finally(() => {
      writing = null;
    });

    await writing;
  }

  function schedule() {
    if (closed) throw new Error('Cannot modify a closed MarkStore');
    unsaved = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      persist().catch((e) => {
        lastError = e;
      });
    }, debounceMs);
  }

  return {
    data,
    /**
     * `attribution` 是可选的 `{ by, at }`：by 为 actor id（访客是 `u_…`，
     * 管理员是字面量 `'admin'`），at 是服务端毫秒时间戳。
     *
     * **不带归属地写算作 admin**（本机单机流程没有 actor 这个概念）。
     * 改造前这条路径会把归属删掉；现在不能那样了——contrib 是权威，
     * 一条没有归属的贡献根本没有存放的地方。而「本机单机流程 = 摄影师本人」
     * 这个等式一直成立（`/` 那条入口是 requireAdmin 的）。
     */
    setMark(id, mark, attribution) {
      if (closed) throw new Error('Cannot modify a closed MarkStore');
      if (mark !== null && !VALID_MARKS.has(mark)) throw new Error(`非法标记值：${mark}`);

      const by = typeof attribution?.by === 'string' && attribution.by !== ''
        ? attribution.by : 'admin';
      const at = typeof attribution?.at === 'number' && Number.isFinite(attribution.at)
        ? attribution.at : Date.now();

      const next = setContribution(data.contrib[id], by, mark, at);
      if (next === null) delete data.contrib[id];
      else data.contrib[id] = next;

      const best = evaluate(data.contrib[id]);
      if (best === null) {
        delete data.marks[id];
        delete data.marksMeta[id];
      } else {
        data.marks[id] = best.mark;
        data.marksMeta[id] = { by: best.by, at: best.at };
        // 不变量 3：给一张已隐藏的照片打标记，自动取消它的隐藏。
        // 否则「已标记 ∧ 已隐藏」会从后门溜进来。
        const at2 = data.hidden.indexOf(id);
        if (at2 !== -1) data.hidden.splice(at2, 1);
      }
      schedule();
    },

    /**
     * 批量隐藏 / 取消隐藏。返回实际生效的那些和被跳过的那些。
     *
     * **已标记的照片被过滤掉，不是让整批失败**（规格 §1.5 不变量 2）：
     * 框选五十张里有一张收藏过就什么都做不了，是比部分执行更差的行为，
     * 而不变量在两种做法下同样成立。
     */
    setHidden(ids, hidden) {
      if (closed) throw new Error('Cannot modify a closed MarkStore');
      const skipped = [];
      const set = new Set(data.hidden);
      for (const id of ids) {
        if (hidden) {
          if (Object.prototype.hasOwnProperty.call(data.marks, id)) { skipped.push(id); continue; }
          set.add(id);
        } else {
          set.delete(id);
        }
      }
      data.hidden = [...set];
      schedule();
      return { hidden: data.hidden, skipped };
    },
    setSettings(patch) {
      // F3: Reject mutations on closed store
      if (closed) throw new Error('Cannot modify a closed MarkStore');
      // 最后一道防线：不能假设调用者已经归一过 cellWidth——sanitize() 只在
      // 读/写磁盘时跑，而这里改的是进程内存里的 data.settings，从赋值那一刻
      // 起就会被四条路径原样回显给所有人，直到下次重启或落盘重读。
      const next = { ...patch };
      if ('cellWidth' in next) next.cellWidth = normalizeCellWidth(next.cellWidth);
      Object.assign(data.settings, next);
      schedule();
    },
    /**
     * 取走并清空"上一次后台落盘的错误"。
     *
     * schedule() 里的 persist() 是防抖后台执行的，它抛的错以前只被塞进 lastError，
     * 而 lastError 只有 flush()（也就是 close()）会读——中间几百次 PUT /marks 全都
     * 无条件回 {ok:true}。路由必须在响应之前把这个错取走，才有机会告诉摄影师
     * "刚才那一批标记其实没写进磁盘"。
     */
    takeError() {
      const err = lastError;
      lastError = null;
      return err;
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      // 在途的那次写入自己会把错误记进 lastError，这里不用重复抛，
      // 统一由下面那一行处理，行为对调用方是一样的。
      if (writing) { try { await writing; } catch { /* 见 lastError */ } }
      if (unsaved) await persist();
      if (lastError) throw lastError;
    },
    async close() {
      await this.flush();
      closed = true;
    },
  };
}
