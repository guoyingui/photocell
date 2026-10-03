import { create } from 'zustand';
import { getJSON, postJSON, putJSON, openStream, setSessionId, setSessionGoneHandler, type ApiError } from '../lib/api';
import { clearThumbCache } from '../lib/thumbSource';
import { createReconnectRefetch, handleRealtimeEvent, resetRealtime } from '../lib/realtime';
import { useView } from './view';
import { useMarks } from './marks';
import { clearToast } from './notice';
import { useSession } from './session';
import { useReview } from './review';
import { useAnnotations } from './annotations';
import { useSelection } from './selection';
import { CELL_WIDTH_MIN, CELL_WIDTH_MAX, type Asset, type AssetMeta, type Mark, type Settings } from '../types';

/**
 * `POST /api/library/open`。
 *
 * **刻意不含 `warnings` / `skippedFiles` / `assetCount`。** 服务端确实还在回这三个
 * 字段，但开库不再等扫描（Task 12）之后，响应发出的那一刻扫描根本还没跑完，
 * 它们必然是 `[]` / `0`。从这里读的后果不是报错而是静默错误：「已跳过 N 个非照片
 * 文件」那条提示永远显示 0，永远不出现。把它们从类型里删掉，是让下一个人
 * 想这么写的时候撞在 tsc 上，而不是撞在三个月后的一次"怎么从来没提示过"上。
 * 它们唯一说得准的地方是 `GET /api/library/assets`（见 AssetsResult）。
 */
interface OpenResult {
  sessionId: string;
  root: string;
  /**
   * `'scanning'`：资产表还没有，要等 SSE 的 `scan.done`；
   * `'ready'`：同一个文件夹已经开着（第二个标签页），资产表当场就能用。
   */
  phase: 'scanning' | 'ready';
  settings: Settings;
  marksRecovered: boolean;
}

/** `GET /api/library/assets`。warnings / skippedFiles **只有**这里说得准。 */
interface AssetsResult {
  assets: Asset[];
  warnings: string[];
  skippedFiles: number;
}

/** `GET /api/library/marks`。marksMeta / hidden 都是平行表，旧文件夹没有这两个字段。 */
interface MarksResult {
  marks: Record<string, Mark>;
  settings: Settings;
  marksMeta?: unknown;
  hidden?: unknown;
  /** 每人各投过什么票。服务端只给管理员下发，访客那边这个字段整个不存在。 */
  contrib?: unknown;
  finalMarks?: unknown;
  finalRevision?: number;
}

