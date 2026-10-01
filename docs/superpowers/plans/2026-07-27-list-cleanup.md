# 列表清理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「最近打开」的每条记录可以删掉、顶栏不再有连拍阈值滑块、左侧每个目录可以把它的照片整批标成「排除」。

**Architecture:** 三条改动互不相干，**全部只动前端**：不新增接口、不新增权限、服务端一行不改。localStorage 的 MRU 逻辑从 FolderPicker 抽成 `lib/recent.ts` 以便脱离组件树测试；目录批量排除复用已有的唯一标记入口 `applyMark`，因此撤销栈、SSE 广播、归属记录全部自动带上。

**Tech Stack:** React 19 + zustand 5 + TypeScript（`strict`，`noUnusedLocals`）、vitest 4（`test.projects`：`web/src/**/*.test.ts` 跑 node、`web/src/**/*.test.tsx` 跑 jsdom）、@testing-library/react。

**规格：** `docs/superpowers/specs/2026-07-27-list-cleanup-design.md`

## Global Constraints

- **门禁判据一律用 `useSession.getState().canWrite()`**，任何地方都不准就地写 `role === 'viewer'`。`canWrite()` 是默认拒绝的（`kind === 'none'` 时返回 false），role 判等是默认放行。
- **`canWrite()` 为 false 时，标记入口一律不渲染**（不进 DOM），不是置灰。
- **不删磁盘上的任何文件。** 本计划不引入任何删除用户文件的能力。
- **界面文案用「排除」，不用「删除」。** 左侧目录那个按钮标成 reject，不动文件。
- **每个 `.test.tsx` 必须自己写 `afterEach(cleanup)`** —— 本仓库没有 `test.globals`，testing-library 的自动清理不会注册。
- **`web/src/**/*.test.ts` 跑在 node 环境，没有 `localStorage`**（node 22 要 `--experimental-webstorage` 才有）。需要它的测试自备桩。
- **提交信息用中文，说清"为什么"**，末尾空一行后加 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`。
- 每个 Task 结束时 `npm test` 必须全绿，最后一个 Task 另加 `npx tsc --noEmit` 和 `npm run build`。
- 基线：**69 个测试文件 / 1310 个用例**全绿。

---

## 文件结构

| 文件 | 职责 | 谁改 |
|---|---|---|
| `web/src/lib/recent.ts` | **新建**。localStorage 里的「最近打开」MRU 列表，三个纯函数 | Task 1 |
| `web/src/lib/recent.test.ts` | **新建**。node 环境，自备 localStorage 桩 | Task 1 |
| `web/src/components/FolderPicker.tsx` | 改用 `lib/recent`，`recent` 变 state，每行加 ✕ | Task 2 |
| `web/src/components/FolderPicker.test.tsx` | **新建**。jsdom，替身掉 `../lib/api` | Task 2 |
| `web/src/components/TopBar.tsx` | 删掉连拍滑块与它带出来的两个订阅 | Task 3 |
| `web/src/components/TopBar.test.tsx` | 加一条"顶栏里不该再有 range 输入"的回归守卫 | Task 3 |
| `web/src/lib/derive.ts` | **新增** `dirRejected(assets, marks)` | Task 4 |
| `web/src/lib/derive.test.ts` | 补 `dirRejected` 的用例 | Task 4 |
| `web/src/components/Sidebar.tsx` | 每个目录行加 ✕（受 `canWrite()` 门禁） | Task 5 |
| `web/src/components/Sidebar.test.tsx` | **新建**。该组件目前零测试 | Task 5 |
| `web/src/styles.css` | 加行容器与按钮样式；删 `.threshold*` | Task 2 / 3 / 5 |
| `README.md` | 《连拍分组》改掉滑块那句；《鼠标与键盘怎么标记》补整批排除 | Task 3 / 6 |

---

## Task 1: `lib/recent.ts` —— 把 MRU 逻辑搬出组件

**Files:**
- Create: `web/src/lib/recent.ts`
- Create: `web/src/lib/recent.test.ts`

**Interfaces:**
- Consumes: 无（纯模块，只依赖 `localStorage`）
- Produces:
  - `readRecent(): string[]`
  - `rememberRecent(root: string): string[]` —— 置顶去重截断，返回写入后的新列表
  - `forgetRecent(root: string): string[]` —— 移除一条，返回写入后的新列表

**背景：** 现在这段逻辑写在 `web/src/components/FolderPicker.tsx` 顶部（`RECENT_KEY` / `readRecent` / `rememberRecent`）。`rememberRecent` 虽然 `export` 了，但**全仓库没有第二个 import**。搬出来的理由：FolderPicker 一渲染就会拉起 `DirBrowser`，而它挂载即发两个请求，纯逻辑留在组件里就只能靠渲染整棵树才测得到。

本 Task **只新增文件，不动 FolderPicker**（那是 Task 2）。所以做完这一步会有短暂的重复代码，这是有意的：两件事分开提交，出问题时能各自回退。

- [ ] **Step 1: 写失败的测试**

创建 `web/src/lib/recent.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetRecent, readRecent, rememberRecent } from './recent';

/**
 * 这个文件跑在 **node** 环境（vitest.config.js 把 `web/src/**\/*.test.ts` 分给了
 * `environment: 'node'` 那个 project），而 node 22 默认没有 `localStorage`
 * —— 要 `--experimental-webstorage` 才有。所以桩由测试自己提供。
 *
 * 用真的桩而不是 vi.mock 掉整个模块：这一组要验的恰恰是"读到脏数据 / 写不进去
 * 的时候会发生什么"，把 Storage 换成替身才测得到那些分支。
 */
class FakeStorage {
  map = new Map<string, string>();
  throwOnSet = false;
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void {
    if (this.throwOnSet) throw new Error('QuotaExceededError');
    this.map.set(k, v);
  }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
  key(): string | null { return null; }
  get length(): number { return this.map.size; }
}

const KEY = 'photocull.recent';
const g = globalThis as unknown as Record<string, unknown>;
let store: FakeStorage;

const seed = (value: unknown) => { store.map.set(KEY, JSON.stringify(value)); };

beforeEach(() => {
  store = new FakeStorage();
  g.localStorage = store;
});

afterEach(() => {
  delete g.localStorage;
});

describe('readRecent', () => {
  it('没存过时返回空列表', () => {
    expect(readRecent()).toEqual([]);
  });

  it('存的不是合法 JSON 时返回空列表，不抛', () => {
    store.map.set(KEY, '{这不是 JSON');
    expect(readRecent()).toEqual([]);
  });

  it('存的不是数组时返回空列表', () => {
    seed({ a: 1 });
    expect(readRecent()).toEqual([]);
  });

  // localStorage 里的内容任何人用开发者工具都能改，而这个函数的签名声称
  // 返回 string[]。数组里混进别的类型时必须滤掉，否则那句声明就是谎话。
  it('滤掉数组里的非字符串元素', () => {
    seed(['/a', 42, null, '/b', { p: '/c' }]);
    expect(readRecent()).toEqual(['/a', '/b']);
  });
});

