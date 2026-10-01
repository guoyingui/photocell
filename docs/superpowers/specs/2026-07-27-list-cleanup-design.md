# 列表清理：最近打开可删、顶栏去掉连拍滑块、左侧目录批量排除

**日期：** 2026-07-27
**状态：** 已确认，待实施

## 0. 一句话

三条互不相干的界面清理，**全部只动前端**：不新增接口、不新增权限、不改服务端一行代码。

| # | 要求（用户原话） | 落成什么 |
|---|---|---|
| 1 | 「选择照片文件夹 - 最近打开 增加删除功能」 | 每条记录右侧一个 ✕，把它从 localStorage 的 MRU 列表里移除 |
| 2 | 「去掉头部的连拍功能」 | 顶栏那个阈值滑块整块删掉；连拍分组本身保留 |
| 3 | 「左侧的文件夹下的分组增加删除功能」 | 每个目录右侧一个 ✕，把该目录下的照片**整批标成「排除」** |

第 3 条的语义由用户在设计问答中明确选定：**是标记，不是删文件**。备选的
「从磁盘删除」「从视图隐藏」均已被否掉。

---

## 1. 最近打开：每条一个 ✕

### 1.1 现状

`web/src/components/FolderPicker.tsx` 自己持有一份 localStorage 逻辑：

```ts
const RECENT_KEY = 'photocull.recent';
const readRecent = (): string[] => { /* JSON.parse，失败返回 [] */ };
export function rememberRecent(root: string) { /* 置顶、去重、slice(0, 8)、写回 */ }
```

组件里 `const recent = readRecent();` —— **每次渲染重读一次，没有任何 state**。
这一点直接决定了删除功能必须先改结构：删掉一条之后没有任何东西会触发重渲染，
列表在屏幕上不会变。

`rememberRecent` 虽然被 `export`，但**全仓库没有第二个 import**（只有 FolderPicker
自己在 `choose()` 里调）。FolderPicker 目前**零测试**。

### 1.2 抽出 `web/src/lib/recent.ts`

三个纯函数，全部返回**新列表**，让调用方直接 `setState` 而不必再读一次 localStorage：

```ts
const KEY = 'photocull.recent';
const LIMIT = 8;

export function readRecent(): string[];
export function rememberRecent(root: string): string[];
export function forgetRecent(root: string): string[];
```

- `readRecent()`：解析失败、不是数组 → `[]`。**并且滤掉非字符串元素**——这份数据
  存在 localStorage 里，任何人用开发者工具都能写进去，而函数签名声称返回
  `string[]`。今天那句 `Array.isArray(parsed) ? parsed : []` 是一句类型谎言。
- `rememberRecent(root)`：`[root, ...其余去重] .slice(0, LIMIT)`，写回，返回新列表。
- `forgetRecent(root)`：滤掉**全等**于 `root` 的项，写回，返回新列表。

写失败（隐私模式、配额超限）一律吞掉并**照常返回新列表**——沿用现有
`rememberRecent` 的取舍：记住"最近打开"是锦上添花，不能因此挡住主流程。
代价是刷新后那条会回来，这是已知且可接受的。

抽出来的理由和当初抽 `applyMark` 一样：FolderPicker 渲染的 `DirBrowser` 一挂载
就发两个请求，把纯逻辑留在组件里，就只能靠渲染整棵树才测得到。

### 1.3 组件改动

- `const [recent, setRecent] = useState(readRecent)` —— 惰性初始化，挂载时读一次。
- `choose()` 里 `setRecent(rememberRecent(root))`，然后照旧 `await open(root)`。
- 每条记录从"整行一个按钮"改成一行两个**并列**按钮（不是嵌套——嵌套 `<button>`
  是非法 HTML，并且会逼出一堆 `stopPropagation`）：

```tsx
<div className="picker-recent-row" key={p}>
  <button className="picker-recent-item" onClick={() => void choose(p)}
          disabled={phase === 'scanning'}>{p}</button>
  <button className="picker-recent-del" aria-label={`不再显示 ${p}`}
          title="从「最近打开」里移除。不会动磁盘上的文件夹"
          onClick={() => setRecent(forgetRecent(p))}>✕</button>
</div>
```

三条界面决定：

- **✕ 常驻显示，不是 hover 才出现。** 操作入口保持可见。
- **不做二次确认。** 误删的代价只是少一条快捷方式，重新打开一次就回来了。
- **`title` 必须写明"不会动磁盘上的文件夹"。** 在一个照片程序里，一个挨着路径的
  ✕ 天然会被读成"删掉这个文件夹"。这句话是这个按钮唯一的澄清机会。

- ✕ **不随 `phase === 'scanning'` 禁用**：它不碰 library，扫描期间删一条 MRU 记录
  没有任何副作用。旁边的"打开"按钮照旧禁用。