interface LibraryState {
  root: string | null;
  /** 服务端会话 id。api.ts 用它给每个请求带上 X-PhotoCull-Session / ?sid=。 */
  sessionId: string | null;
  assets: Asset[];
  metas: Map<string, AssetMeta>;
  settings: Settings;
  warnings: string[];
  skippedFiles: number;
  /** 主标记文件损坏、从 marks.bak.json 恢复过。规格 §7 要求明确提示。 */
  marksRecovered: boolean;
  metaDone: boolean;
  bake: { done: number; total: number; running?: boolean };
  /**
   * 扫描到目前为止**累计**碰过的**文件**数（SSE `scan` 事件的 `found`）。
   *
   * 是文件数，不是资产数：一对 RAW+JPG 是两个文件、一个资产
   * （server/lib/scan.js 的 onBatch 契约）。展示它的文案必须跟着说"文件"，
   * 否则一场 3000 张的婚礼会显示成"已扫描 6000 张"——数字看着挺正常，只是不对。
   * 扫描没有总数（要先走完一遍才知道），所以它只能配一条不定长进度条。
   */
  scanFound: number;
  phase: 'idle' | 'scanning' | 'ready';
  error: string | null;
  /** 错误的补充信息（如 not-writable 的原始 errno 文案），跟 error 一起展示在选择器上。 */
  errorDetail: string | null;
  /** SSE 连接目前是否不健康；null 表示正常。仅用于展示，不驱动任何重连逻辑。 */
  streamError: string | null;
  /**
   * 服务端拒绝了这次「换文件夹」，因为该会话上还有访客在线（规格 §5.4）。
   * null = 没有待确认的拦截。
   *
   * `message` 直接来自服务端，界面**原样显示**：在线人数、"链接仍然有效"、
   * 以及"要真正结束访问请去撤销"这三句话必须来自同一个知道真相的地方，
   * 前端自己拼一份迟早会跟服务端说的不一样。
   * `online` 是同一件事的机器可判定版本；服务端没给（或者给了个不是数字的东西）
   * 时是 null——宁可界面上少一个数字，也不要显示成 NaN。
   */
  closeBlocked: { online: number | null; message: string } | null;
  open: (root: string) => Promise<void>;
  /**
   * 关掉当前的库。`force` 为 true 时告诉服务端"我知道会把访客踢下线，照关"。
   * 默认 false：这个参数的作用是踢人，落点必须是"没说清楚就不踢"。
   */
  close: (force?: boolean) => Promise<void>;
  /** 关掉那条"还有 N 位访客在线"的确认提示，什么都不做。 */
  dismissCloseBlock: () => void;
  /** 正在重扫。按钮据此禁用并显示进度。 */
  refreshing: boolean;
  /** 上一次刷新的增减。null = 还没刷新过，或者已经被用户关掉提示。 */
  refreshResult: { removed: number; added: number } | null;
  /** 原地重扫当前文件夹。失败不清空任何东西，只留一条 error。 */
  refresh: () => Promise<void>;
  /** 关掉「N 张已不在磁盘上」那条提示。 */
  dismissRefreshResult: () => void;
  /**
   * 改网格格子宽度。本地状态立刻变（滑块要跟手），落盘防抖 400ms——
   * 滑块是连续拖动的，每帧一个请求会把服务端和 markStore 的落盘一起捶烂。
   */
  setCellWidth: (px: number, persist?: boolean) => void;
}

let stopStream: (() => void) | null = null;

/** 缩放落盘的防抖定时器。模块级：整个前端同时只有一个库开着。 */
let cellWidthTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 正在等扫描落定的那一次 `open()` 的唤醒钩子。参数是失败原因，`null` = 扫完了
 * （或者这次等待被作废）。同一时刻最多只有一个，因为 epoch 保证只有最新那次
 * `open()` 还在等。
 */
let settleScan: ((failure: string | null) => void) | null = null;

/** 唤醒（并清掉）正在等扫描的那次 open()。没有人在等时是空操作。 */
function finishScan(failure: string | null) {
  const settle = settleScan;
  settleScan = null;
  settle?.(failure);
}

/**
 * 关掉当前的流，并结束任何还挂在它身上的等待。
 *
 * 两件事必须一起做：有人正等扫描结束的时候把流关掉（换文件夹、按了"换文件夹"、
 * 会话失效），那个等待就再也等不到任何事件了——`open()` 返回的 promise 永远不
 * settle，界面停在进度条上，await 它的调用方一起挂住。被唤醒的那次调用随后
 * 会撞上自己的 epoch 检查而作废，所以这里用 `null`（不是失败）唤醒。
 */
function teardownStream() {
  stopStream?.();
  stopStream = null;
  finishScan(null);
}

// 每次 open()/close() 调用都会拿到自增的 epoch。旧调用在每个 await 之后都要
// 核对自己的 epoch 是否还是当前值，不是的话就直接放弃——不写 store、不建立新的
// EventSource。这样即使用户在第一次打开还没完成时就点开了另一个文件夹，
// 后写入 store 的、以及唯一被保留在 stopStream 里的，永远是"最新一次" open()。
let openEpoch = 0;