describe('rememberRecent', () => {
  it('新路径置顶', () => {
    seed(['/a', '/b']);
    expect(rememberRecent('/c')).toEqual(['/c', '/a', '/b']);
  });

  it('已经在列表里的路径被提到最前面，不重复出现', () => {
    seed(['/a', '/b', '/c']);
    expect(rememberRecent('/c')).toEqual(['/c', '/a', '/b']);
  });

  it('超过 8 条时丢掉最旧的', () => {
    seed(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(rememberRecent('9')).toEqual(['9', '1', '2', '3', '4', '5', '6', '7']);
  });

  it('真的写进了 localStorage', () => {
    rememberRecent('/a');
    expect(JSON.parse(store.map.get(KEY)!)).toEqual(['/a']);
  });
});

describe('forgetRecent', () => {
  it('只删掉全等的那一条，其余顺序不变', () => {
    seed(['/a', '/b', '/c']);
    expect(forgetRecent('/b')).toEqual(['/a', '/c']);
    expect(JSON.parse(store.map.get(KEY)!)).toEqual(['/a', '/c']);
  });

  it('删一个不在列表里的路径，列表不变', () => {
    seed(['/a', '/b']);
    expect(forgetRecent('/zzz')).toEqual(['/a', '/b']);
  });

  it('删光之后是空列表', () => {
    seed(['/a']);
    expect(forgetRecent('/a')).toEqual([]);
  });
});

describe('写不进去的时候', () => {
  // 隐私模式、配额超限。记住"最近打开"是锦上添花，不能因此挡住打开流程，
  // 所以异常一律吞掉；但**返回值照常是新列表**，界面这一刻是对的。
  // 代价是刷新之后这次改动会消失，这是已知的取舍。
  it('rememberRecent 不抛，并照常返回新列表', () => {
    seed(['/a']);
    store.throwOnSet = true;
    expect(() => rememberRecent('/b')).not.toThrow();
    expect(rememberRecent('/b')).toEqual(['/b', '/a']);
  });

  it('forgetRecent 不抛，并照常返回新列表', () => {
    seed(['/a', '/b']);
    store.throwOnSet = true;
    expect(forgetRecent('/a')).toEqual(['/b']);
  });
});
```

- [ ] **Step 2: 跑它，确认是红的**

```bash
npx vitest run web/src/lib/recent.test.ts
```

预期：FAIL，报 `Failed to resolve import "./recent"`（文件还不存在）。

- [ ] **Step 3: 写实现**

创建 `web/src/lib/recent.ts`：

```ts
/**
 * 「最近打开」的 MRU 列表。存在 localStorage 里，只对这一台机器的这一个浏览器
 * 有意义——它不是选片数据，不跟着照片文件夹走。
 *
 * 从 FolderPicker 里搬出来的。搬的理由是那个组件一渲染就会拉起 DirBrowser，
 * 而 DirBrowser 挂载即发两个请求；把这段纯逻辑留在组件里，就只能靠渲染整棵树、
 * 连带替身掉整个 api 模块才测得到。
 *
 * 三个函数都返回**写入后的新列表**，让调用方直接 setState，
 * 不必再读一次 localStorage（也就不会读到一次失败的写留下的旧值）。
 */
const KEY = 'photocull.recent';
const LIMIT = 8;

function write(list: string[]): string[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // 配额超限、隐私模式，以及 localStorage 整个不存在的环境。一律吞掉：
    // 记住"最近打开"是锦上添花，不能因此挡住打开文件夹这条主流程。
  }
  return list;
}

/**
 * 读出来的东西**必须当成不可信输入**：localStorage 里的内容任何人用开发者工具
 * 都能改，而这个函数的签名声称返回 `string[]`。所以除了"解析失败 / 不是数组"
 * 之外，还要把数组里的非字符串元素滤掉——否则那句返回类型就是一行谎话。
 */
export function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    return [];
  }
}

/** 置顶 + 去重 + 截断到 8 条。 */
export function rememberRecent(root: string): string[] {
  return write([root, ...readRecent().filter((p) => p !== root)].slice(0, LIMIT));
}

/** 从列表里移除一条。**只动这份记录，不碰磁盘上的文件夹。** */
export function forgetRecent(root: string): string[] {
  return write(readRecent().filter((p) => p !== root));
}
```

- [ ] **Step 4: 跑它，确认是绿的**

```bash
npx vitest run web/src/lib/recent.test.ts
```

预期：PASS，13 个用例。

- [ ] **Step 5: 提交**

```bash
git add web/src/lib/recent.ts web/src/lib/recent.test.ts
git commit -F - <<'MSG'
refactor: 把「最近打开」的 MRU 逻辑抽成 lib/recent

原来这三个函数写在 FolderPicker 顶部。抽出来是为了能测：FolderPicker 一渲染
就拉起 DirBrowser，而它挂载即发两个请求，纯逻辑留在组件里就只能靠渲染整棵树、
连带替身掉整个 api 模块才碰得到。

顺手补掉一句类型谎言：原来的 readRecent 只判 Array.isArray，数组里混进数字或
null 照样原样返回，而签名写的是 string[]。这份数据存在 localStorage 里，任何人
用开发者工具都能改，所以按不可信输入处理，滤掉非字符串。

三个函数都返回写入后的新列表，让调用方直接 setState——不必再读一次
localStorage，也就不会读到一次失败的写留下的旧值。

本次不动 FolderPicker，它仍在用自己那份。接线是下一个提交，分开是为了出问题
时能各自回退。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

## Task 2: 最近打开每条一个 ✕

**Files:**
- Modify: `web/src/components/FolderPicker.tsx`
- Create: `web/src/components/FolderPicker.test.tsx`
- Modify: `web/src/styles.css:39`

**Interfaces:**
- Consumes: `readRecent()` / `rememberRecent(root)` / `forgetRecent(root)`（Task 1）
- Produces: 无（组件内部改动）

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/FolderPicker.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderPicker } from './FolderPicker';
import { useLibrary } from '../store/library';

/**
 * DirBrowser 一挂载就发两个请求（`/api/fs/roots` 和 `/api/fs/list`）。不替身掉
 * 会在 jsdom 里留下未处理的拒绝——本仓库要求测试输出干净。照 App.test.tsx 的
 * 先例替身整个 api 模块，而不是去 stub fetch。
 */
