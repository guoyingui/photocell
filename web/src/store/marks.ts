import { create } from 'zustand';
import { putJSON } from '../lib/api';
import { actorId } from './session';
import type { Contrib } from '../lib/derive';
import type { Mark } from '../types';

type Marks = Record<string, Mark | undefined>;
type UndoEntry = { id: string; before: Mark | undefined }[];

/**
 * 一条标记的归属：谁最后改的（userId，管理员是 `'admin'`）、什么时候改的。
 *
 * 它存在一张**平行**表里，`marks` 的形状一个字节都不变
 * （`Record<id, 'pick'|'reject'>`）——导出链路、lib/derive.ts、乐观更新与回滚
 * 全都按那个读法工作，把值换成 `{mark, by, at}` 会同时静默打断这三条。
 * 服务端 server/lib/store.js 是同一口径。
 */
export interface MarkBy { by: string; at: number }
type MarksMeta = Record<string, MarkBy>;
export type FinalMarks = Record<string, { mark: Mark; at: number }>;

function sanitizeFinalMarks(value: unknown): FinalMarks {
  const result: FinalMarks = {};
  if (!value || typeof value !== 'object') return result;
  for (const [id, decision] of Object.entries(value)) {
    if (!decision || typeof decision !== 'object') continue;
    const { mark, at } = decision;
    if ((mark === 'pick' || mark === 'reject') && typeof at === 'number' && Number.isFinite(at)) result[id] = { mark, at };
  }
  return result;
}

function overlayFinal(marks: Marks, meta: MarksMeta, finalMarks: FinalMarks) {
  for (const [id, decision] of Object.entries(finalMarks)) {
    marks[id] = decision.mark; meta[id] = { by: 'admin', at: decision.at };
  }
}

const UNDO_LIMIT = 50;

/**
 * 只放行形状完整的归属条目，其余一律当作"没有归属"。
 *
 * 服务端已经 sanitize 过一遍，这里再挡一次是因为**界面直接消费这张表**：
 * `avatarColor(by)` 拿到 undefined 会抛，一个坏掉的字段就能让整屏网格白掉。
 * 退化成不显示角标是可以接受的，白屏不是。
 */
function validMeta(value: unknown): MarkBy | null {
  if (typeof value !== 'object' || value === null) return null;
  const { by, at } = value as Partial<MarkBy>;
  if (typeof by !== 'string' || by === '') return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  return { by, at };
}

function sanitizeMeta(meta: unknown): MarksMeta {
  const clean: MarksMeta = {};
  if (typeof meta !== 'object' || meta === null) return clean;
  for (const [id, entry] of Object.entries(meta)) {
    const ok = validMeta(entry);
    if (ok) clean[id] = ok;
  }
  return clean;
}

/**
 * contrib 的形状校验，和 sanitizeMeta 同一条规矩：坏条目直接丢掉，不抛。
 *
 * 这张表是**按人筛选**的唯一数据源，一个 mark 字段写着别的字符串就会让
 * 「新娘收藏过的」里混进一张她排除过的照片——而那种错误在界面上看不出来。
 */
function sanitizeContrib(value: unknown): Contrib {
  const clean: Contrib = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return clean;
  for (const [assetId, perUser] of Object.entries(value)) {
    if (typeof perUser !== 'object' || perUser === null || Array.isArray(perUser)) continue;
    const entry: Record<string, { mark: Mark; at: number }> = {};
    for (const [userId, vote] of Object.entries(perUser)) {
      if (userId === '' || typeof vote !== 'object' || vote === null) continue;
      const { mark, at } = vote as { mark?: unknown; at?: unknown };
      if (mark !== 'pick' && mark !== 'reject') continue;
      if (typeof at !== 'number' || !Number.isFinite(at)) continue;
      entry[userId] = { mark, at };
    }
    if (Object.keys(entry).length > 0) clean[assetId] = entry;
  }
  return clean;
}

function contribFromOwn(value: unknown): Contrib {
  const self = actorId();
  if (!self || !value || typeof value !== 'object' || Array.isArray(value)) return {};
  return sanitizeContrib(Object.fromEntries(Object.entries(value).map(([id, vote]) => [id, { [self]: vote }])));
}

/** 只放行字符串元素。这份数据要进 Set 并直接参与渲染判断，坏元素会静默筛错照片。 */
function sanitizeHiddenList(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((v): v is string => typeof v === 'string' && v !== ''));
}