/** 库以外的三份跨文件夹状态。必须和 useLibrary 的复位在同一个同步代码段里跑完。 */
function resetClientState() {
  useAnnotations.getState().reset();
  useReview.getState().reset();
  useSelection.getState().reset();
  useView.getState().reset();
  useMarks.getState().load({});
  // 阻断状态与在线名单都是上一条流派生出来的，换文件夹时一起归零；
  // 新的一次订阅连上后服务端会立刻推一份完整的 presence 快照。
  resetRealtime();
  // 「3 张因为已有标记被跳过」说的是上一个文件夹里的 3 张，留到下一个文件夹里
  // 就是一句指着不存在的照片的话。它自己 3 秒后会消失，但那 3 秒足够被误读。
  clearToast();
  // clearThumbCache 必须在这里、而不是在 App 的 effect 里：useThumb 的
  // useState(() => cache.get(id) ?? null) 在渲染期就读缓存，effect 再清就晚了。
  // 两个文件夹的 id 相同时（同一台相机的两场），A 的缩略图会出现在 B 的格子里，
  // 而且因为 useThumb 已经走了"命中缓存"分支，不会重新拉取，格子会一直烂着。
  // failed 集合同理：在 A 失败过的 id 在 B 里直接显示"无法预览"，一次都不会请求。
  clearThumbCache();
}

const EMPTY_LIBRARY = {
  root: null,
  sessionId: null,
  assets: [] as Asset[],
  metas: new Map<string, AssetMeta>(),
  warnings: [] as string[],
  skippedFiles: 0,
  marksRecovered: false,
  metaDone: false,
  bake: { done: 0, total: 0 },
  scanFound: 0,
  streamError: null,
  closeBlocked: null as LibraryState['closeBlocked'],
  refreshing: false,
  refreshResult: null as LibraryState['refreshResult'],
};