vi.mock('../lib/api', () => ({
  getJSON: vi.fn((path: string) => (
    path.includes('/api/fs/roots')
      ? Promise.resolve({ roots: [], home: '/tmp' })
      : Promise.resolve({ path: '/tmp', parent: '/tmp', dirs: [] })
  )),
  postJSON: vi.fn(() => new Promise(() => {})),
  putJSON: vi.fn(),
  openStream: vi.fn(() => () => {}),
  withSid: (u: string) => u,
  setSessionId: vi.fn(),
  getSessionId: vi.fn(() => null),
  setSessionGoneHandler: vi.fn(),
}));

const KEY = 'photocull.recent';

beforeEach(() => {
  localStorage.clear();
  useLibrary.setState({
    phase: 'idle', root: null, assets: [], metas: new Map(),
    error: null, errorDetail: null,
  });
});

// 本仓库没有 test.globals，testing-library 的自动 cleanup 不会注册，
// 不写这一句 DOM 会跨用例泄漏。
afterEach(() => { cleanup(); });

const delButtons = () => screen.queryAllByRole('button', { name: /不再显示/ });

describe('FolderPicker：最近打开可以逐条删掉', () => {
  it('每条记录都有一个删除按钮', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a', '/b', '/c']));
    render(<FolderPicker />);
    expect(delButtons()).toHaveLength(3);
  });

  it('点某条的 ✕：那条从界面消失，其余还在', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a', '/b', '/c']));
    render(<FolderPicker />);
    fireEvent.click(screen.getByRole('button', { name: '不再显示 /b' }));
    expect(screen.queryByRole('button', { name: '/b' })).toBeNull();
    expect(screen.getByRole('button', { name: '/a' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '/c' })).toBeTruthy();
  });

  it('删掉的那条也从 localStorage 里没了', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a', '/b']));
    render(<FolderPicker />);
    fireEvent.click(screen.getByRole('button', { name: '不再显示 /a' }));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['/b']);
  });

  it('删光之后整个「最近打开」区块消失', () => {
    localStorage.setItem(KEY, JSON.stringify(['/only']));
    render(<FolderPicker />);
    fireEvent.click(screen.getByRole('button', { name: '不再显示 /only' }));
    expect(screen.queryByText('最近打开')).toBeNull();
  });

  // ✕ 不碰 library，扫描期间删一条 MRU 记录没有任何副作用；
  // 旁边那个"打开"按钮则照旧禁用。
  it('扫描期间 ✕ 仍然可点，而路径按钮被禁用', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a']));
    useLibrary.setState({ phase: 'scanning' });
    render(<FolderPicker />);
    expect(screen.getByRole('button', { name: '不再显示 /a' })).not.toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '/a' })).toHaveProperty('disabled', true);
  });
});
```

- [ ] **Step 2: 跑它，确认是红的**

```bash
npx vitest run web/src/components/FolderPicker.test.tsx
```

预期：FAIL —— 找不到名字匹配 `/不再显示/` 的按钮（`delButtons()` 返回 `[]`）。

- [ ] **Step 3: 改组件**

编辑 `web/src/components/FolderPicker.tsx`。

删掉文件顶部这三段（`RECENT_KEY`、`readRecent`、`rememberRecent`），改成从 Task 1 的模块导入：

```tsx
import { useState } from 'react';
import { useLibrary } from '../store/library';
import { forgetRecent, readRecent, rememberRecent } from '../lib/recent';
import { DirBrowser } from './DirBrowser';
```

把 `const recent = readRecent();` 换成 state。**这一步是删除功能能成立的前提**：
原来它每次渲染重读一次 localStorage、没有任何 state，删掉一条之后没有东西会触发
重渲染，列表在屏幕上不会变。

```tsx
export function FolderPicker() {
  const [here, setHere] = useState('');
  const [manual, setManual] = useState('');
  // 惰性初始化：挂载时读一次。三个 recent 函数都返回写入后的新列表，
  // 所以之后每次改动直接 setState，不再回头读 localStorage。
  const [recent, setRecent] = useState(readRecent);
  const open = useLibrary((s) => s.open);
  const phase = useLibrary((s) => s.phase);
  const libError = useLibrary((s) => s.error);
  const libErrorDetail = useLibrary((s) => s.errorDetail);

  const choose = async (root: string) => {
    setRecent(rememberRecent(root));
    await open(root);
  };
```

把「最近打开」那一段换成：

```tsx
      {recent.length > 0 && (
        <div className="picker-recent">
          <h2>最近打开</h2>
          {recent.map((p) => (
            // 两个**并列**的按钮，不是嵌套——嵌套 <button> 是非法 HTML，
            // 而且会逼出一堆 stopPropagation 才能让内层不触发外层。
            <div className="picker-recent-row" key={p}>
              <button className="picker-recent-item" onClick={() => void choose(p)}
                      disabled={phase === 'scanning'}>{p}</button>
              {/* title 必须写明"不会动磁盘上的文件夹"：在一个照片程序里，
                  一个紧挨着路径的 ✕ 天然会被读成"删掉这个文件夹"。
                  这句话是这个按钮唯一的澄清机会。
                  ✕ 常驻显示而不是 hover 才出现——操作入口保持可见。
                  也不做二次确认：误删的代价只是少一条快捷方式。 */}
              <button className="picker-recent-del" type="button"
                      aria-label={`不再显示 ${p}`}
                      title="从「最近打开」里移除。不会动磁盘上的文件夹"
                      onClick={() => setRecent(forgetRecent(p))}>✕</button>
            </div>
          ))}
        </div>
      )}
```

- [ ] **Step 4: 改样式**

编辑 `web/src/styles.css`，把第 39 行那条：

```css
.picker-recent-item { display: block; width: 100%; text-align: left; margin-bottom: 4px; font-family: ui-monospace, monospace; }
```

换成三条（`display: block; width: 100%; margin-bottom` 的职责由行容器接管）：

```css
.picker-recent-row { display: flex; gap: 4px; margin-bottom: 4px; }
.picker-recent-item { flex: 1; text-align: left; font-family: ui-monospace, monospace; }
.picker-recent-del { flex: 0 0 auto; }
```

- [ ] **Step 5: 跑测试，确认是绿的**

```bash
npx vitest run web/src/components/FolderPicker.test.tsx
npm test
```

预期：前者 5 个用例 PASS；后者全绿（`App.test.tsx` 会渲染 FolderPicker，是这次改动的连带回归面）。

- [ ] **Step 6: 提交**

```bash
git add web/src/components/FolderPicker.tsx web/src/components/FolderPicker.test.tsx web/src/styles.css
git commit -F - <<'MSG'
feat: 最近打开的每条记录可以删掉

顺带修掉一个结构问题：原来 recent 是每次渲染重读一次 localStorage、没有任何
state。删除功能在那个结构下根本不成立——删完没有东西会触发重渲染，列表在屏幕
上不会变。现在挂载时读一次进 state，之后直接用三个函数返回的新列表 setState。

✕ 常驻显示而不是 hover 才出现：操作入口保持可见。不做二次确认：误删的代价只是
少一条快捷方式，重新打开一次就回来了。

title 写的是「从「最近打开」里移除。不会动磁盘上的文件夹」——在一个照片程序里，
一个紧挨着路径的 ✕ 天然会被读成"删掉这个文件夹"，这句话是它唯一的澄清机会。

FolderPicker 至此有了第一个测试文件。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

## Task 3: 顶栏去掉连拍阈值滑块

**Files:**
- Modify: `web/src/components/TopBar.tsx`
- Modify: `web/src/components/TopBar.test.tsx`
- Modify: `web/src/styles.css:162-163`
- Modify: `README.md`（《连拍分组》一节）

**Interfaces:**
- Consumes: 无
- Produces: 无。**`useView` 的 `threshold` / `setThreshold` 一律保留**——`library.open()` 和 `GuestApp` 还要用 `setThreshold` 把 `marks.json` 里存的阈值装进 store，连拍分组本身也还在读 `threshold`。

- [ ] **Step 1: 写失败的测试**

在 `web/src/components/TopBar.test.tsx` **文件末尾**追加一个新的 describe（不要塞进现有那个 §5.4 的 describe 里，两组验的不是一件事）：

```tsx
/**
 * 顶栏不再提供连拍阈值滑块。
 *
 * 这条守的是一个产品决定，不是某个 bug：滑块删掉之后，阈值取自该文件夹
 * marks.json 里的设置（默认 1.0 秒），界面上没有调整入口。有人日后顺手把它
 * 加回顶栏时，这条会红。
 */
describe('TopBar：不再有连拍阈值滑块', () => {
  it('顶栏里没有 range 输入', () => {
    const { container } = render(<TopBar onExport={() => {}} />);
    expect(container.querySelector('input[type="range"]')).toBeNull();
  });

  it('顶栏里没有「连拍」字样', () => {
    const { container } = render(<TopBar onExport={() => {}} />);
    expect(container.textContent).not.toContain('连拍');
  });
});
```

- [ ] **Step 2: 跑它，确认是红的**

```bash
npx vitest run web/src/components/TopBar.test.tsx
```

预期：两条新用例 FAIL（`input[type=range]` 存在、文本里有「连拍」），原有 7 条 PASS。

- [ ] **Step 3: 删掉滑块**

编辑 `web/src/components/TopBar.tsx`：

删掉这一整块：

```tsx
      <label className="threshold" title="相邻两张间隔小于此值即归为一组连拍">
        连拍 {(threshold / 1000).toFixed(1)}s
        <input type="range" min={300} max={5000} step={100} value={threshold}
               onChange={(e) => setThreshold(Number(e.target.value))}
               onPointerUp={(e) => setThreshold(Number((e.target as HTMLInputElement).value), true)} />
      </label>
```

删掉它带出来的两个订阅（`noUnusedLocals` 开着，留下就编译不过）：

```tsx
  const threshold = useView((s) => s.threshold);
  const setThreshold = useView((s) => s.setThreshold);
```

**其余一律不动**：`tab` / `setTab` / `dirFilter` 都还在用。

- [ ] **Step 4: 删样式**

编辑 `web/src/styles.css`，删掉这两条：

```css
.threshold { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
.threshold input { width: 110px; }
```

- [ ] **Step 5: 改 README**

编辑 `README.md` 的《连拍分组》一节，把：

```
相邻两张同时满足「拍摄时间差 ≤ 阈值」「同一机身」「时间不是从文件 mtime 推断的」
才归为一组。阈值用顶栏滑块实时调整（0.3–5 秒），分组在前端计算，不发请求。
```

改成：

```
相邻两张同时满足「拍摄时间差 ≤ 阈值」「同一机身」「时间不是从文件 mtime 推断的」
才归为一组。分组在前端计算，不发请求。

阈值取自该文件夹 `.photocull/marks.json` 里的设置，没设过就是 1.0 秒，
**界面上没有调整入口**。顶栏原来那个滑块已经去掉；已经调过阈值的老文件夹
分组结果不变——那个值照常读取、照常生效，消失的只是改它的入口。
```

- [ ] **Step 6: 跑测试，确认是绿的**

```bash
npx vitest run web/src/components/TopBar.test.tsx
npm test
npx tsc --noEmit
```

预期：TopBar 9 条全 PASS；全量全绿；类型检查干净（这一步专门验 `noUnusedLocals` 没被两个删掉的订阅绊住）。

- [ ] **Step 7: 提交**

```bash
git add web/src/components/TopBar.tsx web/src/components/TopBar.test.tsx web/src/styles.css README.md
git commit -F - <<'MSG'
feat: 顶栏去掉连拍阈值滑块

连拍分组本身原样保留：bursts.ts、卡牌堆、展开收起、Esc 收起、flatOrder 一律
不动，view.setThreshold 也留着——library.open() 和 GuestApp 还要用它把
marks.json 里存的阈值装进 store。

有一个后果必须记下来：滑块是 setThreshold(persist=true) 唯一的调用方，去掉之后
阈值从此无法在界面上修改。每个文件夹用的就是它 marks.json 里存着的值，没调过
的用默认 1.0 秒；已经调过的老文件夹分组结果不变，消失的只是改它的入口。
服务端 PUT /api/library/settings 保留（它在权限矩阵里、有测试），
但前端从此不再调用它——这是一条有意留下的死路，不是遗漏。

README 的《连拍分组》原来写着"阈值用顶栏滑块实时调整（0.3–5 秒）"，
滑块一删这句就是假话，一并改掉。

补的两条用例守的是产品决定而不是 bug：有人日后顺手把滑块加回顶栏时它们会红。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

## Task 4: `derive.dirRejected` —— 一趟遍历算出每个目录排除了几张

**Files:**
- Modify: `web/src/lib/derive.ts`（在 `dirCounts` 之后新增一个导出函数）
- Modify: `web/src/lib/derive.test.ts`

**Interfaces:**
- Consumes: `derive.ts` 里已有的局部类型 `type Marks = Record<string, Mark | undefined>`（文件第 4 行，不导出，同文件内直接可用）
- Produces: `dirRejected(assets: Asset[], marks: Marks): Map<string, number>` —— **只为至少有一张被排除的目录建条目**，取不到即 0

**为什么单独一个函数：** Task 5 的 Sidebar 要判断"这个目录是不是已经全排除了"。让它对每个目录各扫一遍全库是 O(assets × dirs)，而 Sidebar 加了 `marks` 订阅之后**每按一次 P/X 都会重渲染**——三千张 × 二十个目录就是每次按键六万次比较。这里一趟 O(assets)，和 TopBar 现有的 `countByTab` 同一个量级。

**不改 `dirCounts` 的返回结构**：它有自己的测试和调用点，为了多带一个字段去动签名，只会让改动扩散到无关的地方。

- [ ] **Step 1: 写失败的测试**

在 `web/src/lib/derive.test.ts` 里，把顶部的 import 加上 `dirRejected`：

```ts
import {
  filterAssets, assetsInDir, toBurstItems, dirCounts, dirRejected, groupMarkSummary,
  filterGroups, countByTab, NO_MARKS,
} from './derive';
```

在文件末尾追加：

```ts
describe('dirRejected', () => {
  // 文件顶部已有的夹具：
  //   assets = [asset('A'), asset('cam-a/B', 'cam-a'), asset('cam-a/C', 'cam-a'), asset('D')]
  //   marks  = { A: 'pick', 'cam-a/B': 'reject', 'cam-a/C': 'pick' }
  it('只数 reject，不数 pick 和未标记', () => {
    expect(dirRejected(assets, marks)).toEqual(new Map([['cam-a', 1]]));
  });

  // 约定：一张都没排除的目录**不建条目**。判据 `get(dir) === count` 因此不会
  // 把"没有条目"误判成"全排除"——count 恒 >= 1，而 get 返回 undefined。
  it('一张都没排除的目录不出现在结果里', () => {
    expect(dirRejected(assets, marks).has('')).toBe(false);
  });

  it('同一目录里多张被排除时累加', () => {
    const all = { 'cam-a/B': 'reject', 'cam-a/C': 'reject' } as const;
    expect(dirRejected(assets, all)).toEqual(new Map([['cam-a', 2]]));
  });

  it('跨目录不串味', () => {
    const mixed = { A: 'reject', 'cam-a/B': 'reject' } as const;
    expect(dirRejected(assets, mixed)).toEqual(new Map([['', 1], ['cam-a', 1]]));
  });

  it('没有资产时是空 Map', () => {
    expect(dirRejected([], marks)).toEqual(new Map());
  });

  it('没有任何标记时是空 Map', () => {
    expect(dirRejected(assets, NO_MARKS)).toEqual(new Map());
  });
});
```

- [ ] **Step 2: 跑它，确认是红的**

```bash
npx vitest run web/src/lib/derive.test.ts
```

预期：FAIL，`dirRejected is not a function`（或 esbuild 报导出不存在）。

- [ ] **Step 3: 写实现**

编辑 `web/src/lib/derive.ts`，在 `dirCounts` 之后加：

```ts
/**
 * 每个目录里有几张被标成「排除」。**只为至少有一张的目录建条目**，取不到即 0。
 *
 * 单独一趟遍历，而不是让调用方对每个目录各扫一遍全库：Sidebar 为了判断
 * "这个目录是不是已经全排除了"必须订阅 marks，于是每按一次 P/X 它都会重渲染。
 * O(assets × dirs) 在三千张、二十个目录的库上就是每次按键六万次比较；
 * 这里是一次 O(assets)，和 TopBar 的 countByTab 同一个量级。
 *
 * 与 dirCounts 用同一个判据（`a.dir` **全等**，不做前缀归并），两处必须一致——
 * 一个按全等数总数、另一个按前缀数排除数，会得出"永远不可能全排除"的结论。
 */
export function dirRejected(assets: Asset[], marks: Marks): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of assets) {
    if (marks[a.id] === 'reject') out.set(a.dir, (out.get(a.dir) ?? 0) + 1);
  }
  return out;
}
```

- [ ] **Step 4: 跑测试，确认是绿的**

```bash
npx vitest run web/src/lib/derive.test.ts
```

预期：PASS，新增 6 条。

- [ ] **Step 5: 提交**

```bash
git add web/src/lib/derive.ts web/src/lib/derive.test.ts
git commit -F - <<'MSG'
feat: derive 增加 dirRejected —— 一趟算出每个目录排除了几张