interface MarksState {
  pendingCount: number;
  marks: Marks;
  finalMarks: FinalMarks;
  finalRevision: number;
  /** 标记归属（Task 20 的角标数据源）。旧文件夹没有这张表，那时它就是空的。 */
  marksMeta: MarksMeta;
  /** 已隐藏的资产。仅管理员改得动，但访客也持有它（隐藏对所有人生效）。 */
  hidden: Set<string>;
  /**
   * 每张照片的原始意见。管理员拿完整贡献表，访客仅拿自己的意见，
   * 避免把摄影师最终决定当成自己撤销前的值。
   */
  contrib: Contrib;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  error: string | null;
  load: (marks: Marks, meta?: unknown, hidden?: unknown, contrib?: unknown, finalMarks?: unknown, revision?: number, ownContrib?: unknown) => void;
  /** 手动关掉错误提示。没有它，保存失败的 toast 会一直挂到下一次标记成功为止。 */
  clearError: () => void;
  setMark: (ids: string[], mark: Mark | null) => void;
  undo: () => void;
  redo: () => void;
  /**
   * 合并一批来自 SSE 的远端改动（`null` = 别人清除了标记）。
   * `meta` 是同一帧广播里的归属（`{id: {by, at}}`），缺了就按"不知道是谁"处理。
   */
  applyRemote: (changes: Record<string, Mark | null>, meta?: unknown) => void;
  /** 用服务端的整份快照收敛本地状态（SSE 重连后的全量补拉）。 */
  reconcile: (remote: Marks, remoteMeta?: unknown, contrib?: unknown, finalMarks?: unknown, revision?: number, ownContrib?: unknown) => void;
  applyRemoteContrib: (changes: unknown) => void;
  applyFinal: (finalMarks: unknown, changes: Record<string, Mark | null>, meta?: unknown, revision?: number) => void;
  setHidden: (ids: string[], hidden: boolean) => void;
  /** 服务端广播的整份 hidden。整份覆盖，不做增量合并。 */
  applyRemoteHidden: (list: unknown) => void;
  pickCount: () => number;
  rejectCount: () => number;
}