export const useLibrary = create<LibraryState>((set, get) => ({
  ...EMPTY_LIBRARY,
  settings: { burstThresholdMs: 1000, cellWidth: 210, sort: 'time' },
  phase: 'idle',
  error: null,
  errorDetail: null,

  async open(root) {
    // 无论上一次 open() 走到哪一步，先把它可能已经建立的流关掉（连同挂在那条流上
    // 的扫描等待），并立刻抢占 epoch——这两步都是同步的，中间不会被别的 open()
    // 调用打断。teardownStream 唤醒的那次等待要到微任务里才继续跑，那时 epoch
    // 已经变了，它会自己作废。
    teardownStream();
    const myEpoch = ++openEpoch;
    // 复位必须在这里，而不是等 phase 变成 'ready' 之后由 App 的 effect 来做：
    // 那时子组件已经拿着上一个文件夹的 selection / dirFilter / marks / 缩略图
    // 渲染过一帧了，而 selection 这一份会被 useKeyboard 当成标记目标。
    setSessionId(null);
    resetClientState();
    set({
      ...EMPTY_LIBRARY,
      phase: 'scanning', error: null, errorDetail: null,
    });
    try {
      const info = await postJSON<OpenResult>('/api/library/open', { root });
      if (myEpoch !== openEpoch) return; // 等待期间又有更新的 open() 抢占了，这次结果作废

      // 后面每一个请求都要带上这个会话 id，assets/marks 两个路由都要求它。
      setSessionId(info.sessionId);

      // 建流必须排在拉资产**前面**。扫描进度只从这条流上来，而 `GET /assets`
      // 在服务端会一直等到扫描落定才回应（routes/library.js 的 requireSession）——
      // 先拉资产再建流的话，读卡器上那几十秒里界面上一个数字都不会有，
      // "正在扫描…"这句静止的话跟卡死无法区分。
      // 服务端在连接建立时会补发一帧当前进度，所以中途连上也不会漏掉进度。
      stopStream = openStream('/api/library/stream', (event) => {
        if (myEpoch !== openEpoch) return; // 流已经属于被换掉的旧文件夹，忽略
        // 协同事件（marks / presence / role）交给 lib/realtime.ts —— 摄影师这一侧
        // 和访客那一侧必须共用同一份合并规则（忽略自己的回声、丢弃未落地写涉及
        // 的 id）。只给访客接线的话，客户在浏览器中标的那些片，摄影师屏幕上要等到
        // 换一次文件夹才看得见。
        if (handleRealtimeEvent(event)) return;
        if (event.type === 'settings') {
          set({ settings: event.settings });
          if (useView.getState().threshold !== event.settings.burstThresholdMs) {
            useView.getState().setThreshold(event.settings.burstThresholdMs);
          }
          return;
        }
        if (event.type === 'scan') {
          // found 是**文件**数（不是资产数、也不是增量），照服务端的口径原样存。
          set({
            scanFound: typeof event.found === 'number' ? event.found : get().scanFound,
            streamError: null,
          });
          // 扫描失败：服务端发完这一帧就会断掉所有连接并把会话清理掉。原因是
          // 脱敏过的一句话（不含磁盘路径），直接用；等着的那次 open() 靠它退回选择器。
          if (typeof event.error === 'string' && event.error !== '') finishScan(event.error);
          else if (event.done) finishScan(null);
        } else if (event.type === 'rescan') {
          // 访客侧收到这一帧要自己重拉资产表——刷新是管理员发起的，
          // 但换掉的是所有人正在看的那一份。管理员这一侧 refresh() 自己
          // 已经拉过了，这里靠 refreshing 判掉，不重复拉。
          set({ streamError: null });
          if (!get().refreshing && typeof event.error !== 'string') {
            void getJSON<AssetsResult>('/api/library/assets').then((lib) => {
              useView.getState().pruneMissing(new Set(lib.assets.map((a) => a.id)));
              set({ assets: lib.assets, warnings: lib.warnings ?? [], skippedFiles: lib.skippedFiles ?? 0 });
            }).catch(() => {});
          }
        } else if (event.type === 'meta') {
          // 复制一份 Map 才能触发 zustand 的订阅者更新
          const next = new Map(get().metas);
          for (const m of event.metas as AssetMeta[]) next.set(m.id, m);
          set({ metas: next, streamError: null });
        } else if (event.type === 'metaDone') {
          set({ metaDone: true, streamError: null });
        } else if (event.type === 'bake') {
          set({ bake: { done: event.done, total: event.total, running: event.running }, streamError: null });
        } else if (event.type === 'error') {
          set({ streamError: '与服务器的实时连接中断，进度可能已停止更新' });
          // 还在等扫描结束的话，这条流就是唯一的完成信号——断了就再也等不到了。
          // 与其把用户留在一个永远不动的进度条前面，不如退回选择器让他再点一次：
          // 会话在服务端多半还活着，下一次打开会直接落到 'ready'。
          finishScan('与服务器的连接中断，没能确认扫描结果，请再打开一次');
        }
      }, createReconnectRefetch());

      // 扫描还没跑完：等 scan 事件。资产表这会儿在服务端就是空的，抢跑拉回来
      // 的是一个零解释的空网格。
      if (info.phase === 'scanning') {
        const failure = await new Promise<string | null>((resolve) => { settleScan = resolve; });
        if (myEpoch !== openEpoch) return; // 等待期间被换掉了，这次收尾作废
        if (failure !== null) throw new Error(failure);
      }

      // warnings / skippedFiles 跟资产一起从这里拿。开库响应里的那两个字段在
      // 扫描期间必然是空的，读它等于让"已跳过 N 个非照片文件"永远显示 0。
      const lib = await getJSON<AssetsResult>('/api/library/assets');
      if (myEpoch !== openEpoch) return; // 同上

      // 标记必须在 phase 变 'ready' 之前就位。以前这一步在 App 的 effect 里：
      // 没有 .catch（拉取失败就是一条控制台里永远看不到的 unhandled rejection），
      // 没有 epoch 守卫（A→B 快速切换时 A 的标记会盖在 B 上），而且网格必然先用
      // 空标记渲染一帧。放进 open() 之后这三件事一起消失，代价是打开多一次往返。
      // 拉取失败时宁可不打开：把一个已经选过片的文件夹显示成"全部未标记"，
      // 比打不开更危险。
      const loaded = await getJSON<MarksResult>('/api/library/marks');
      if (myEpoch !== openEpoch) return;

      // 归属表、hidden 都跟标记一起进 store：这是它们唯一的数据来源。
      // 旧文件夹没有这两个字段，marks store 按空表/空集处理。
      useMarks.getState().load(loaded.marks, loaded.marksMeta, loaded.hidden, loaded.contrib, loaded.finalMarks, loaded.finalRevision);
      const settings = loaded.settings ?? info.settings;
      useView.getState().setThreshold(settings.burstThresholdMs);

      set({
        root: info.root, sessionId: info.sessionId, assets: lib.assets, settings,
        warnings: lib.warnings ?? [], skippedFiles: lib.skippedFiles ?? 0,
        marksRecovered: info.marksRecovered, phase: 'ready',
      });

      // 名册跟着"当前打开的是哪个文件夹"变，所以放在这里拉，而不是交给某个
      // 组件的 useEffect——那样会在每次挂载时多拉一次，换文件夹时反而可能不拉。
      // 不 await：只有管理员拿得到这个端点，访客调用 open() 走不到这里（服务端
      // requireAdmin 会先 403），失败也已经在 loadRoster() 内部静默吞掉了，
      // 没有必要为了它拖住整个开库流程多一次往返。
      void useSession.getState().loadRoster();
    } catch (err) {
      if (myEpoch !== openEpoch) return; // 已经被更新的 open() 取代，不要覆盖它的状态
      // 流是在拉资产之前建的，所以这条失败路径上它可能已经存在了——不关掉的话
      // 界面已经回到选择器，后台却还挂着一条会自动重连、还在往一个死掉的会话
      // 里灌事件的连接。
      teardownStream();
      setSessionId(null);
      // not-writable 是一个必须由用户去处理的阻断状态（只读 SD 卡、只读挂载、
      // 磁盘写满），服务端给的 message 是人话、detail 是原始 errno 文案。
      // 两条都留在 store 里，由选择器常驻展示，而不是一闪而过的提示。
      //
      // 整份 EMPTY_LIBRARY 一起复位：扫描期间已经往 store 里写过 scanFound 和
      // streamError 了，留着它们，退回选择器之后进度条还会挂着一个停住的数字。
      set({
        ...EMPTY_LIBRARY,
        phase: 'idle',
        error: (err as Error).message,
        errorDetail: (err as ApiError).detail ?? null,
      });
    }
  },

  async close(force = false) {
    // **先问服务端，再拆本地状态**——这个顺序和以前是反的，理由是服务端现在
    // 可能拒绝：该会话上还有访客在线时它回 409 `guests-online`（规格 §5.4）。
    // 抢先 teardown 掉的话，被拒绝之后界面还留在网格上、SSE 流却已经没了，
    // 摄影师看到的是一个"看起来还在、其实再也不会更新"的库——比直接关掉更糟。
    //
    // 代价是这次调用不再"立刻抢占" epoch，所以改成**记住**入口时的 epoch：
    // 服务端回来时它要是已经变了，说明期间有更新的 open()/close() 接手了
    // （close→open 反着排队完成），这次收尾一律作废，不能把它们冲掉。
    // 这跟原来那句 `if (myEpoch !== openEpoch) return` 守的是同一件事。
    const myEpoch = openEpoch;

    // 必须包 try/catch。以前这里是裸 await：服务端一旦 500（例如只读文件夹上
    // 落盘失败），下面的复位就永远不执行——"换文件夹"按钮在用户看来是坏的，
    // 界面停在旧文件夹上，控制台里多一条谁也不会去看的 unhandled rejection。
    // 本地复位跟服务端成不成功无关，失败只是额外多一条提示。
    let failure: string | null = null;
    let blocked: LibraryState['closeBlocked'] = null;
    try {
      // 不带 force 时请求体里连这个字段都没有：默认落点是不踢人。
      await postJSON('/api/library/close', force ? { force: true } : {});
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 409 && e.code === 'guests-online') {
        const online = e.body?.online;
        blocked = {
          online: typeof online === 'number' && Number.isFinite(online) ? online : null,
          message: e.message,
        };
      } else {
        failure = e.message;
      }
    }
    if (myEpoch !== openEpoch) return;

    // 被拒绝：本地状态**一个字段都不动**（库还开着、流还连着、标记还在），
    // 只多一条待确认的提示。确认之后 TopBar 会再调一次 close(true)。
    if (blocked) {
      set({ closeBlocked: blocked });
      return;
    }

    // 到这里才真的拆：关掉流（顺手唤醒还在等扫描的那次 open()，
    // 扫到一半按"换文件夹"是完全正常的操作），再抢占 epoch 让它自己作废。
    teardownStream();
    openEpoch++;

    setSessionId(null);
    resetClientState();
    set({ ...EMPTY_LIBRARY, phase: 'idle', error: failure, errorDetail: null });
  },

  dismissCloseBlock() {
    set({ closeBlocked: null });
  },

  async refresh() {
    if (get().refreshing) return;   // 连点两下只跑一趟；服务端也会合并，这里是省一次往返
    const myEpoch = openEpoch;
    set({ refreshing: true, error: null, errorDetail: null });
    try {
      const result = await postJSON<{ removed: number; added: number }>('/api/library/refresh', {});
      if (myEpoch !== openEpoch) return;   // 期间换了文件夹，这次收尾作废

      // 资产表要重新拉：服务端已经换过了，但它不通过 SSE 推整份表
      // （三千条资产一帧推出去只会把 SSE 的缓冲撑爆）。
      const lib = await getJSON<AssetsResult>('/api/library/assets');
      if (myEpoch !== openEpoch) return;

      // 悬空指针必须在 assets 落进 store 的**同一个同步段**里清掉，
      // 晚一帧子组件就会先用旧 cursor 渲染一次。
      useView.getState().pruneMissing(new Set(lib.assets.map((a) => a.id)));
      set({
        assets: lib.assets,
        warnings: lib.warnings ?? [],
        skippedFiles: lib.skippedFiles ?? 0,
        refreshResult: { removed: result.removed, added: result.added },
      });
    } catch (err) {
      if (myEpoch !== openEpoch) return;
      // 旧资产表一个字段都不动。这和 open() 失败退回选择器不一样：
      // 那时手上没有任何可用数据，这里已经有一份能用的。
      set({ error: (err as Error).message, errorDetail: (err as ApiError).detail ?? null });
    } finally {
      if (myEpoch === openEpoch) set({ refreshing: false });
    }
  },

  dismissRefreshResult() { set({ refreshResult: null }); },

  setCellWidth(px, persist = true) {
    // 钳制在这里也做一遍。服务端 store.js 是权威，但本地状态要立刻用于渲染，
    // 等一趟往返回来再钳制的话，中间那一帧网格会按一个非法宽度铺出来。
    const clamped = Math.min(CELL_WIDTH_MAX, Math.max(CELL_WIDTH_MIN, Math.round(px)));
    set((s) => ({ settings: { ...s.settings, cellWidth: clamped } }));
    if (!persist) return;
    if (cellWidthTimer) clearTimeout(cellWidthTimer);
    // 防抖这 400ms 足够走完一次「关库 + 开新库」——sessionId 是 api.ts 里的
    // 模块级变量，到时间点时可能已经指向下一个库了。不记住当时的 epoch 直接
    // 发的话，这条 PUT 会带着旧库的 cellWidth 打到新库头上，还会在新库当前
    // 活跃分享的审计日志里留下一条从没真的发生过的 settings.update——跟
    // open()/close() 到处校验的是同一类问题（旧的挂起异步操作在新操作之后
    // 才落地），所以用同一套 epoch 机制挡。
    const myEpoch = openEpoch;
    cellWidthTimer = setTimeout(() => {
      cellWidthTimer = null;
      if (myEpoch !== openEpoch) return; // 这 400ms 里换过库，这次落盘作废
      void putJSON('/api/library/settings', { cellWidth: clamped }).catch(() => {});
    }, 400);
  },
}));

// 任何一个请求撞上 409 session-gone，整个前端都要退回选择器：会话已经不在服务端
// 了，继续留在网格里的每一次标记、每一张缩略图都会接着 409。这里刻意不再调
// /api/library/close——那个会话已经没了，只会再换来一次 409。
setSessionGoneHandler(() => {
  teardownStream();
  openEpoch++;   // 让所有仍在 await 中的 open()/close() 收尾一律作废
  setSessionId(null);
  resetClientState();
  useLibrary.setState({
    ...EMPTY_LIBRARY,
    phase: 'idle',
    error: '会话已失效，请重新打开文件夹',
    errorDetail: null,
  });
});