### 1.4 CSS

```css
.picker-recent-row { display: flex; gap: 4px; margin-bottom: 4px; }
.picker-recent-item { flex: 1; text-align: left; font-family: ui-monospace, monospace; }
.picker-recent-del { flex: 0 0 auto; }
```

`.picker-recent-item` 原有的 `display: block; width: 100%; margin-bottom: 4px` 由
行容器接管，删掉。

---

## 2. 顶栏去掉连拍滑块

### 2.1 删什么

`web/src/components/TopBar.tsx` 里这一整块：

```tsx
<label className="threshold" title="相邻两张间隔小于此值即归为一组连拍">
  连拍 {(threshold / 1000).toFixed(1)}s
  <input type="range" min={300} max={5000} step={100} value={threshold} … />
</label>
```

连同它带出来的两个订阅 `const threshold = useView((s) => s.threshold);`
和 `const setThreshold = useView((s) => s.setThreshold);`，以及 `styles.css` 里的
`.threshold` / `.threshold input` 两条规则。

### 2.2 不删什么

连拍分组**整套机制原样保留**：`lib/bursts.ts`、`StackCell`、`view.expanded`、
展开收起、`Esc` 收起、`flatOrder`、`resolveVisible` 一律不动。
`view.setThreshold` 也保留——`library.open()` 和 `GuestApp` 都要用它把
`marks.json` 里存的阈值装进 store。

### 2.3 必须说清楚的后果

**滑块是 `setThreshold(ms, persist = true)` 唯一的调用方。** 去掉之后：

- 阈值从此**无法在界面上修改**。每个文件夹用的就是它 `marks.json` 里存着的值；
  从没调过的用默认 1.0 秒（`view.ts` 的 `INITIAL.threshold = 1000`）。
- **已经调过阈值的老文件夹分组结果不变**——值照常读取、照常生效，消失的只是
  改它的入口。
- 服务端 `PUT /api/library/settings` **保留**（它在权限矩阵里、有测试、仍是
  admin-only），但前端从此不再调用它。这是一条有意留下的死路，不是遗漏。
- 访客侧本来就没有这个滑块（只在管理员的 `TopBar` 里），不受影响。

### 2.4 文档

`README.md` 的《连拍分组》一节现在写着：

> 阈值用顶栏滑块实时调整（0.3–5 秒），分组在前端计算，不发请求。

滑块一删这句就是假话，必须同步改成"阈值取自该文件夹 `marks.json` 里的设置
（默认 1.0 秒），界面上没有调整入口"。

---

## 3. 左侧目录：整批排除

### 3.1 现状

`web/src/components/Sidebar.tsx` 把 `dirCounts(assets)` 算出的目录列表渲染成一排
筛选按钮。**这个组件在管理员和访客两侧都会渲染**（`App.tsx:104` 与
`GuestApp.tsx:265`）。当 `dirs.length <= 1 && warnings.length === 0` 时整个组件
返回 `null`。

`dirCounts` 按 `a.dir` **全等**分组，不做前缀归并——`a/b` 和 `a/b/c` 是两个独立条目。
下面的批量操作沿用同一个判据，两处必须一致。

### 3.2 行为规格

每个目录行右侧一个 ✕，**只在 `useSession(s => s.canWrite())` 为真时渲染**。

- **作用对象**：`assets.filter(a => a.dir === dir).map(a => a.id)` —— 该目录下的
  **全部**照片。**不受当前标签页影响，也不受当前目录筛选影响**：站在「收藏」
  标签页上点它，排除的仍然是整个目录，不只是眼前看得见的那几张。
- **切换语义**：
  - 该目录的照片**全部**已是 `'reject'` → `applyMark(null, { targets })`（取消标记）
  - 否则（包括部分已排除、混着收藏）→ `applyMark('reject', { targets })`
- **外观**：全部已排除时 ✕ 高亮（`dir-exclude-on`），否则常态。
- **`title` / `aria-label`**：
  - 常态：`把 <目录名> 的 N 张照片整批排除`
  - 已全部排除：`取消排除 <目录名> 的 N 张照片`
- 「全部」那一行**没有** ✕。把整个库一键排掉不是一个有意义的动作。
- ✕ 与目录筛选按钮**并列**，不嵌套。

### 3.3 为什么是切换，而不是确认框

再次点击目录按钮表示取消整个目录的标记。需要恢复操作前混合的收藏、排除状态时，使用顶栏撤销或 `⌘/Ctrl+Z`。批量操作在历史中记作一步。

### 3.4 为什么不叫「删除」

用户的原话是"增加删除功能"，但选定的语义是"标成排除"。按钮就该叫排除：在一个
照片程序里，一个挨着文件夹名的「删除」，任何人都会读成"文件没了"。
界面文案一律用"排除"，`title` 把张数一并说出来。

