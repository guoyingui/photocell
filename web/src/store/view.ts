import { create } from 'zustand';
import { putJSON } from '../lib/api';
import type { FilterTab } from '../types';

interface ViewState {
  tab: FilterTab;
  dirFilter: string | null;
  /**
   * 按客户维度筛选：只看这个人碰过的。null = 不筛。仅管理员用得到。
   *
   * **它只改变看到什么，不改变标记的身份**：筛着「新娘」的时候按 P，
   * 记进 contrib 的仍然是 admin（你自己）。没有任何入口能代替别人投票——
   * 那会直接毁掉审计的价值。
   */
  clientFilter: string | null;
  threshold: number;
  expanded: Set<string>;
  cursor: string | null;
  anchor: string | null;
  selection: Set<string>;
  lightbox: string | null;
  compare: { reference: string; candidate: string } | null;
  // view.ts 不认识 Group/Asset，没法自己判断某个 id 折叠后是否还可见，
  // 所以这段"给定 id 和当前 expanded 集合，算出应该显示成哪个 id"的判断
  // 由拥有分组数据的上层（App.tsx）注入；默认是恒等函数，在上层还没注册前
  // toggleExpand/collapseAll 的自愈逻辑就是无操作，不会误伤 cursor。
  resolveVisible: (id: string, expanded: Set<string>) => string;
  setResolveVisible: (fn: (id: string, expanded: Set<string>) => string) => void;
  /** 换文件夹时的硬复位。由 useLibrary.open()/close() 调用，见下方注释。 */
  reset: () => void;
  setTab: (tab: FilterTab) => void;
  setDirFilter: (dir: string | null) => void;
  setClientFilter: (id: string | null) => void;
  setThreshold: (ms: number, persist?: boolean) => void;
  toggleExpand: (key: string) => void;
  collapseAll: () => void;
  setCursor: (id: string | null, opts?: { extend?: boolean; order?: string[] }) => void;
  clearSelection: () => void;
  /** ⌘/Ctrl 点一格。只加减 selection，不动 cursor/anchor。 */
  toggleSelect: (id: string) => void;
  /** 框选结束时整批替换选区。空数组等于清空。 */
  setSelection: (ids: string[]) => void;
  openLightbox: (id: string) => void;
  closeLightbox: () => void;
  openCompare: (reference: string, candidate: string) => void;
  closeCompare: () => void;
  /**
   * 把 cursor / lightbox / selection 里已经不在 `ids` 中的成员清掉。
   *
   * 刷新之后必须调一次。和 setTab / setDirFilter 清空 cursor 是同一类问题
   * （见那两个 setter 的注释），只是这里的资产是**真的从磁盘上没了**，
   * 而不是暂时被筛掉——留着一个指向不存在文件的 cursor，下一次 P/X
   * 会往服务端发一个必然 400「未知资产」的请求。
   */
  pruneMissing: (ids: Set<string>) => void;
}

const INITIAL = {
  tab: 'all' as FilterTab,
  dirFilter: null,
  clientFilter: null,
  threshold: 1000,
  expanded: new Set<string>(),
  cursor: null,
  anchor: null,
  selection: new Set<string>(),
  lightbox: null,
  compare: null,
  // 恒等函数：resolveVisible 由 App 在拿到 groups 之后注入。换文件夹时必须一起
  // 复位——留着的那个闭包捕获的是上一个文件夹的 groups，会把新文件夹的 id 映射
  // 到一个根本不存在的"出头"上。
  resolveVisible: (id: string) => id,
};