下一步 Sidebar 要判断"这个目录是不是已经全排除了"。为此它必须订阅 marks，
于是每按一次 P/X 它都会重渲染。让它对每个目录各扫一遍全库是 O(assets × dirs)，
三千张 × 二十个目录就是每次按键六万次比较；这里一趟 O(assets)，
和 TopBar 的 countByTab 同一个量级。

约定：一张都没排除的目录不建条目。判据 get(dir) === count 因此不会把"没有条目"
误判成"全排除"——count 恒 >= 1 而 get 返回 undefined。

判据和 dirCounts 一样是 a.dir 全等、不做前缀归并。两处必须一致：一个按全等数
总数、另一个按前缀数排除数，会得出"永远不可能全排除"的结论。

没有动 dirCounts 的签名——为了多带一个字段去改它，只会让改动扩散到无关的调用点。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

## Task 5: 左侧目录整批排除

**Files:**
- Modify: `web/src/components/Sidebar.tsx`
- Create: `web/src/components/Sidebar.test.tsx`
- Modify: `web/src/styles.css:149-151`

**Interfaces:**
- Consumes:
  - `dirCounts(assets): { dir: string; count: number }[]`（已有）
  - `dirRejected(assets, marks): Map<string, number>`（Task 4）
  - `applyMark(mark: Mark | null, opts?: { targets?: string[]; order?: string[] }): boolean`（已有，`web/src/lib/applyMark.ts`）
  - `useSession((s) => s.canWrite())`（已有）