### 3.5 数据流与开销

Sidebar 需要知道"这个目录是不是已经全排除了"，因此必须订阅 `marks`——这是它今天
没有的订阅，意味着**每按一次 P/X，Sidebar 都会重渲染一次**。

为了让这个代价有界，在 `web/src/lib/derive.ts` 新增一个纯函数：

```ts
export function dirRejected(assets: Asset[], marks: Marks): Map<string, number>;
```

一趟遍历算出"每个目录里有几张是 `'reject'`"，在 Sidebar 里
`useMemo(..., [assets, marks])`。于是每次标记变化的成本是 **一次 O(assets) 遍历**，
和 TopBar 现有的 `countByTab` 同一个量级，而不是"每个目录各扫一遍全库"的
O(assets × dirs)。

**Map 的约定：只为至少有一张被排除的目录建条目**，取不到即 0。判据因此是
`dirRejected.get(dir) === count`（`count` 来自已有的 `dirCounts`，恒 ≥ 1，
所以 `undefined` 永远不会误判成"全排除"）。

**不改 `dirCounts` 的返回结构**：它有自己的测试和调用点，为了多带一个字段去动它
的签名，只会让改动扩散到无关的地方。

### 3.6 权限：三道门禁一道都不少

1. **服务端**：`PUT /api/library/marks` 上的 `requirePerm('write')` → 只读访客 403。
2. **组件层**：`canWrite()` 为 false 时 ✕ **根本不渲染**，不进 DOM。不是置灰——
   只读界面只展示有权限的操作。
3. **`applyMark` 内部**：`if (!useSession.getState().canWrite()) return false`，已经存在。

判据一律用 `useSession.getState().canWrite()`，**不准就地写 `role === 'viewer'`**：
`canWrite()` 是默认拒绝的（`kind === 'none'` 时返回 false），而 role 判等是默认放行。

写操作走**已有的** `applyMark('reject', { targets })`，不新开路径：撤销栈、SSE 广播、
归属记录（marksMeta）全都自动带上。`setMark(ids, mark)` 对一次调用只压**一条**
撤销记录（`marks.ts:197`），所以一次 `⌘Z` 撤销整个文件夹。

不传 `order` → 不推进光标。批量操作不该把光标挪到别处去。

### 3.7 文档

`README.md` 的《鼠标与键盘怎么标记》一节补一句：左侧目录列表每项的 ✕ 是"把这个
文件夹整批排除"，再点一次取消。那一节是全篇唯一讲"没有键盘时怎么标记"的地方，
新开一个标记入口却不写进去，等于让它只能靠人乱点撞见。

### 3.8 CSS

```css
.dir-row { display: flex; gap: 4px; align-items: center; margin-bottom: 2px; }
.dir-row .dir { width: auto; flex: 1; min-width: 0; margin-bottom: 0; }
.dir-exclude { flex: 0 0 auto; }
.dir-exclude-on { border-color: var(--accent); }
```

`.dir` 这条基础规则**一个字都不改**。它有两类使用者：目录行里的那些进了 `.dir-row`
（flex 容器），但「全部」那个按钮是 `aside.sidebar` 的直接子元素，不在任何 flex
容器里——删掉 `width: 100%` 之后 `flex: 1` 对它毫无作用，它会退回 inline-block
缩成文字宽。所以只用后代选择器覆盖进了行容器的那些。

---

## 4. 文件清单

| 文件 | 改动 |
|---|---|
| `web/src/lib/recent.ts` | **新建**：`readRecent` / `rememberRecent` / `forgetRecent` |
| `web/src/lib/recent.test.ts` | **新建**：node 环境，测试里自备 localStorage 桩 |
| `web/src/components/FolderPicker.tsx` | 改用 `lib/recent`，`recent` 变 state，每行加 ✕ |
| `web/src/components/FolderPicker.test.tsx` | **新建**：`vi.mock('../lib/api')` 挡住 DirBrowser 的请求 |
| `web/src/components/TopBar.tsx` | 删滑块与两个订阅 |
| `web/src/components/TopBar.test.tsx` | 加一条"顶栏里不该再有 range 输入"的回归守卫 |
| `web/src/lib/derive.ts` | **新增** `dirRejected(assets, marks)` |
| `web/src/lib/derive.test.ts` | 补 `dirRejected` 的用例 |
| `web/src/components/Sidebar.tsx` | 每个目录行加 ✕（受 `canWrite()` 门禁） |
| `web/src/components/Sidebar.test.tsx` | **新建**（该组件目前零测试） |
| `web/src/styles.css` | 加 `.picker-recent-row` / `.picker-recent-del` / `.dir-row` / `.dir-exclude*`；删 `.threshold*` |
| `README.md` | 《连拍分组》改掉滑块那句；《鼠标与键盘怎么标记》补一句整批排除 |