export const useView = create<ViewState>((set, get) => ({
  ...INITIAL,
  setResolveVisible: (fn) => set({ resolveVisible: fn }),

  // 换文件夹是一次硬复位。这些字段每一个都是"上一个文件夹里的 id / 上一个文件夹
  // 才有的目录名"，留到下一个文件夹里全是错的，而且错得没有任何提示：
  //   - selection 非空时 useKeyboard 拿它当标记目标（markTargets），两台同型号机身
  //     拍出的 IMG_0002 在两个文件夹里就是同一个 id，按一下 P 就会静默标记一张
  //     用户根本没在看的照片，并且直接流进导出。
  //   - dirFilter 指向一个新文件夹里不存在的目录时，网格空、而 Sidebar 因为
  //     dirs.length <= 1 整个不渲染，连清除筛选的"全部"按钮都没有——死局。
  //   - tab / expanded / cursor / anchor / lightbox 同理，都是悬空指针。
  // 必须在 phase 变成 'ready' 之前同步跑完，晚一帧都会让子组件先用旧数据渲染一次。
  reset: () => set({ ...INITIAL, expanded: new Set(), selection: new Set() }),

  // tab/目录切换会改变 filterAssets 算出来的可见集合，cursor 和 lightbox
  // 可能指向一个已经不在可见集合里的资产（比如切到「已排除」但当前 cursor 是张未标记的图）。
  // view.ts 拿不到 assets/marks（那些在别的 store 里），没法判断 cursor 指向的资产
  // 是否还可见，所以统一清空，而不是留着一个可能失效的指针——
  // 这样组件用 order.indexOf(cursor) 做键盘导航时不会静默拿到 -1，lightbox 也不会停在一张已经被筛掉的图上。
  setTab: (tab) => set({ tab, selection: new Set(), anchor: null, cursor: null, lightbox: null, compare: null }),
  setDirFilter: (dirFilter) =>
    set({ dirFilter, selection: new Set(), anchor: null, cursor: null, lightbox: null, compare: null }),

  // 和 setTab / setDirFilter 同一条规矩：改变可见集合就要清掉可能悬空的指针。
  setClientFilter: (clientFilter) =>
    set({ clientFilter, selection: new Set(), anchor: null, cursor: null, lightbox: null, compare: null }),

  setThreshold(ms, persist = false) {
    // 阈值变化只改变连拍分组，不会把任何资产逐出 filterAssets 的可见集合，
    // 所以这里不清空 cursor —— 与 tab/目录切换不同，它不会产生「指向一个不存在的资产」的悬空指针。
    // cursor 指向的资产有可能从组内的“出头”位置变成被折叠组吞掉的非出头成员，
    // 但要不要因此挪动 cursor（挪到组的哪个成员上）取决于网格怎么渲染折叠组，
    // 而这是 Task 14 才会实现的东西，此刻并不存在。并且 threshold 通常来自一个
    // 连续拖动的滑块，如果每次改动都清空 cursor，拖动过程中键盘导航位置会被反复打断，
    // 体验上比偶尔的悬空指针更差。所以这里把这个问题留给未来的网格组件在渲染折叠组时处理。
    set({ threshold: ms, expanded: new Set() });   // 阈值一变，展开状态失去意义
    if (persist) void putJSON('/api/library/settings', { burstThresholdMs: ms }).catch(() => {});
  },

  toggleExpand(key) {
    const next = new Set(get().expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    set({ expanded: next });
    // 收起会让这个组只剩"出头"一张可见。如果光标恰好停在这个组内某个非出头
    // 成员上（比如之前点开过展开条里的某一张），resolveVisible 会把它映射回
    // 组的出头 id；如果光标属于别的组或者根本不受这次切换影响，原样返回，
    // 不做无谓的挪动。这样无论调用方是键盘 Escape 还是卡牌堆上的收起按钮，
    // 光标都不会悬空指向一张刚从视图里消失的资产。
    const { cursor, resolveVisible } = get();
    if (cursor) {
      const visible = resolveVisible(cursor, next);
      if (visible !== cursor) get().setCursor(visible);
    }
  },

  collapseAll: () => {
    set({ expanded: new Set() });
    const { cursor, resolveVisible } = get();
    if (cursor) {
      const visible = resolveVisible(cursor, new Set());
      if (visible !== cursor) get().setCursor(visible);
    }
  },

  setCursor(id, opts = {}) {
    if (id === null) return set({ cursor: null, selection: new Set(), anchor: null });
    if (opts.extend && opts.order && get().anchor) {
      const order = opts.order;
      const from = order.indexOf(get().anchor!);
      const to = order.indexOf(id);
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        return set({ cursor: id, selection: new Set(order.slice(lo, hi + 1)) });
      }
    }
    set({ cursor: id, anchor: id, selection: new Set([id]) });
  },

  clearSelection: () => set({ selection: new Set(), anchor: null }),

  pruneMissing: (ids) => set((s) => {
    const selection = new Set([...s.selection].filter((id) => ids.has(id)));
    return {
      cursor: s.cursor && ids.has(s.cursor) ? s.cursor : null,
      anchor: s.anchor && ids.has(s.anchor) ? s.anchor : null,
      lightbox: s.lightbox && ids.has(s.lightbox) ? s.lightbox : null,
      compare: s.compare && ids.has(s.compare.reference) && ids.has(s.compare.candidate) ? s.compare : null,
      selection,
    };
  }),

  // 不碰 cursor/anchor：多选模式下勾选表达的是"这张我要"，不是"我看到这张"。
  // 把光标一起挪走会让退回单选模式后的键盘导航停在最后勾的那张上，
  // 而用户心里的位置还在他滚到的地方。
  toggleSelect: (id) => set((s) => {
    const selection = new Set(s.selection);
    if (selection.has(id)) selection.delete(id);
    else selection.add(id);
    return { selection };
  }),

  setSelection: (ids) => {
    if (ids.length === 0) return set({ selection: new Set(), cursor: null, anchor: null });
    set({
      selection: new Set(ids),
      cursor: ids[ids.length - 1],
      anchor: ids[0],
    });
  },

  // 打开大图即"聚焦到这一张"：不仅让 cursor 跟过去，还要把 selection 收敛成
  // 只剩这一张。不这样做的后果很隐蔽——如果用户之前 Shift+方向键 框选了一段
  // 连续范围（selection 不是空集），再 Enter 打开其中某一张进大图，selection
  // 不会因为进了大图就自动清空；这时候如果在大图里按 P/X，useKeyboard 的
  // setMark 会以 selection（那一整段范围）而不是"当前看到的这一张"作为操作
  // 对象——摄影师明明只盯着一张照片按了拒绝，实际却把没在看的另外好几张也
  // 一起标记了，而大图角标只显示当前这一张的状态，不会有任何提示。所以进大图
  // 这一刻就把 selection 塌缩成单张，让"大图里操作 = 只影响当前这一张"变成
  // 一个不用调用方（useKeyboard）每次都记得检查 lightbox 状态才能维持的不变量。
  openLightbox: (id) => set({ lightbox: id, compare: null, cursor: id, anchor: id, selection: new Set([id]) }),
  closeLightbox: () => set({ lightbox: null }),
  openCompare: (reference, candidate) => {
    if (reference === candidate) return;
    set({ compare: { reference, candidate }, lightbox: null,
      cursor: candidate, anchor: candidate, selection: new Set([candidate]) });
  },
  closeCompare: () => set({ compare: null }),
}));