- Produces: 无

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/Sidebar.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Sidebar } from './Sidebar';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { setSession } from '../store/session';
import { useView } from '../store/view';
import type { Asset } from '../types';

const asset = (id: string, dir: string): Asset => ({
  id, dir, stem: id, raws: ['x.CR3'], jpg: 'x.JPG', jpgSize: 10, jpgMtimeMs: 5000,
});

// Sidebar 在 dirs.length <= 1 && warnings.length === 0 时整个返回 null，
// 所以夹具至少要两个目录。
const ASSETS = [
  asset('a1', 'cam-a'), asset('a2', 'cam-a'),
  asset('b1', 'cam-b'),
];

const asAdmin = () => setSession({ kind: 'admin', user: null, share: null, online: [] });
const asEditor = () => setSession({
  kind: 'user', user: { id: 'u_1', nickname: '小林', role: 'editor' }, share: null, online: [],
});
const asViewer = () => setSession({
  kind: 'user', user: { id: 'u_2', nickname: '路人', role: 'viewer' }, share: null, online: [],
});

beforeEach(() => {
  useLibrary.setState({ assets: ASSETS, warnings: [] });
  useMarks.getState().load({});
  useView.getState().reset();
  setSession({ kind: 'none', user: null, share: null, online: [] });
});