**服务端零改动。**

## 5. 测试规格

### 5.1 `lib/recent.test.ts`（node 环境）

`vitest.config.js` 把 `web/src/**/*.test.ts` 分给了 `environment: 'node'` 的 project，
**node 里没有 `localStorage`**（已实测 `typeof localStorage === 'undefined'`）。
测试自备一个最小 Storage 桩挂到 `globalThis`，并在 `afterEach` 清理。

- 空存储 → `[]`
- 坏 JSON → `[]`，不抛
- 不是数组（`{"a":1}`）→ `[]`
- 数组里混了非字符串 → 只留字符串
- `rememberRecent` 置顶且去重
- `rememberRecent` 超过 8 条时丢掉最旧的
- `forgetRecent` 只删全等的那条，其余顺序不变
- `forgetRecent` 删一个不存在的路径 → 列表不变
- 写入抛异常（桩的 `setItem` 直接 throw）→ 不抛出去，且**照常返回新列表**

### 5.2 `FolderPicker.test.tsx`（jsdom）

照 `App.test.tsx` 的先例 `vi.mock('../lib/api', …)`，让 DirBrowser 的
`/api/fs/roots` 和 `/api/fs/list` 拿到空响应——否则 jsdom 里会留下未处理的拒绝，
违反"输出必须干净"。

- 有 N 条记录 → 渲染 N 个 ✕
- 点某条的 ✕ → 那条从 DOM 消失、其余还在、localStorage 里也没了
- 一条不剩时整个「最近打开」区块消失（现有的 `recent.length > 0` 判断）
- ✕ 在 `phase === 'scanning'` 时**仍可点**

排序行为归 `lib/recent.test.ts`，组件测试不碰 `open()`。

### 5.3 `Sidebar.test.tsx`（jsdom）

`Sidebar` 在 `dirs.length <= 1 && warnings.length === 0` 时返回 `null`，
所有用例的夹具至少两个目录。每个 `.test.tsx` 必须自己 `afterEach(cleanup)`
（本仓库没有 `test.globals`）。

1. `role: 'viewer'` → **一个 ✕ 都不在 DOM 里**
2. `kind: 'none'`（身份还没解析出来）→ 同样不渲染（默认拒绝）
3. admin 点某目录的 ✕ → 该目录全部变 `'reject'`
4. 别的目录一张都没被碰
5. 该目录已全部 `'reject'` → 按钮带 `dir-exclude-on`，点它变成全部无标记
6. 该目录一张 `pick` 一张 `reject` → 点了**全变 reject**（不是取消）
7. `tab = 'pick'` 时点 ✕ → 仍作用于该目录全部照片
8. 「全部」那一行没有 ✕

### 5.4 `derive.test.ts`

- `dirRejected` 只数 `'reject'`，不数 `'pick'` 和未标记
- 目录一张都没排除时 → 该目录**不在** Map 里（约定见 §3.5：只为至少有一张被排除的
  目录建条目）
- 跨目录不串味

### 5.5 `TopBar.test.tsx`

加一条：渲染后 `container.querySelector('input[type="range"]')` 为 `null`。
现有 7 条用例必须原样通过。

### 5.6 突变验证（沿用上一轮的做法）

第 3 条的两条安全用例（viewer / kind='none' 不渲染 ✕）必须**在功能写出来之前
就是绿的**——因为那时按钮根本不存在。所以实现完成后要把 `canWrite()` 判断摘掉
跑一次，确认**恰好这两条变红**、其余不动。不这么验一次，这两条用例是不是在空转
无从判断。

## 6. 明确不做的事

- **不删磁盘上的任何文件。** 本次改动不引入任何删除用户文件的能力，服务端
  依然只有导出「移动」模式那一条 `fs.rm`。
- **不做目录隐藏。** "看不见但仍然是收藏、导出还会带上"是这份代码里反复警告过的
  那类不可见状态。
- **不给目录做批量收藏。** 用户只要了排除。
- **不动连拍分组本身**，也不删 `PUT /api/library/settings`。
- 标记撤销与重做统一使用现有历史，不另建目录专属历史。

## 7. 验收

- `npm test` 全绿，`npx tsc --noEmit` 干净，`npm run build` 通过。
- 浏览器里逐条走一遍：删一条最近打开并刷新确认没回来；顶栏没有滑块且连拍组
  照样能展开收起；点目录 ✕ 后该目录整批出现排除角标、`⌘Z` 一次全数复原、
  再点 ✕ 一次取消。
- 只读验收使用另一台电脑的浏览器（回环一律判成管理员，访客路径在本机走不到）：
  把访客改成只读后，他那一屏的目录 ✕ 必须**消失**。