export const useMarks = create<MarksState>((set, get) => {
  // entries[].before 是撤销栈用的语义：「按 undo 想要恢复到的值」。对 setMark 发起的调用，
  // 那恰好也是「这次 PUT 之前」的值，两者巧合地相同。但 undo() 复用的是几步之前、原样弹出的
  // entries——它的 before 描述的是「再往前退一步」应该恢复到什么，而不是这次 undo 自己发起的
  // PUT 失败时应该回到什么（应该回到 undo 优化更新之前，也就是 undo 发起那一刻的本地值）。
  // 所以这里给每次 apply() 调用单独准备一份 rollback 记录：在真正写入 next 之前，
  // 现场取一次 get().marks[id]，记录「这次调用开始前，这个 id 是什么」。
  //
  // 光有这份记录还不够：如果同一个 id 先后被两个批次触碰（比如连续点了 pick 又点 reject），
  // 更早发起、更晚失败的那次仍然可能把 id 抢回它自己记的旧值，把更晚那次已经成功、
  // 服务端也已确认的结果覆盖掉。单纯比较「当前值是否还等于我设的值」不能规避这个问题——
  // 如果后来者恰好设了同一个值，值比较会误判「这仍然是我的手笔」而错误回滚，造成本地和
  // 服务端不一致。真正精确的判据是「谁最后写过这个 id」：用一个自增序号给每次 apply() 调用
  // 编号，每次调用把自己涉及的 id 标记为「当前归属者」；失败时只回滚自己仍然归属的 id，
  // 一旦发现某个 id 已经被更晚的调用接管，就跳过它，把它留给那次调用自己的成败去决定。
  let seq = 0;
  let epoch = 0;
  let historySeq = 0;
  let opinionsKnown = false;
  const owner = new Map<string, number>();

  // owner 回答的是「谁最后写过这个 id」，用来决定失败时该不该回滚。它回答不了
  // 另一个问题：「这个 id 现在还有没有请求在飞」——一次成功的写不会把自己从
  // owner 里摘掉，摘掉了失败回滚就失去判据。所以这里再记一份**在飞计数**：
  // 每发起一次 PUT，涉及的每个 id 计数 +1；无论成败，请求 settle 之后 -1。
  //
  // 它服务的是实时合并的第二条规则：本地对某个 id 还有未落地的写时，
  // 该 id 的远端广播一律丢弃。别人的广播里带的是我按下 P **之前**的旧值，
  // 让它赢一次，用户看到的就是「我按了 P，界面闪回原样，然后我的写又成功了」。
  // 计数而不是布尔：同一个 id 连着按两下会有两次请求在飞，先返回的那一次
  // 不该把还在飞的那一次的保护一起解除。
  const inflight = new Map<string, number>();

  // ── 隐藏的并发保护 ──────────────────────────────────────────────────────────
  // 上面那套 owner / inflight 是按 id 记账的，隐藏用不上：它写的是**整份集合**，
  // 服务端每次响应都回一份完整的权威 hidden，冲突的粒度是「整份」而不是「某一张」。
  //
  // 要防的也不是「两个人同时改同一张」（隐藏确实只有管理员一个写入方），而是
  // **同一个管理员的两次调用在时间上重叠**：批量操作条能连点，H 键按住不放会
  // 触发键盘重复，一秒能发出去十几个 PUT。「失败就把 hidden 换回自己动手前那份
  // 快照」在这种交错下会退回一份早就过时的集合：#1 隐藏 50 张（在飞），#2 再隐藏
  // 10 张（在飞），#2 先成功把 hidden 收敛成服务端的 60 张，#1 随后失败又把它换回
  // 空集——服务端 60 张、本地一张都不藏，分歧一直持续到刷新或 SSE 重连。
  //
  // 判据：给每次写入编一个自增号，**只有最后发出的那次说了算**。
  //   - 成功：只有自己仍是最后一次时才把响应铺到界面上。不是的话，更晚那次的
  //     乐观状态比这份响应新，铺上去会闪一下再被它自己的响应改回来。
  //   - 失败：只有自己仍是最后一次时才回滚。不是的话什么都不做，交给更晚那次
  //     自己的成败去收敛——它的落点必然比我手里这份旧快照更接近服务端真值。
  let hiddenSeq = 0;

  // 回滚的落点是「服务端最后一次告诉过我们的整份 hidden」，而不是「我动手之前
  // 本地长什么样」：后者可能夹着另一次还没落地的乐观更新，把它当成真值写回去
  // 等于把一次根本没保存成功的隐藏永久留在界面上。load / 广播 / 每一条成功的
  // 响应都是服务端真值，三处都要更新它。
  let confirmedHidden = new Set<string>();

  // 换文件夹是硬重置，隐藏这条线也一样。同一台相机的两场拍摄天然共享 id
  // （IMG_0002），旧文件夹那次写入的响应要是还能落地，会把 A 的结果铺到 B 上，
  // 或者拿 A 的真值去回滚 B——两种都是不会报错的静默错误。
  let hiddenEpoch = 0;

  function hold(ids: string[]) {
    for (const id of ids) inflight.set(id, (inflight.get(id) ?? 0) + 1);
    set((state) => ({ pendingCount: state.pendingCount + 1 }));
  }
  function release(ids: string[]) {
    for (const id of ids) {
      // load() 会把整张表清掉（换文件夹是硬重置），此时旧请求的 settle 会走到
      // 一个已经不存在的条目上——减到 0 或负数一律删除，不留下负计数。
      const left = (inflight.get(id) ?? 0) - 1;
      if (left > 0) inflight.set(id, left);
      else inflight.delete(id);
    }
    set((state) => ({ pendingCount: Math.max(0, state.pendingCount - 1) }));
  }

  /** 应用一批改动并把服务端写入做成乐观更新：失败即回滚这一批自己仍然「拥有」的 id。 */
  function apply(entries: UndoEntry, next: Marks, kind: 'edit' | 'undo' | 'redo') {
    const mySeq = ++seq;
    const myEpoch = epoch;
    const myHistorySeq = ++historySeq;
    const previousUndo = get().undoStack;
    const previousRedo = get().redoStack;
    const inverse = entries.map(({ id }) => ({ id, before: ownMark(id) }));
    const ids = entries.map(({ id }) => id);
    // 归属和标记必须记在同一份回滚记录里：写失败之后界面上的标记回到了别人那一版，
    // 角标却还写着「我改的」，那是一条自相矛盾、而且磁盘上根本不存在的显示。
    const rollback = entries.map(({ id }) => ({
      id, mark: get().marks[id], meta: get().marksMeta[id], contrib: get().contrib[id],
    }));
    for (const { id } of entries) owner.set(id, mySeq);
    hold(ids);

    // 乐观归属：这一批在客户端是一次操作，整批共用一个时间戳（服务端
    // routes/marks.js 也是这么记的），显示上才不会按写入顺序散开几毫秒。
    // 身份没解析出来（kind:'none'）时宁可不记归属——猜一个只会显示成错的人。
    const self = actorId();
    const at = Date.now();
    const nextMeta = { ...get().marksMeta };
    for (const { id } of entries) {
      // 标记没了，归属跟着没：归属描述的是"这条标记是谁做的"，
      // 标记不存在时它只是一条会无限增长的垃圾（server/lib/store.js 同一条规则）。
      if (next[id] === undefined || self === null) delete nextMeta[id];
      else nextMeta[id] = { by: self, at };
    }

    // contrib 是**每个人各自那一票**，和 marksMeta（只有胜出的那一条归属）不同：
    // 这里只动 self 自己那一格，别人投过的原样留着。取消标记是删掉自己那一格，
    // 而不是清空整条——那会把摄影师的一票连坐删掉，按人筛立刻少一批照片。
    const nextContrib = { ...get().contrib };
    if (self !== null) {
      for (const { id } of entries) {
        const entry = { ...(nextContrib[id] ?? {}) };
        const mark = next[id];
        if (mark === undefined) delete entry[self];
        else entry[self] = { mark, at };
        if (Object.keys(entry).length === 0) delete nextContrib[id];
        else nextContrib[id] = entry;
      }
    }

    const displayed = { ...next };
    overlayFinal(displayed, nextMeta, get().finalMarks);
    set((s) => ({
      marks: displayed,
      marksMeta: nextMeta,
      contrib: nextContrib,
      undoStack: kind === 'edit' ? [...s.undoStack, entries].slice(-UNDO_LIMIT)
        : kind === 'undo' ? s.undoStack.slice(0, -1) : [...s.undoStack, inverse].slice(-UNDO_LIMIT),
      redoStack: kind === 'edit' ? [] : kind === 'undo'
        ? [...s.redoStack, inverse].slice(-UNDO_LIMIT) : s.redoStack.slice(0, -1),
      error: null,
    }));

    const patch: Record<string, Mark | null> = {};
    for (const { id } of entries) patch[id] = next[id] ?? null;

    void putJSON<{ marks?: Marks; marksMeta?: unknown; contrib?: unknown; ownContrib?: unknown; finalRevision?: number }>('/api/library/marks', { marks: patch }).then((result) => {
      if (myEpoch !== epoch || !result?.marks) return;
      if (result.finalRevision !== undefined && result.finalRevision < get().finalRevision) return;
      const marks = { ...get().marks }, marksMeta = { ...get().marksMeta }, contrib = { ...get().contrib };
      const incoming = sanitizeMeta(result.marksMeta);
      const votes = result.contrib === undefined ? contribFromOwn(result.ownContrib) : sanitizeContrib(result.contrib);
      const hasVotes = result.contrib !== undefined || result.ownContrib !== undefined;
      for (const id of ids) {
        if (owner.get(id) !== mySeq) continue;
        const mark = result.marks[id];
        if (mark === undefined) { delete marks[id]; delete marksMeta[id]; }
        else { marks[id] = mark; if (incoming[id]) marksMeta[id] = incoming[id]; else delete marksMeta[id]; }
        if (hasVotes) { if (votes[id]) contrib[id] = votes[id]; else delete contrib[id]; }
      }
      overlayFinal(marks, marksMeta, get().finalMarks);
      set({ marks, marksMeta, contrib });
    }).catch((err: Error) => {
      if (myEpoch !== epoch) return;
      // 回滚必须只动这一批自己涉及、且自己仍然是「最后写入者」的 id，
      // 并且基于失败时刻「最新」的 marks 计算 —— 绝不能把整个 marks 换成失败前的旧快照：
      // 并发的另一批改动、或者期间发生的 load() 切换目录，都可能已经合法地改写了其它 id。
      // undoStack 上属于这一批的条目（用引用判等定位，不依赖它是不是栈顶，
      // 因为可能有另一批更晚发起、更早成功的改动排在它前面或后面）也要一并摘除，
      // 否则之后一次正常的 undo 会把这个「幽灵」条目弹出来，对一个从未真正保存成功、
      // 或早已被摘除的 id 再发一次多余甚至破坏性的 PUT。
      set((s) => {
        const marks = { ...s.marks };
        const marksMeta = { ...s.marksMeta };
        const contrib = { ...s.contrib };
        for (const { id, mark, meta, contrib: was } of rollback) {
          if (owner.get(id) !== mySeq) continue; // 已经被更晚的调用接管，不该由我来决定它的值
          if (mark === undefined) delete marks[id];
          else marks[id] = mark;
          if (meta === undefined) delete marksMeta[id];
          else marksMeta[id] = meta;
          // contrib 和 marks / marksMeta 记在同一份回滚记录里，理由也一样：
          // 三者不一致的界面（标记退回去了、按人筛却还算数）没法解释。
          if (was === undefined) delete contrib[id];
          else contrib[id] = was;
        }
        overlayFinal(marks, marksMeta, s.finalMarks);
        return {
          marks,
          marksMeta,
          contrib,
          undoStack: myHistorySeq === historySeq ? previousUndo
            : s.undoStack.filter((entry) => entry !== entries && entry !== inverse),
          redoStack: myHistorySeq === historySeq ? previousRedo
            : s.redoStack.filter((entry) => entry !== entries && entry !== inverse),
          error: `保存失败：${err.message}`,
        };
      });
    }).finally(() => { if (myEpoch === epoch) release(ids); });
  }

  // 撤销只恢复自己的意见，不能把另一位成员的有效标记写成自己的一票。
  function ownMark(id: string): Mark | undefined {
    const state = get();
    const self = actorId();
    if (self && opinionsKnown) return state.contrib[id]?.[self]?.mark;
    if (self && state.contrib[id]) return state.contrib[id][self]?.mark;
    if (self && state.marksMeta[id] && state.marksMeta[id].by !== self) return undefined;
    return state.marks[id];
  }

  function replay(kind: 'undo' | 'redo') {
    const stack = kind === 'undo' ? get().undoStack : get().redoStack;
    const entries = stack.at(-1);
    if (!entries) return;
    const next = { ...get().marks };
    for (const { id, before } of entries) {
      if (before === undefined) delete next[id];
      else next[id] = before;
    }
    apply(entries, next, kind);
  }

  return {
    pendingCount: 0,
    marks: {},
    finalMarks: {},
    finalRevision: 0,
    marksMeta: {},
    hidden: new Set<string>(),
    contrib: {} as Contrib,
    undoStack: [],
    redoStack: [],
    error: null,

    load(marks, meta, hidden, contrib, finals, revision, ownContrib) {
      epoch++;
      historySeq++;
      opinionsKnown = contrib !== undefined || ownContrib !== undefined;
      // 切换目录/重新加载是一次硬重置：任何仍在飞行中的旧 PUT，就算之后失败，
      // 也不应该再对新加载的状态有发言权，所以把归属记录一并清空。
      // 在飞计数同理：同一台相机的两场拍摄天然共享 id（IMG_0002），留着它
      // 会让上一个文件夹的写请求凭空保护新文件夹里的同名照片，把别人在新
      // 文件夹里的标记挡在外面。
      owner.clear();
      inflight.clear();
      // 隐藏那条线同理：抬高 epoch 让还在飞的旧写入连响应都不再落地，
      // 并把「服务端真值」整个换成新文件夹这一份。
      hiddenEpoch++;
      confirmedHidden = sanitizeHiddenList(hidden);
      // 归属表跟着标记一起换：旧文件夹、以及一直单机用的文件夹根本没有这张表
      // （marks.json 里没有 marksMeta 字段），那是常态而不是异常——按空表处理，
      // 不报错，界面上就是"没有角标"。hidden 同一条规矩。
      const finalMarks = sanitizeFinalMarks(finals);
      const displayed = { ...marks }, marksMeta = sanitizeMeta(meta);
      overlayFinal(displayed, marksMeta, finalMarks);
      set({
        pendingCount: 0,
        marks: displayed,
        marksMeta,
        finalMarks,
        finalRevision: revision ?? 0,
        hidden: confirmedHidden,
        contrib: contrib === undefined ? contribFromOwn(ownContrib) : sanitizeContrib(contrib),
        undoStack: [],
        redoStack: [],
        error: null,
      });
    },

    clearError() { set({ error: null }); },

    setMark(ids, mark) {
      if (ids.length === 0) return;
      const current = get().marks;
      const entries: UndoEntry = [...new Set(ids)].map((id) => ({ id, before: ownMark(id) }));
      const next = { ...current };
      for (const id of ids) {
        if (mark === null) delete next[id];
        else next[id] = mark;
      }
      apply(entries, next, 'edit');
    },

    undo() {
      replay('undo');
    },
    redo() { replay('redo'); },

    applyRemote(changes, meta) {
      const ids = Object.keys(changes);
      if (ids.length === 0) return;
      const current = get().marks;
      const next = { ...current };
      const nextMeta = { ...get().marksMeta };
      const nextContrib = { ...get().contrib };
      const incoming = sanitizeMeta(meta);
      let touched = false;
      for (const id of ids) {
        // 规则 2：只跳过**这一个** id。一刀切丢弃整批是错的——同一帧广播里
        // 常常既有我正在改的那张，也有别人刚标的另一张；把后者一起丢掉，
        // 别人的选择在我这边就要一直看不见，直到下一次重连补拉为止。
        //
        // 归属**必须**跟标记一起跳过，用的就是这一份在飞计数。分开处理的后果
        // 是「标记是我的、角标显示成别人的」：本地乐观更新已经把标记改成我的了，
        // 而这一帧广播里带的是我按下 P **之前**那个人的归属。
        if (inflight.has(id)) continue;
        const mark = changes[id];
        // contrib 跟着同一帧维护：不然管理员正筛着「新娘」时，新娘在浏览器中
        // 标的每一张都不会出现在他眼前，直到他刷新为止——而实时看到客户在选
        // 什么，正是这个功能的用处。广播里的 by/at 恰好就是一条 contrib 条目。
        const vote = incoming[id];
        if (mark == null) {
          if (id in next) { delete next[id]; touched = true; }
          if (id in nextMeta) { delete nextMeta[id]; touched = true; }
          if (vote && nextContrib[id]?.[vote.by]) {
            const entry = { ...nextContrib[id] };
            delete entry[vote.by];
            if (Object.keys(entry).length === 0) delete nextContrib[id];
            else nextContrib[id] = entry;
            touched = true;
          }
          continue;
        }
        if (next[id] !== mark) { next[id] = mark; touched = true; }
        const by = incoming[id];
        if (by) {
          nextMeta[id] = by;
          if (!get().finalMarks[id]) nextContrib[id] = { ...nextContrib[id], [by.by]: { mark, at: by.at } };
          touched = true;
        } else if (id in nextMeta) {
          // 认不出发起者（广播缺 by/at、或形状坏了）只能退化成"不显示归属"。
          // 留着上一条更糟：这次改动明明是别人做的，角标却还挂在上一个人头上。
          delete nextMeta[id];
          touched = true;
        }
      }
      // 别人的标记不进我的撤销栈：⌘Z 是「撤销我刚才做的事」，能撤掉别人的
      // 选择就不再是撤销而是覆盖。反过来收到广播也不清空撤销栈。
      // 一帧广播全被丢弃或全无变化时不 set()，免得白白惊动所有订阅者。
      overlayFinal(next, nextMeta, get().finalMarks);
      if (touched) set({ marks: next, marksMeta: nextMeta, contrib: nextContrib });
    },

    applyRemoteContrib(changes) {
      if (!changes || typeof changes !== 'object') return;
      const contrib = { ...get().contrib };
      for (const [id, value] of Object.entries(changes)) {
        if (!value || typeof value !== 'object') continue;
        const { by, mark, at } = value;
        if (typeof by !== 'string' || !Number.isFinite(at) || ![null, 'pick', 'reject'].includes(mark)) continue;
        if (by === actorId() && inflight.has(id)) continue;
        const votes = { ...contrib[id] };
        if (mark === null) delete votes[by]; else votes[by] = { mark, at };
        if (Object.keys(votes).length) contrib[id] = votes; else delete contrib[id];
      }
      set({ contrib });
    },

    applyFinal(finals, changes, meta, revision) {
      if (revision !== undefined && revision < get().finalRevision) return;
      set({ finalMarks: sanitizeFinalMarks(finals), finalRevision: revision ?? get().finalRevision });
      const marks = { ...get().marks }, marksMeta = { ...get().marksMeta }, incoming = sanitizeMeta(meta);
      for (const [id, mark] of Object.entries(changes)) {
        if (mark === null) { delete marks[id]; delete marksMeta[id]; }
        else { marks[id] = mark; if (incoming[id]) marksMeta[id] = incoming[id]; else delete marksMeta[id]; }
      }
      overlayFinal(marks, marksMeta, get().finalMarks);
      set({ marks, marksMeta });
    },

    reconcile(remote, remoteMeta, remoteContrib, finals, revision, ownContrib) {
      if (revision !== undefined && revision < get().finalRevision) return;
      // SSE 只推增量，断开期间别人的改动不会补发，所以重连后必须以服务端的
      // 整份快照为准——包括「本地有、服务端没有」的 id（别人清掉了它）。
      const current = get().marks;
      const currentMeta = get().marksMeta;
      const next: Marks = { ...remote };
      const nextMeta: MarksMeta = {};
      // 归属只保留还有标记的那些 id：两张表因此永远对得上，不会剩下一条
      // 描述着不存在的标记的归属（服务端 sanitizeMarksMeta 同一条规则）。
      for (const [id, by] of Object.entries(sanitizeMeta(remoteMeta))) {
        if (remote[id] !== undefined) nextMeta[id] = by;
      }
      // 未落地的写例外：服务端这份快照是在我的 PUT 到达之前生成的，
      // 里面必然还没有它，照抄就等于把用户刚按下的 P 抹掉。归属同理。
      for (const id of inflight.keys()) {
        const local = current[id];
        if (local === undefined) {
          delete next[id];
          delete nextMeta[id];
          continue;
        }
        next[id] = local;
        const mine = currentMeta[id];
        if (mine) nextMeta[id] = mine;
        else delete nextMeta[id];
      }
      const finalMarks = finals === undefined ? get().finalMarks : sanitizeFinalMarks(finals);
      overlayFinal(next, nextMeta, finalMarks);
      const contrib = remoteContrib === undefined
        ? ownContrib === undefined ? get().contrib : contribFromOwn(ownContrib)
        : sanitizeContrib(remoteContrib);
      if (remoteContrib !== undefined || ownContrib !== undefined) opinionsKnown = true;
      const self = actorId();
      if (self) for (const id of inflight.keys()) {
        const votes = { ...contrib[id] };
        const mine = get().contrib[id]?.[self];
        if (mine) votes[self] = mine; else delete votes[self];
        if (Object.keys(votes).length) contrib[id] = votes; else delete contrib[id];
      }
      set({ marks: next, marksMeta: nextMeta, finalMarks, finalRevision: revision ?? get().finalRevision, contrib });
    },

    setHidden(ids, hidden) {
      if (ids.length === 0) return;
      const mySeq = ++hiddenSeq;
      const myEpoch = hiddenEpoch;
      const next = new Set(get().hidden);
      for (const id of ids) {
        if (hidden) next.add(id);
        else next.delete(id);
      }
      set({ hidden: next, error: null });

      void putJSON<{ hidden: string[] }>('/api/library/hidden', { ids, hidden })
        .then((res) => {
          if (myEpoch !== hiddenEpoch) return;   // 已经换过文件夹，这份结果与眼前这一屏无关
          // 服务端可能跳过了一些（已标记的），以它给的那份为准。
          confirmedHidden = sanitizeHiddenList(res.hidden);
          if (mySeq === hiddenSeq) set({ hidden: confirmedHidden });
        })
        .catch((err: Error) => {
          if (myEpoch !== hiddenEpoch) return;
          // 提示照给：这一批确实没存进去，哪怕状态已经由更晚那次写入收敛好了。
          const error = `隐藏未能保存：${err.message}`;
          set(mySeq === hiddenSeq ? { hidden: confirmedHidden, error } : { error });
        });
    },

    applyRemoteHidden(list) {
      // 广播来的同样是服务端真值，一并当作后续回滚的落点——否则一次失败的写入
      // 会把界面退回到广播之前那一份，把别人刚做的改动一起抹掉。
      confirmedHidden = sanitizeHiddenList(list);
      set({ hidden: confirmedHidden });
    },

    pickCount: () => Object.values(get().marks).filter((m) => m === 'pick').length,
    rejectCount: () => Object.values(get().marks).filter((m) => m === 'reject').length,
  };
});