// 本仓库没有 test.globals，不写这一句 DOM 会跨用例泄漏。
afterEach(() => { cleanup(); });

const excludeButtons = () => screen.queryAllByRole('button', { name: /整批排除|取消排除/ });

describe('Sidebar：目录批量排除的门禁', () => {
  // 安全属性，不是界面装饰：三道门禁里的第二道。
  it('viewer 角色下一个排除按钮都不在 DOM 里', () => {
    asViewer();
    render(<Sidebar />);
    expect(excludeButtons()).toHaveLength(0);
  });

  // canWrite() 是默认拒绝的：身份还没解析出来时同样不给。
  it('身份还没解析出来（kind: none）时也不渲染', () => {
    render(<Sidebar />);
    expect(excludeButtons()).toHaveLength(0);
  });

  it('admin 每个目录一个按钮', () => {
    asAdmin();
    render(<Sidebar />);
    expect(excludeButtons()).toHaveLength(2);
  });

  it('editor 也有', () => {
    asEditor();
    render(<Sidebar />);
    expect(excludeButtons()).toHaveLength(2);
  });

  // 把整个库一键排掉不是一个有意义的动作。断言结构而不是"某个名字的按钮不存在"——
  // 后者对着一个本来就永远不会生成的名字，它恒真，什么也守不住。
  it('「全部」那一行没有排除按钮', () => {
    asAdmin();
    const { container } = render(<Sidebar />);
    expect(container.querySelectorAll('.dir-row')).toHaveLength(2);
    expect(container.querySelectorAll('.dir-exclude')).toHaveLength(2);
  });
});

describe('Sidebar：目录批量排除的行为', () => {
  it('点一下把该目录整批标成 reject', () => {
    asAdmin();
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: '把 cam-a 的 2 张照片整批排除' }));
    const { marks } = useMarks.getState();
    expect([marks.a1, marks.a2]).toEqual(['reject', 'reject']);
  });

  it('别的目录一张都没被碰', () => {
    asAdmin();
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: '把 cam-a 的 2 张照片整批排除' }));
    expect(useMarks.getState().marks.b1).toBeUndefined();
  });

  // 点第二次是取消，不是确认框。撤销至今只有 ⌘Z 一个入口，而 Sidebar 会在
  // 访客界面也复用这个组件，目录批量操作应当可以撤销。
  it('该目录已全部排除时，按钮变成「取消排除」，点它全数清空', () => {
    asAdmin();
    useMarks.getState().load({ a1: 'reject', a2: 'reject' });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: '取消排除 cam-a 的 2 张照片' }));
    const { marks } = useMarks.getState();
    expect([marks.a1, marks.a2]).toEqual([undefined, undefined]);
  });

  it('只排除了一部分时，点了是全排除而不是取消', () => {
    asAdmin();
    useMarks.getState().load({ a1: 'reject', a2: 'pick' });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: '把 cam-a 的 2 张照片整批排除' }));
    const { marks } = useMarks.getState();
    expect([marks.a1, marks.a2]).toEqual(['reject', 'reject']);
  });

  // 作用对象是该目录的**全部**照片，不是眼前看得见的那几张。
  it('当前在「收藏」标签页上，点了仍然作用于该目录全部照片', () => {
    asAdmin();
    useMarks.getState().load({ a1: 'pick' });
    useView.getState().setTab('pick');
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: '把 cam-a 的 2 张照片整批排除' }));
    const { marks } = useMarks.getState();
    expect([marks.a1, marks.a2]).toEqual(['reject', 'reject']);
  });

  // 同上：当前筛在别的目录上，也不影响这次操作的对象。
  it('当前筛在 cam-b 上，点 cam-a 的按钮仍然只动 cam-a', () => {
    asAdmin();
    useView.getState().setDirFilter('cam-b');
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: '把 cam-a 的 2 张照片整批排除' }));
    const { marks } = useMarks.getState();
    expect([marks.a1, marks.a2, marks.b1]).toEqual(['reject', 'reject', undefined]);
  });

  // 一次 setMark 只压一条撤销记录（marks.ts:197），所以一次 ⌘Z 撤销整个文件夹。
  it('一次点击只压一条撤销记录，undo 一次全数复原', () => {
    asAdmin();
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: '把 cam-a 的 2 张照片整批排除' }));
    useMarks.getState().undo();
    const { marks } = useMarks.getState();
    expect([marks.a1, marks.a2]).toEqual([undefined, undefined]);
  });
});
```

- [ ] **Step 2: 跑它，确认是红的**

```bash
npx vitest run web/src/components/Sidebar.test.tsx
```

预期：前两条门禁用例 **PASS**（按钮还不存在，"不在 DOM 里"自然成立——这正是 Step 6 要做突变验证的原因），其余 10 条 FAIL（找不到按钮）。

- [ ] **Step 3: 改组件**

把 `web/src/components/Sidebar.tsx` 整个换成：

```tsx
import { useMemo } from 'react';
import { applyMark } from '../lib/applyMark';
import { dirCounts, dirRejected } from '../lib/derive';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { useSession } from '../store/session';
import { useView } from '../store/view';

export function Sidebar() {
  const assets = useLibrary((s) => s.assets);
  const warnings = useLibrary((s) => s.warnings);
  // 逐字段订阅，避免和 TopBar 同样的问题：整体解构 useView() 会让 Sidebar
  // 在 cursor/selection/expanded 等无关字段变化时也跟着重渲染。
  const dirFilter = useView((s) => s.dirFilter);
  const setDirFilter = useView((s) => s.setDirFilter);
  // marks 是新增的订阅，只为判断"这个目录是不是已经全排除了"。代价是每按一次
  // P/X 这个组件都会重渲染；下面那个 memo 把代价压在一趟 O(assets) 上
  // （见 derive.dirRejected 的注释）。
  const marks = useMarks((s) => s.marks);
  // 只读时不显示修改按钮。服务端 requirePerm('write') 也会核对权限，
  // 第三道在 applyMark 内部。判据一律用 canWrite()，它是默认拒绝的。
  const canWrite = useSession((s) => s.canWrite());

  const dirs = useMemo(() => dirCounts(assets), [assets]);
  const rejected = useMemo(() => dirRejected(assets, marks), [assets, marks]);

  if (dirs.length <= 1 && warnings.length === 0) return null;

  /**
   * 整批排除的对象是该目录下的**全部**照片，不受当前标签页、当前目录筛选影响：
   * 站在「收藏」标签页上点它，排除的仍然是整个目录，而不是眼前看得见的那几张。
   *
   * 走 applyMark 而不是直接 setMark：那是全前端唯一的标记入口，撤销栈、
   * SSE 广播、归属记录都挂在它上面。不传 order —— 批量操作不该把光标挪走。
   */
  const excludeDir = (dir: string, allRejected: boolean) => {
    const targets = assets.filter((a) => a.dir === dir).map((a) => a.id);
    applyMark(allRejected ? null : 'reject', { targets });
  };

  return (
    <aside className="sidebar">
      <h2>文件夹</h2>
      <button className={dirFilter === null ? 'dir dir-on' : 'dir'} onClick={() => setDirFilter(null)}>
        全部 <b>{assets.length}</b>
      </button>
      {dirs.map(({ dir, count }) => {
        const label = dir || '（根目录）';
        const allRejected = rejected.get(dir) === count;
        // 再次点击取消整个目录的标记，恢复之前的混合状态使用撤销。
        const hint = allRejected
          ? `取消排除 ${label} 的 ${count} 张照片`
          : `把 ${label} 的 ${count} 张照片整批排除`;
        return (
          <div className="dir-row" key={dir}>
            <button className={dirFilter === dir ? 'dir dir-on' : 'dir'}
                    onClick={() => setDirFilter(dir)} title={label}>
              {label} <b>{count}</b>
            </button>
            {canWrite && (
              <button type="button" aria-label={hint} title={hint}
                      className={allRejected ? 'dir-exclude dir-exclude-on' : 'dir-exclude'}
                      onClick={() => excludeDir(dir, allRejected)}>✕</button>
            )}
          </div>
        );
      })}

      {warnings.length > 0 && (
        <details className="warnings">
          <summary>{warnings.length} 条扫描提示</summary>
          <ul>{warnings.slice(0, 50).map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
    </aside>
  );
}
```

- [ ] **Step 4: 改样式**

编辑 `web/src/styles.css`。**`.dir` 这条本身一个字都不要改**，只在它后面补四条：

```css
.dir-row { display: flex; gap: 4px; align-items: center; margin-bottom: 2px; }
.dir-row .dir { width: auto; flex: 1; min-width: 0; margin-bottom: 0; }
.dir-exclude { flex: 0 0 auto; }
.dir-exclude-on { border-color: var(--accent); }
```

**为什么不像 `.picker-recent-item` 那样把 `display: block; width: 100%` 直接删掉：**
`.dir` 有**两类**使用者。目录行里的那些进了 `.dir-row`（flex 容器），但「全部」那个
按钮是 `aside.sidebar` 的**直接子元素**，不在任何 flex 容器里。删掉 `width: 100%`
之后 `flex: 1` 对它毫无作用，`<button>` 会退回 inline-block 的默认宽度——「全部」
那一行会缩成文字宽，和下面每一条都不齐。所以基础规则保持原样，只用后代选择器
覆盖进了行容器的那些。

`min-width: 0` 是必要的：flex 子项默认 `min-width: auto`，长目录名会把 ✕ 挤出容器。

（`.dir b`、`.dir-on`、`.warnings` 三条不动。）

- [ ] **Step 5: 跑测试，确认是绿的**

```bash
npx vitest run web/src/components/Sidebar.test.tsx
npm test
```

预期：Sidebar 12 条全 PASS；全量全绿。

**连带回归面：`App.test.tsx` 和 `GuestApp.test.tsx` 都会渲染 Sidebar。** 尤其是访客那一侧——只读访客的那一屏现在多了一个必须不渲染的按钮，如果 `GuestApp.test.tsx` 里有断言整屏结构的用例，它会是第一个红的。

- [ ] **Step 6: 突变验证 —— 证明那两条安全用例不是在空转**

Step 2 里"viewer 不渲染"和"kind:none 不渲染"这两条在按钮还不存在时就是绿的。
不验一次，无从判断它们现在到底有没有在守东西。

临时把 `Sidebar.tsx` 里的门禁摘掉——把 `{canWrite && (` 改成 `{true && (`，然后：

```bash
npx vitest run web/src/components/Sidebar.test.tsx
```

预期：**恰好那两条变红**（"viewer 角色下一个排除按钮都不在 DOM 里"、"身份还没解析出来时也不渲染"），其余 10 条不动。

看到预期结果后**立刻改回** `{canWrite && (`，再跑一次确认 12 条全绿。

如果变红的不止那两条，或者一条都没红，**停下来**——说明这组用例守的东西和以为的不一样。

- [ ] **Step 7: 提交**

```bash
git add web/src/components/Sidebar.tsx web/src/components/Sidebar.test.tsx web/src/styles.css
git commit -F - <<'MSG'
feat: 左侧目录可以把该文件夹的照片整批排除

作用对象是该目录下的全部照片，不受当前标签页和当前目录筛选影响：站在「收藏」
标签页上点它，排除的仍然是整个目录，而不是眼前看得见的那几张。

再次点击取消整个目录的标记。恢复操作前的收藏、排除状态，使用顶栏撤销或 `⌘/Ctrl+Z`。

按钮叫「排除」不叫「删除」：语义就是标成 reject，不动任何文件。在照片程序里挨着
文件夹名写"删除"，谁都会读成文件没了。

只读门禁走 canWrite()（默认拒绝），false 时不显示修改按钮。已用突变验证过：摘掉这个判断，恰好那两条安全
用例变红，其余十条不动。

写操作走已有的 applyMark，不新开路径：撤销栈、SSE 广播、归属记录自动带上，
一次 setMark 只压一条撤销记录，所以一次 ⌘Z 撤销整个文件夹。

Sidebar 至此有了第一个测试文件。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

## Task 6: 收口 —— 文档与全量门禁

**Files:**
- Modify: `README.md`（《鼠标与键盘怎么标记》一节）

- [ ] **Step 0: 修掉规格文档 §3.8 里那段已经不成立的 CSS 指引**

`docs/superpowers/specs/2026-07-27-list-cleanup-design.md` 的 §3.8 现在写着：

```
`.dir` 原有的 `display: block; width: 100%; margin-bottom: 2px` 由行容器接管。
```

**实际交付的不是这样**，而且不能这样：`.dir` 有两类使用者，「全部」那个按钮是
`aside.sidebar` 的直接子元素、不在任何 flex 容器里，删掉 `width: 100%` 之后
`flex: 1` 对它毫无作用，它会缩成文字宽。把 §3.8 的代码块和末句一并换成：

```css
.dir-row { display: flex; gap: 4px; align-items: center; margin-bottom: 2px; }
.dir-row .dir { width: auto; flex: 1; min-width: 0; margin-bottom: 0; }
.dir-exclude { flex: 0 0 auto; }
.dir-exclude-on { border-color: var(--accent); }
```

末句改成：

```
`.dir` 这条基础规则**一个字都不改**。它有两类使用者：目录行里的那些进了 `.dir-row`
（flex 容器），但「全部」那个按钮是 `aside.sidebar` 的直接子元素，不在任何 flex
容器里——删掉 `width: 100%` 之后 `flex: 1` 对它毫无作用，它会退回 inline-block
缩成文字宽。所以只用后代选择器覆盖进了行容器的那些。
```

- [ ] **Step 1: README 补上新的标记入口**

《鼠标与键盘怎么标记》是全篇唯一讲"没有键盘时怎么标记"的一节。新开了一个标记
入口却不写进去，等于让它只能靠人乱点撞见。

在该节 `**撤销目前只有键盘入口**` 那一段**之前**插入：

```
左侧的文件夹列表里，每个文件夹右边有一个 `✕`：把这个文件夹的照片**整批排除**。
它作用于该文件夹的全部照片，不受当前标签页和当前筛选影响——站在「收藏」标签页上
点它，排除的仍然是整个文件夹。

**它不删文件。** 排除只是一个标记，导出时不带上而已，磁盘上一张都不会少。

按钮变高亮之后再点一次，是**取消整个文件夹的标记**——注意这不是撤销：那个文件夹里
原本已经收藏的几张，会被一起清成未标记。要真的回到点之前的样子，用 `⌘Z`（一次撤销
整批），也可以点击顶栏「撤销」。
```

- [ ] **Step 2: 跑全量门禁**

```bash
npm test
npx tsc --noEmit
npm run build
```

预期：三条全过。测试文件数从 69 涨到 **72**（新增 `recent.test.ts`、`FolderPicker.test.tsx`、`Sidebar.test.tsx`），用例数从 1310 涨到 **1349**（Task 1 加 13、Task 2 加 5、Task 3 加 2、Task 4 加 6、Task 5 加 12，Task 5 的复审又追加了 1 条"连点两下"的用例）。

对不上就查是不是有文件被 `vitest.config.js` 的 `projects` include 漏掉了——那两个 glob 合起来必须覆盖全部测试文件，少一个 glob 不会报错，只是那些用例再也不会被执行。

- [ ] **Step 3: 在浏览器里逐条走一遍**

```bash
npm start
```

按顺序确认：

1. **最近打开**：至少有两条记录时，每条右侧有 ✕；点掉一条，那条立刻消失、其余还在；刷新页面，删掉的那条**没有回来**。
2. **顶栏**：没有「连拍 1.0s」滑块；打开一个有连拍的文件夹，卡牌堆照样能展开和收起，`Esc` 照样收起。
3. **目录批量排除**：左侧某个文件夹点 ✕ → 该文件夹的照片整批出现排除角标，左侧那个 ✕ 变成高亮；按一次 `⌘Z` → 整批复原；再点一次 ✕ → 全部排除，再点一次 → 全部取消。
4. **不受标签页影响**：切到「收藏」标签页，点某个文件夹的 ✕，切回「全部」确认该文件夹**每一张**都被排除了，不只是刚才看得见的那几张。

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -F - <<'MSG'
docs: README 补上左侧目录的整批排除

《鼠标与键盘怎么标记》是全篇唯一讲"没有键盘时怎么标记"的一节。这次新开了一个
标记入口（左侧文件夹的 ✕），不写进去等于让它只能靠人乱点撞见。

特意写明"它不删文件"：一个挨着文件夹名的 ✕，任何人第一眼都会当成删除。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

- [ ] **Step 5: 只读验收（使用另一台电脑）**

回环请求一律被判成管理员（`resolveActor`），所以访客路径**在本机根本走不到**，
这一条只能在真机上验：

用 `npm start -- --share` 起服务，在访客电脑浏览器中打开分享链接，在管理后台把该访客改成
**只读**，确认他那一屏：目录旁边的 `✕`、顶栏的「多选」开关、底部操作条**全部消失**。

这一步做不了就如实记下"未验证"，不要因为自动化测试绿了就当它验过了——
那两条 jsdom 用例证明的是组件在给定 session 状态下的渲染结果，不是真实身份解析。

---

## 自查

**规格覆盖：**

| 规格小节 | 落在哪 |
|---|---|
| §1.2 `lib/recent.ts` 三个函数 | Task 1 |
| §1.3 组件接线、✕ 常驻、不做确认、title 澄清、扫描期间不禁用 | Task 2 Step 3 + 测试第 5 条 |
| §1.4 CSS | Task 2 Step 4 |
| §2.1 删滑块与两个订阅 | Task 3 Step 3 |
| §2.2 不删的东西 | Task 3 Step 3 明确写了"其余一律不动" |
| §2.3 后果（阈值不可改、PUT 成死路） | Task 3 Step 7 提交信息 + Step 5 README |
| §2.4 README《连拍分组》 | Task 3 Step 5 |
| §3.2 行为规格（全部照片、切换语义、外观、文案、「全部」无按钮） | Task 5 Step 3 + 测试 5/6/7/8/9/10/11 |
| §3.3 为什么是切换 | Task 5 Step 3 注释 + Step 7 提交信息 |
| §3.4 不叫「删除」 | Task 5 全部文案用「排除」；Task 6 README 写明不删文件 |
| §3.5 `dirRejected` 与 Map 约定 | Task 4 |
| §3.6 三道门禁 | Task 5 Step 3 + 测试 1/2 + Step 6 突变验证 |
| §3.7 README《鼠标与键盘怎么标记》 | Task 6 Step 1 |
| §3.8 CSS | Task 5 Step 4 |
| §5.1–5.5 测试规格 | Task 1 / 2 / 3 / 4 / 5 各自的测试步骤 |
| §5.6 突变验证 | Task 5 Step 6 |
| §7 验收 | Task 6 Step 2/3/5 |

**类型一致性：**

- `dirRejected(assets: Asset[], marks: Marks): Map<string, number>` —— Task 4 定义、Task 5 消费，名字与签名一致。
- `readRecent` / `rememberRecent` / `forgetRecent` 均返回 `string[]` —— Task 1 定义、Task 2 消费。
- `applyMark(mark, { targets })` 用的是既有签名（`web/src/lib/applyMark.ts`），未改动。
- `setSession({ kind, user, share, online })` 四个字段与 `MarkBar.test.tsx` 现有写法一致；`kind` 的取值只有 `'admin' | 'user' | 'none'`（**没有 `'guest'`** —— 上一轮的计划在这里写错过一次，会直接编译不过）。
