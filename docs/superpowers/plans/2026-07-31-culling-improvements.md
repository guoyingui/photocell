# 选片改进五条 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让文件夹在 Windows 上够得着、网格与大图能连续缩放、能原地刷新、能隐藏废片、能按客户维度筛选选片结果。

**Architecture:** 五条需求分三层落地。最底下是 `marks.json` 的两张新平行表（`hidden` 数组、`contrib` 贡献表），`marks` / `marksMeta` 的形状一个字节不改——导出链路、`web/src/lib/derive.ts`、乐观更新与回滚三条路径全都按现在的读法工作。中间是服务端：盘符枚举、刷新端点、隐藏端点、按人过滤的 marks 出口。最上面是前端：拖拽定位、缩放控件、大图改造、第五个 tab、客户筛选下拉。

**Tech Stack:** Node 22.12+ / Express 5 / React 19 / zustand 5 / vitest 4 / TypeScript 7（只覆盖 `web/src`）

## Global Constraints

- 规格文档：`docs/superpowers/specs/2026-07-31-culling-improvements-design.md`。本计划的每一条都以它为准，冲突时以规格为准。
- **`marks` 与 `marksMeta` 的形状不得改变**：`Record<id, 'pick'|'reject'>` 与 `Record<id, {by, at}>`。新东西一律走平行表。
- **三道门禁缺一不可**：服务端 `requirePerm` / `requireAdmin` → 组件层不渲染（不是置灰）→ `applyMark` 内部的 `canWrite()`。新增的写操作必须同样三道齐全。
- **默认拒绝**：所有权限判据用 `useSession.canWrite()`（前端）/ `req.actor?.kind === 'admin'`（服务端）。身份未定一律拒绝。
- 前端拿不到 node 的 `path`，任何路径处理必须自己写并配测试。
- 测试分组写在 `vitest.config.js`：`server/**/*.test.js` 与 `web/src/**/*.test.ts` 跑 node 环境，`web/src/**/*.test.tsx` 跑 jsdom。**新建测试文件的扩展名决定它跑在哪个环境里**，选错会拿不到 DOM 或者拿不到真实 fs。
- 三条门禁命令，每个任务的最后一步之前都要全绿：`npm test`、`npx tsc --noEmit`、`npm run build`。
- 提交信息用中文，前缀 `feat:` / `fix:` / `refactor:` / `docs:`，与仓库既有风格一致。

---

## 文件结构

**新建**

| 文件 | 职责 |
|---|---|
| `web/src/lib/pathname.ts` | 前端路径处理，同时吃 `/` 和 `\`。`basename` / `within` |
| `web/src/lib/pathname.test.ts` | 同上的测试 |
| `server/lib/contrib.js` | 贡献表的纯函数：求值、回填、写入、按人可见性 |
| `server/lib/contrib.test.js` | 同上的测试 |
| `server/lib/drives.js` | win32 盘符枚举（含超时） |
| `server/lib/drives.test.js` | 同上的测试 |
| `web/src/lib/dropLocate.ts` | 拖拽定位的匹配逻辑（纯函数） |
| `web/src/lib/dropLocate.test.ts` | 同上的测试 |
| `web/src/components/ZoomSlider.tsx` | 顶栏的网格缩放滑块 |
| `web/src/components/ZoomSlider.test.tsx` | 同上的测试 |
| `web/src/lib/lightboxZoom.ts` | 大图缩放的纯函数：钳制、以指针为中心缩放 |
| `web/src/lib/lightboxZoom.test.ts` | 同上的测试 |
| `web/src/lib/applyMark.test.ts` | `applyHidden` 的门禁与跳过逻辑（`applyMark.ts` 目前零测试） |
| `web/src/components/Lightbox.test.tsx` | 大图的组件测试（`Lightbox.tsx` 目前零测试） |
| `web/src/store/notice.ts` | 一次性提示的 store（`showToast` / `clearToast`） |

**修改**

| 文件 | 改什么 |
|---|---|
| `server/lib/store.js` | `sanitize` 接入 `hidden` / `contrib`；`setMark` 改成经 contrib 求值；新增 `setHidden` |
| `server/lib/session.js` | `browseRoots()` 接盘符枚举；抽出 `startPostScan`；新增 `rescanSession` |
| `server/lib/shares.js` | `PATCHABLE_FIELDS` 加 `showPeerMarks`；`createShare` 默认 `true` |
| `server/routes/marks.js` | `GET /marks` 按人过滤；广播按人过滤；新增 `PUT /hidden`；`settings` 白名单换 `cellWidth` |
| `server/routes/library.js` | 新增 `POST /refresh` |
| `server/routes/admin.js` | 新增 `GET /library-users` |
| `web/src/types.ts` | `Settings.cellWidth`；`FilterTab` 加 `'hidden'` |
| `web/src/lib/derive.ts` | 全部筛选与计数剔除 `hidden`；新增按客户维度的筛选 |
| `web/src/store/marks.ts` | 持有 `hidden` / `contrib`；新增 `setHidden` |
| `web/src/store/view.ts` | 新增 `clientFilter` |
| `web/src/store/library.ts` | 新增 `refresh()`；处理 `rescan` 事件 |
| `web/src/lib/useKeyboard.ts` | `H` 键；`5` 进 tab 表 |
| `web/src/lib/applyMark.ts` | 新增 `applyHidden` |
| `web/src/components/Lightbox.tsx` | 连续缩放 + 右上角关闭按钮 |
| `web/src/components/Grid.tsx` | `cellWidth`；⌘/Ctrl 滚轮 |
| `web/src/components/TopBar.tsx` | 刷新按钮、缩放滑块、第五个 tab、客户下拉、`basename` |
| `web/src/components/MarkBar.tsx` | 「隐藏」按钮 |
| `web/src/components/FolderPicker.tsx` | 拖拽定位 |
| `web/src/components/DirBrowser.tsx` | 高亮命中的子目录 |
| `web/src/components/SharePanel.tsx` | `showPeerMarks` 开关 |
| `web/src/lib/fsRoots.ts` | `within` 改用 `pathname.ts` |
| `web/src/styles.css` | 新增样式 |
| `README.md` | 五条都要写 |
| `docs/acceptance-collaborative.md` | 两条人工验收 |

---

## 阶段 A：前端路径与 Windows 盘符（Task 1–3）

### Task 1: 前端路径工具

**Files:**
- Create: `web/src/lib/pathname.ts`
- Test: `web/src/lib/pathname.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `basename(p: string): string`、`within(p: string, root: string): boolean`

- [ ] **Step 1: 写失败的测试**

创建 `web/src/lib/pathname.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { basename, within } from './pathname';

describe('basename', () => {
  it('POSIX 路径取最后一段', () => {
    expect(basename('/Users/guoyg/婚礼')).toBe('婚礼');
  });

  it('Windows 路径取最后一段', () => {
    expect(basename('D:\\婚礼\\小林')).toBe('小林');
  });

  it('末尾的分隔符先剥掉', () => {
    expect(basename('/Users/guoyg/婚礼/')).toBe('婚礼');
    expect(basename('D:\\婚礼\\')).toBe('婚礼');
  });

  it('盘符根返回盘符本身', () => {
    expect(basename('D:\\')).toBe('D:');
  });

  it('混合分隔符按最后出现的那个切', () => {
    expect(basename('D:\\婚礼/小林')).toBe('小林');
  });
});

describe('within', () => {
  it('根自身算在自己之内', () => {
    expect(within('D:\\照片', 'D:\\照片')).toBe(true);
  });

  it('子目录在根之内', () => {
    expect(within('D:\\照片\\婚礼', 'D:\\照片')).toBe(true);
  });

  it('必须按整段比对，D:\\照片2 不在 D:\\照片 之内', () => {
    // 裸 startsWith 会把它误判成同一个根，于是"上级"按钮在真正的边界上
    // 仍然可点，用户点出一个看起来像 bug 的 403。
    expect(within('D:\\照片2', 'D:\\照片')).toBe(false);
    expect(within('D:\\照片2\\婚礼', 'D:\\照片')).toBe(false);
  });

  it('盘符根包住盘上的一切', () => {
    expect(within('D:\\照片\\婚礼', 'D:\\')).toBe(true);
  });

  it('POSIX 根包住一切', () => {
    expect(within('/Users/guoyg', '/')).toBe(true);
  });

  it('不同盘符互不包含', () => {
    expect(within('E:\\照片', 'D:\\')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run web/src/lib/pathname.test.ts`
Expected: FAIL，`Failed to resolve import "./pathname"`

- [ ] **Step 3: 写实现**

创建 `web/src/lib/pathname.ts`：

```ts
/**
 * 前端的路径处理。同时吃 `/` 和 `\` —— 服务端在 Windows 上给出来的路径是
 * `D:\照片\婚礼`，而前端拿不到 node 的 `path`，只能自己写。
 *
 * 大小写一律按原样比较，不做归一。两处调用点（`fsRoots.within`、
 * `TopBar` 的显示）拿到的路径两端都来自同一个服务端响应，不存在
 * 「一边大写一边小写」的情形；为一个不存在的输入引入归一，只会让
 * `D:\A` 和 `d:\a` 这种真正不同的输入被悄悄合并。
 */

/** 把反斜杠统一成正斜杠并剥掉末尾分隔符。空串（POSIX 根）归一成 `/`。 */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
}

/** 路径的最后一段。`D:\` 这样的盘符根返回 `D:`。 */
export function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return at === -1 ? trimmed : trimmed.slice(at + 1);
}

/** p 是否落在 root 之内（含 root 自身）。按整段比对，不用裸 startsWith。 */
export function within(p: string, root: string): boolean {
  const a = norm(p);
  const b = norm(root);
  if (a === b) return true;
  return a.startsWith(b.endsWith('/') ? b : `${b}/`);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run web/src/lib/pathname.test.ts`
Expected: PASS，13 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add web/src/lib/pathname.ts web/src/lib/pathname.test.ts
git commit -m "feat: 前端路径工具 —— 同时吃 / 和 \\ 两种分隔符"
```

---

### Task 2: win32 盘符枚举

**Files:**
- Create: `server/lib/drives.js`
- Test: `server/lib/drives.test.js`
- Modify: `server/lib/session.js:150-177`（`browseRoots`）

**Interfaces:**
- Consumes: 无
- Produces: `listDrives(): Promise<string[]>` —— 返回形如 `['C:\\', 'D:\\']` 的可读盘符根；非 win32 平台返回 `[]`

- [ ] **Step 1: 写失败的测试**

创建 `server/lib/drives.test.js`：

```js
import { describe, it, expect, vi, afterEach } from 'vitest';
import { probeDrive, DRIVE_LETTERS } from './drives.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('DRIVE_LETTERS', () => {
  it('是 A 到 Z 共 26 个', () => {
    expect(DRIVE_LETTERS).toHaveLength(26);
    expect(DRIVE_LETTERS[0]).toBe('A');
    expect(DRIVE_LETTERS[25]).toBe('Z');
  });
});

describe('probeDrive', () => {
  it('能列出内容的盘符返回它的根路径', async () => {
    const readdir = vi.fn().mockResolvedValue(['Users']);
    await expect(probeDrive('C', { readdir, timeoutMs: 50 })).resolves.toBe('C:\\');
    expect(readdir).toHaveBeenCalledWith('C:\\');
  });

  it('列不出来的盘符返回 null', async () => {
    const readdir = vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }));
    await expect(probeDrive('B', { readdir, timeoutMs: 50 })).resolves.toBeNull();
  });

  it('超时的盘符返回 null，不把整趟枚举卡住', async () => {
    // 未插盘的光驱、断开的网络驱动器会让 readdir 挂很久。
    const readdir = vi.fn(() => new Promise(() => {}));   // 永不 settle
    await expect(probeDrive('Z', { readdir, timeoutMs: 20 })).resolves.toBeNull();
  });

  it('超时之后原来那个 promise later reject 不会变成 unhandled rejection', async () => {
    let rejectIt;
    const readdir = vi.fn(() => new Promise((_, rej) => { rejectIt = rej; }));
    const result = await probeDrive('Z', { readdir, timeoutMs: 20 });
    expect(result).toBeNull();
    rejectIt(new Error('迟到的失败'));
    // 给微任务队列一个回合；没有 handler 的话 node 会在这里炸
    await new Promise((r) => setTimeout(r, 10));
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run server/lib/drives.test.js`
Expected: FAIL，`Failed to resolve import "./drives.js"`

- [ ] **Step 3: 写实现**

创建 `server/lib/drives.js`：

```js
import fs from 'node:fs/promises';
import os from 'node:os';

/**
 * Windows 盘符枚举。
 *
 * **不用 `wmic`**（Windows 11 已经移除了它），**不起子进程**——一个纯 `fs`
 * 调用能解决的事不值得引入 `child_process` 的错误处理面。26 次 readdir
 * 并行跑，能列出内容的就算一个可浏览的根。
 */

export const DRIVE_LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

/** 单个盘符的探测超时。未插盘的光驱、断开的网络驱动器会挂很久。 */
const DEFAULT_TIMEOUT_MS = 400;

/**
 * 探测一个盘符。能 readdir 就返回 `'D:\\'`，否则 null。
 *
 * `readdir` 和 `timeoutMs` 可注入，测试才摆得出「永不返回的驱动器」这种情形——
 * 真实的断开网络驱动器没法在 CI 上复现。
 *
 * 超时用 `Promise.race`：`fs.readdir` 没法中止，那个 promise 会继续跑完。
 * race 在建立时就给两边都挂上了 handler，所以它**之后**才 reject 也不会
 * 变成 unhandled rejection —— 那在 Node 里是要让整个进程崩掉的。
 */
export async function probeDrive(letter, { readdir = fs.readdir, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const root = `${letter}:\\`;
  let timer;
  try {
    await Promise.race([
      readdir(root),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('drive-probe-timeout')), timeoutMs);
      }),
    ]);
    return root;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 全部可读盘符。非 win32 平台返回空数组——调用方因此不需要自己判平台。
 *
 * `platform` 可注入，让测试在 macOS 上也验证得了 win32 分支。
 */
export async function listDrives({ platform = os.platform(), ...opts } = {}) {
  if (platform !== 'win32') return [];
  const probed = await Promise.all(DRIVE_LETTERS.map((l) => probeDrive(l, opts)));
  return probed.filter((p) => p !== null);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/lib/drives.test.js`
Expected: PASS，5 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add server/lib/drives.js server/lib/drives.test.js
git commit -m "feat: win32 盘符枚举 —— 并行探测 A-Z，每个单独超时"
```

---

### Task 3: `browseRoots()` 接入盘符

**Files:**
- Modify: `server/lib/session.js:150-177`
- Test: `server/lib/session.test.js`（追加）

**Interfaces:**
- Consumes: Task 2 的 `listDrives({ platform })`
- Produces: `browseRoots({ platform })` —— 多一个可注入的 `platform` 参数，默认 `os.platform()`

- [ ] **Step 1: 写失败的测试**

在 `server/lib/session.test.js` 末尾追加：

```js
describe('browseRoots 在 win32 上', () => {
  it('盘符根包住 homedir 时不再单独把 homedir 列进去', async () => {
    // 这一条不是风格偏好。C:\ 已经是根了，再把 C:\Users\guoyg 也列成根，
    // 前端 containingRoot() 取**最长匹配**会返回后者，于是 atRootBoundary()
    // 判定你站在边界上，目录浏览器的「上级」按钮当场变灰——明明整个 C 盘
    // 都可浏览，你却退不出自己的用户目录。
    const roots = await browseRoots({
      platform: 'win32',
      listDrives: async () => ['C:\\', 'D:\\'],
      homedir: () => 'C:\\Users\\guoyg',
    });
    expect(roots).toEqual(['C:\\', 'D:\\']);
  });

  it('没有任何盘符根包住 homedir 时才补上它', async () => {
    // C 盘枚举失败、权限不足的情况下，至少还进得去自己的主目录。
    const roots = await browseRoots({
      platform: 'win32',
      listDrives: async () => ['D:\\'],
      homedir: () => 'C:\\Users\\guoyg',
    });
    expect(roots).toEqual(['D:\\', 'C:\\Users\\guoyg']);
  });

  it('非 win32 平台行为不变：homedir 照常在列', async () => {
    const roots = await browseRoots({
      platform: 'darwin',
      listDrives: async () => [],
      homedir: () => '/Users/guoyg',
    });
    expect(roots[0]).toBe('/Users/guoyg');
  });
});
```

文件顶部的 import 里加上 `browseRoots`（如果还没有）。

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run server/lib/session.test.js -t "browseRoots 在 win32 上"`
Expected: FAIL —— `browseRoots` 不接受参数，三个用例都拿到 macOS 的真实根

- [ ] **Step 3: 写实现**

把 `server/lib/session.js:150` 起的 `browseRoots` 整个替换成：

```js
/**
 * 可浏览的根。
 *
 * 三个依赖都可注入，因为这个函数的行为**按平台分叉**，而测试只跑在一个平台上：
 * 不注入的话 win32 那条分支在 macOS 的 CI 上永远走不到，等于没有测试。
 */
export async function browseRoots({
  platform = os.platform(),
  listDrives: probe = listDrives,
  homedir = os.homedir,
} = {}) {
  const home = homedir();

  if (platform === 'win32') {
    const drives = await probe({ platform });
    // 盘符根已经包住 homedir 时**不要**再单独列它：前端 containingRoot()
    // 取最长匹配，多列一个会让「上级」按钮在用户目录里就变灰。
    // 用 pathWin32 而不是 safepath.js 的 isWithin：后者走的是**当前平台**的
    // path.relative，而 POSIX 版把反斜杠当普通字符，`C:\Users\guoyg` 会被当成
    // 一整段不可拆分的名字，判定必然是"不包含"。node:path/win32 在任何宿主 OS
    // 上都拿得到，语义与 isWithin 一致（按路径段对齐），且对盘符字母大小写不敏感。
    const within = (d) => {
      const rel = pathWin32.relative(pathWin32.resolve(d), pathWin32.resolve(home));
      return rel === ''
        || (!rel.startsWith('..' + pathWin32.sep) && rel !== '..' && !pathWin32.isAbsolute(rel));
    };
    if (drives.some(within)) return drives;
    return [...drives, home];
  }

  const roots = [home];
  // os.tmpdir() 只在测试环境放行——测试需要在临时目录下开库。
  // 生产环境不把它算进允许列表：macOS 上是每用户独立目录，风险还能接受；
  // Linux 上通常是 /tmp，本机所有账号共享，一直可浏览的风险不一样，
  // 而且在选择器里也只会显示成一个没有意义的 "T"。
  if (process.env.NODE_ENV === 'test') {
    roots.push(os.tmpdir());
  }
  const seenVolumes = new Set();
  for (const dir of ['/Volumes', '/media', '/mnt']) {
    try {
      for (const name of await fs.readdir(dir)) {
        const candidate = path.join(dir, name);
        let real;
        try {
          real = await realpathDeep(candidate);
        } catch {
          continue; // 挂载点损坏或无权限访问，跳过
        }
        if (real === path.parse(real).root) continue; // 解析到系统根：别名卷，丢弃
        if (seenVolumes.has(real)) continue; // 同一个卷换个名字又出现了一次
        seenVolumes.add(real);
        roots.push(real);
      }
    } catch { /* 该平台没这个目录 */ }
  }
  return roots;
}
```

在 `server/lib/session.js` 顶部的 import 区加上：

```js
import { listDrives } from './drives.js';
```

以及：

```js
import pathWin32 from 'node:path/win32';
```

**不要**从 `./safepath.js` 引入 `isWithin` —— 上面那段注释说明了它为什么在这里用不了。`session.js` 顶部已有的 `import path from 'node:path'` 保持不变，POSIX 分支还在用它。

- [ ] **Step 4: 跑全套测试确认没有回归**

Run: `npx vitest run server/lib/session.test.js server/routes/`
Expected: PASS。`browseRoots()` 的既有调用点（`fs.js` 的三条路由）不传参数，走的是 `os.platform()` 默认值，行为不变。

- [ ] **Step 5: 三条门禁 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add server/lib/session.js server/lib/session.test.js
git commit -m "fix: Windows 上 C 盘以外的盘符终于够得着"
```

---

### Task 4: 前端接上 `pathname`

**Files:**
- Modify: `web/src/lib/fsRoots.ts:12-17`、`web/src/components/TopBar.tsx:62`
- Test: `web/src/lib/fsRoots.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `within` / `basename`
- Produces: 无新接口；`fsRoots.ts` 内部那个私有 `within` 被删掉，改用 `pathname.ts` 的

- [ ] **Step 1: 写失败的测试**

在 `web/src/lib/fsRoots.test.ts` 末尾追加：

```js
describe('Windows 路径', () => {
  const winRoots: FsRoot[] = [
    { path: 'C:\\', label: 'C:' },
    { path: 'D:\\', label: 'D:' },
  ];

  it('盘上的子目录归到该盘符', () => {
    expect(containingRoot('D:\\照片\\婚礼', winRoots)).toBe('D:\\');
  });

  it('站在盘符根上就是边界', () => {
    expect(atRootBoundary('D:\\', winRoots)).toBe(true);
  });

  it('站在盘上的子目录里不是边界', () => {
    // 这一条是 fsRoots.ts 里那句硬编码 `/` 的直接后果：
    // `D:\` + '/' 拼出来的前缀永远匹配不上 `D:\照片`，于是每一个 Windows
    // 目录都被判成"不属于任何根"，"上级"按钮全程变灰。
    expect(atRootBoundary('D:\\照片', winRoots)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run web/src/lib/fsRoots.test.ts -t "Windows 路径"`
Expected: FAIL，第三条挂在 `atRootBoundary('D:\\照片') === true`

- [ ] **Step 3: 改实现**

`web/src/lib/fsRoots.ts` —— 删掉私有的 `within`（第 12–17 行），改从 `pathname.ts` 引入：

```ts
import { getJSON } from './api';
import { within } from './pathname';

export interface FsRoot { path: string; label: string }

/**
 * 可浏览的根：$HOME 加上各外接卷（Windows 上是各盘符）。服务端早就提供了这个
 * 端点，但前端从来没调用过——照片在读卡器或移动硬盘上时，目录浏览器的"上级"
 * 一离开 $HOME 就 403，只能靠手动粘贴绝对路径。
 */
export const fetchRoots = () => getJSON<{ roots: FsRoot[]; home: string }>('/api/fs/roots');
```

`containingRoot` 和 `atRootBoundary` 的函数体不动 —— 它们调用的 `within` 现在来自 `pathname.ts`。

`web/src/components/TopBar.tsx` —— 顶部加 import，第 62 行改掉：

```tsx
import { basename } from '../lib/pathname';
```

```tsx
      <code title={root ?? ''}>{root ? basename(root) : ''}</code>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run web/src/lib/fsRoots.test.ts web/src/components/TopBar.test.tsx`
Expected: PASS

- [ ] **Step 5: 三条门禁 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add web/src/lib/fsRoots.ts web/src/lib/fsRoots.test.ts web/src/components/TopBar.tsx
git commit -m "fix: 前端两处硬编码的 / 改成吃两种分隔符"
```

---

## 阶段 B：拖拽定位（Task 5–6）

### Task 5: 拖拽定位的匹配逻辑

**Files:**
- Create: `web/src/lib/dropLocate.ts`
- Test: `web/src/lib/dropLocate.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `basename`
- Produces:
  - `type DropHit = { kind: 'recent'; path: string } | { kind: 'listed'; path: string } | { kind: 'none' }`
  - `locate(name: string, recent: string[], listed: { name: string; path: string }[]): DropHit`
  - `folderNameFromDrop(dt: DataTransfer): { name: string } | { error: string }`

- [ ] **Step 1: 写失败的测试**

创建 `web/src/lib/dropLocate.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { locate, folderNameFromDrop } from './dropLocate';

describe('locate', () => {
  const recent = ['/Users/guoyg/照片/婚礼-小林', '/Volumes/CARD/DCIM'];
  const listed = [
    { name: '婚礼-小林', path: '/Users/guoyg/备份/婚礼-小林' },
    { name: '写真', path: '/Users/guoyg/备份/写真' },
  ];

  it('命中最近打开优先于命中当前目录', () => {
    // 最近打开是一条完整的绝对路径，用户上次就是从那儿开的；
    // 当前目录里的同名文件夹只是碰巧叫这个名字。
    expect(locate('婚礼-小林', recent, listed)).toEqual({
      kind: 'recent', path: '/Users/guoyg/照片/婚礼-小林',
    });
  });

  it('最近打开没有时退到当前目录的子目录', () => {
    expect(locate('写真', recent, listed)).toEqual({
      kind: 'listed', path: '/Users/guoyg/备份/写真',
    });
  });

  it('都没命中时返回 none', () => {
    expect(locate('从没见过的文件夹', recent, listed)).toEqual({ kind: 'none' });
  });

  it('Windows 路径的 basename 也认得出来', () => {
    expect(locate('婚礼', ['D:\\照片\\婚礼'], [])).toEqual({
      kind: 'recent', path: 'D:\\照片\\婚礼',
    });
  });

  it('最近打开里有多条同名时取最靠前的那条（MRU 顺序即优先级）', () => {
    const dup = ['/a/婚礼', '/b/婚礼'];
    expect(locate('婚礼', dup, [])).toEqual({ kind: 'recent', path: '/a/婚礼' });
  });
});

/** 造一个够用的假 DataTransfer。只实现 items 那一条路径。 */
function fakeDT(entries: ({ name: string; isDirectory: boolean } | null)[]): DataTransfer {
  return {
    items: entries.map((e) => ({
      webkitGetAsEntry: () => e,
    })),
  } as unknown as DataTransfer;
}

describe('folderNameFromDrop', () => {
  it('拖入一个文件夹时取它的名字', () => {
    expect(folderNameFromDrop(fakeDT([{ name: '婚礼-小林', isDirectory: true }])))
      .toEqual({ name: '婚礼-小林' });
  });

  it('拖入文件而不是文件夹时给出提示', () => {
    expect(folderNameFromDrop(fakeDT([{ name: 'IMG_0001.CR2', isDirectory: false }])))
      .toEqual({ error: '请拖入文件夹，不是文件' });
  });

  it('拖入多个文件夹时只取第一个，并说清楚', () => {
    // 静默忽略其余的会让用户以为程序没反应。
    expect(folderNameFromDrop(fakeDT([
      { name: '婚礼', isDirectory: true },
      { name: '写真', isDirectory: true },
    ]))).toEqual({ name: '婚礼', notice: '一次只能打开一个文件夹，已按「婚礼」定位' });
  });

  it('拿不到任何 entry 时给出提示', () => {
    // webkitGetAsEntry 返回了 null（拖的是一段文本，不是文件）。
    expect(folderNameFromDrop(fakeDT([null]))).toEqual({ error: '没能识别拖入的内容，请改用下面的目录浏览器' });
  });

  it('浏览器根本没有 webkitGetAsEntry 这个方法时也不抛', () => {
    // 上面那条 fakeDT 造出来的 item **永远带着** webkitGetAsEntry 方法，
    // 只是调用它返回 null —— 它测不到「方法本身不存在」这条路径。
    // 少了这一条，实现里 `?? null` 被人删掉（`?.()` 短路求值是 undefined，
    // 不是 null）会一路溜过 `!== null` 过滤，在 `e.isDirectory` 上抛 TypeError，
    // 而十条用例全绿、tsc 也干净。
    const noMethod = { items: [{}] } as unknown as DataTransfer;
    expect(folderNameFromDrop(noMethod)).toEqual({ error: '没能识别拖入的内容，请改用下面的目录浏览器' });
  });

  it('空的 DataTransfer 也不抛', () => {
    expect(folderNameFromDrop(fakeDT([]))).toEqual({ error: '没能识别拖入的内容，请改用下面的目录浏览器' });
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run web/src/lib/dropLocate.test.ts`
Expected: FAIL，`Failed to resolve import "./dropLocate"`

- [ ] **Step 3: 写实现**

创建 `web/src/lib/dropLocate.ts`：

```ts
import { basename } from './pathname';

/**
 * 拖拽定位（规格 §3.4）。
 *
 * **浏览器给不了绝对路径。** `File.path` 是 Electron 才有的东西；
 * `webkitRelativePath` 只给到「相对于被拖入的那个文件夹」的路径；
 * `FileSystemDirectoryEntry.fullPath` 是一个虚拟路径（`/foldername`）。
 * 这是「浏览器 + 本机服务」这个架构的天花板，不是写法问题。
 *
 * 所以这个模块**只用拖进来的那个名字去比对前端手里已有的两份数据**，
 * 不发任何请求、不做任何搜索，也**永远不会静默猜错**——它从不替用户
 * 打开任何东西，只负责把候选指出来。
 */

export type DropHit =
  | { kind: 'recent'; path: string }
  | { kind: 'listed'; path: string }
  | { kind: 'none' };

/**
 * 拖进来的名字落在哪。
 *
 * 最近打开优先于当前目录：那是一条用户上次真的从那儿开过的完整路径，
 * 而当前目录里的同名子目录只是碰巧叫这个名字。
 */
export function locate(
  name: string,
  recent: string[],
  listed: { name: string; path: string }[],
): DropHit {
  const hitRecent = recent.find((p) => basename(p) === name);
  if (hitRecent !== undefined) return { kind: 'recent', path: hitRecent };

  const hitListed = listed.find((d) => d.name === name);
  if (hitListed !== undefined) return { kind: 'listed', path: hitListed.path };

  return { kind: 'none' };
}

export type DropRead =
  | { name: string; notice?: string }
  | { error: string };

const UNRECOGNIZED = '没能识别拖入的内容，请改用下面的目录浏览器';

/**
 * 从一次 drop 里读出文件夹名。
 *
 * `webkitGetAsEntry()` 只用来问两件事：这是不是目录、它叫什么。
 * **不读任何文件内容**——一个三千张 RAW 的文件夹，遍历它的 entries
 * 要花的时间和它能换来的信息完全不成比例（换来的仍然不是绝对路径）。
 */
export function folderNameFromDrop(dt: DataTransfer): DropRead {
  const items = Array.from(dt.items ?? []);
  // `webkitGetAsEntry` 在本项目的 lib.dom.d.ts 里是**必选**成员，返回
  // `FileSystemEntry | null`，所以这里不需要任何断言。
  //
  // 两处细节都是踩过的：
  // 1. 用 `?.()` 是因为**运行时**它可能真的不存在（老浏览器），而类型说它一定在。
  // 2. `?? null` 不能省。`?.()` 短路时求值是 `undefined` 而不是 `null`，
  //    下一行的 `!== null` 挡不住它，于是一个 undefined 会溜进 entries，
  //    在 `e.isDirectory` 上抛 TypeError —— 而这恰好就是「拿不到 entry」
  //    那条用例声称要处理的场景。
  const entries = items
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((e): e is FileSystemEntry => e !== null);

  if (entries.length === 0) return { error: UNRECOGNIZED };

  const dirs = entries.filter((e) => e.isDirectory);
  if (dirs.length === 0) return { error: '请拖入文件夹，不是文件' };

  if (dirs.length > 1) {
    return { name: dirs[0].name, notice: `一次只能打开一个文件夹，已按「${dirs[0].name}」定位` };
  }
  return { name: dirs[0].name };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run web/src/lib/dropLocate.test.ts`
Expected: PASS，11 个用例全绿（`locate` 5 条 + `folderNameFromDrop` 6 条）

- [ ] **Step 5: 提交**

```bash
git add web/src/lib/dropLocate.ts web/src/lib/dropLocate.test.ts
git commit -m "feat: 拖拽定位的匹配逻辑 —— 只比对手里已有的两份数据"
```

---

### Task 6: 拖拽接进选择器

**Files:**
- Modify: `web/src/components/FolderPicker.tsx`、`web/src/components/DirBrowser.tsx`、`web/src/styles.css`
- Test: `web/src/components/FolderPicker.test.tsx`（追加）

**Interfaces:**
- Consumes: Task 5 的 `locate` / `folderNameFromDrop` / `DropHit`
- Produces: `DirBrowser` 新增两个可选 prop —— `highlightName?: string`（高亮同名子目录）、`gotoPath?: string`（外部要求跳转到的路径，变化时触发一次导航）

- [ ] **Step 1: 写失败的测试**

在 `web/src/components/FolderPicker.test.tsx` 末尾追加：

```tsx
import { fireEvent } from '@testing-library/react';

/** 造一次 drop 事件用的假 DataTransfer。 */
function dropDataTransfer(entries: { name: string; isDirectory: boolean }[]) {
  return {
    items: entries.map((e) => ({ webkitGetAsEntry: () => e })),
    types: ['Files'],
  };
}

describe('拖拽定位', () => {
  it('命中最近打开时把那条列成候选，但不自动打开', () => {
    // 「永远不会静默猜错」是这条功能的立身之本：它从不替你打开任何东西。
    window.localStorage.setItem('photocull.recent', JSON.stringify(['/Users/guoyg/婚礼-小林']));
    const open = vi.fn();
    useLibrary.setState({ open, phase: 'idle' });

    const { getByTestId, getByText } = render(<FolderPicker />);
    fireEvent.drop(getByTestId('picker-dropzone'), {
      dataTransfer: dropDataTransfer([{ name: '婚礼-小林', isDirectory: true }]),
    });

    expect(getByText(/婚礼-小林/)).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
  });

  it('拖入文件而不是文件夹时显示提示', () => {
    const { getByTestId, getByText } = render(<FolderPicker />);
    fireEvent.drop(getByTestId('picker-dropzone'), {
      dataTransfer: dropDataTransfer([{ name: 'IMG_0001.CR2', isDirectory: false }]),
    });
    expect(getByText('请拖入文件夹，不是文件')).toBeTruthy();
  });

  it('都没命中时把名字显示出来让用户自己找', () => {
    const { getByTestId, getByText } = render(<FolderPicker />);
    fireEvent.drop(getByTestId('picker-dropzone'), {
      dataTransfer: dropDataTransfer([{ name: '从没见过的', isDirectory: true }]),
    });
    expect(getByText(/从没见过的/)).toBeTruthy();
    expect(getByText(/请在下面找到它/)).toBeTruthy();
  });

  // 上面三条用例的 mock 对 /api/fs/list 恒返回空 dirs，locate() 永远只可能
  // 命中 recent 或 none 这两支，DirBrowser 的 gotoPath 跳转、dirbrowser-hit
  // 高亮这两处代码从没被任何用例跑到过。这条补上 dirs 非空、且不落在 recent
  // 里的场景，专门去戳 kind === 'listed' 这一支。
  it('命中当前目录列出的子目录时那一行会高亮，但同样不自动打开', async () => {
    apiMock.listDirs = [{ name: '写真', path: '/tmp/写真' }];
    const open = vi.fn();
    useLibrary.setState({ open, phase: 'idle' });

    const { getByTestId } = render(<FolderPicker />);
    // DirBrowser 的目录列表是异步拉回来的（getJSON 返回一个 Promise），
    // 挂载那一刻列表还是空的——drop 太早，locate() 会拿着空的 listed 去比对，
    // 测的就不是这条分支了，必须先等它渲染出来。
    await screen.findByRole('button', { name: '写真' });

    fireEvent.drop(getByTestId('picker-dropzone'), {
      dataTransfer: dropDataTransfer([{ name: '写真', isDirectory: true }]),
    });

    // 命中的同时会触发 DirBrowser 的 gotoPath 效果——那也是一次异步的
    // browse()，会再发一次 /api/fs/list。用 waitFor 重新查询而不是复用上面
    // 那个引用，把这次跟着来的状态更新也等掉，不然它会在这条用例返回之后
    // 才落地，冒出 act() 警告污染下一条用例的输出。
    await waitFor(() => {
      const li = screen.getByRole('button', { name: '写真' }).closest('li');
      expect(li).not.toBeNull();
      expect(li?.className).toContain('dirbrowser-hit');
    });
    expect(open).not.toHaveBeenCalled();
  });
});
```

文件顶部按需补上 `useLibrary`、`screen`、`waitFor` 的 import（参照该测试文件已有的写法）。

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run web/src/components/FolderPicker.test.tsx -t "拖拽定位"`
Expected: FAIL，`Unable to find an element by: [data-testid="picker-dropzone"]`

- [ ] **Step 3: 改 DirBrowser**

`web/src/components/DirBrowser.tsx` —— props 加两个，列表行加高亮 class，另加一个响应 `gotoPath` 的 effect：

```tsx
interface Props {
  /** 每次导航后回报当前所在目录。父组件决定「当前目录」意味着什么。 */
  onLocationChange: (path: string) => void;
  maxHeight?: number;
  /** 每行右侧的额外操作，比如 FolderPicker 的「直接打开」。 */
  rowAction?: (dir: { name: string; path: string }) => ReactNode;
  /** 拖进来的文件夹名。同名的子目录会被高亮，每导航一层都重新判一次。 */
  highlightName?: string;
  /** 外部要求跳转到的路径。变一次跳一次；不变时不重复导航。 */
  gotoPath?: string;
  /** 当前列出的子目录，供父组件做拖拽定位的比对。 */
  onListingChange?: (dirs: { name: string; path: string }[]) => void;
}

export function DirBrowser({
  onLocationChange, maxHeight = 260, rowAction, highlightName, gotoPath, onListingChange,
}: Props) {
```

`browse` 函数里 `setListing(next)` 之后加一行上报：

```tsx
      setListing(next);
      onLocationChange(next.path);
      onListingChange?.(next.dirs);
```

`useEffect(() => { void browse(); }, []);` 之后加：

```tsx
  // gotoPath 变化时跳一次。用 ref 记住上一次的值而不是把 gotoPath 直接放进
  // 依赖数组——父组件重渲染时传下来的可能是同一个字符串，但用户可能已经
  // 手动导航去了别处，那时再跳一次就是把他拽回来。
  const lastGoto = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!gotoPath || gotoPath === lastGoto.current) return;
    lastGoto.current = gotoPath;
    void browse(gotoPath);
  }, [gotoPath]);
```

列表行的 `<li>` 换成带高亮 class 的版本：

```tsx
        {listing?.dirs.map((d) => (
          <li key={d.path} className={highlightName && d.name === highlightName ? 'dirbrowser-hit' : undefined}>
            <button className="dirbrowser-name" onClick={() => void browse(d.path)}>{d.name}</button>
            {rowAction?.(d)}
          </li>
        ))}
```

- [ ] **Step 4: 改 FolderPicker**

`web/src/components/FolderPicker.tsx` —— 顶部补 import：

```tsx
import { folderNameFromDrop, locate, type DropHit } from '../lib/dropLocate';
```

组件内部新增三个 state 与一个 drop 处理函数（放在 `choose` 之后）：

```tsx
  const [dropName, setDropName] = useState<string | null>(null);
  const [dropHit, setDropHit] = useState<DropHit>({ kind: 'none' });
  const [dropError, setDropError] = useState<string | null>(null);
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  const [listed, setListed] = useState<{ name: string; path: string }[]>([]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropError(null);
    setDropNotice(null);
    const read = folderNameFromDrop(e.dataTransfer);
    if ('error' in read) {
      setDropName(null);
      setDropHit({ kind: 'none' });
      setDropError(read.error);
      return;
    }
    setDropName(read.name);
    setDropNotice(read.notice ?? null);
    setDropHit(locate(read.name, recent, listed));
  };
```

最外层 `<div className="picker">` 换成带 drop 处理的版本：

```tsx
    <div className="picker" data-testid="picker-dropzone"
         onDragOver={(e) => e.preventDefault()}
         onDrop={onDrop}>
      <h1>选择照片文件夹</h1>

      {/* 拖拽的落点：帮你定位，你点一下确认。浏览器不把绝对路径交给网页，
          所以这里能做的上限就是把候选指出来——它从不替你打开任何东西。 */}
      {dropError && <p className="picker-drop picker-drop-error">{dropError}</p>}
      {dropNotice && <p className="picker-drop">{dropNotice}</p>}
      {dropName && dropHit.kind !== 'none' && (
        <div className="picker-drop picker-drop-hit">
          找到了「{dropName}」：<code>{dropHit.path}</code>
          <button className="primary" onClick={() => void choose(dropHit.path)}
                  disabled={phase === 'scanning'}>打开</button>
        </div>
      )}
      {dropName && dropHit.kind === 'none' && (
        <p className="picker-drop">
          你拖进来的是「{dropName}」，请在下面找到它 —— 浏览器不会把文件夹的完整路径告诉网页，
          所以这一步只能由你点一下。
        </p>
      )}
```

`<DirBrowser>` 那一段补上三个新 prop：

```tsx
      <DirBrowser
        onLocationChange={setHere}
        onListingChange={setListed}
        highlightName={dropName ?? undefined}
        gotoPath={dropHit.kind === 'listed' ? dropHit.path : undefined}
        maxHeight={Math.round(window.innerHeight * 0.44)}
        rowAction={(d) => (
          <button className="ghost" onClick={() => void choose(d.path)}
                  disabled={phase === 'scanning'}>打开</button>
        )}
      />
```

顶部把 React 的类型 import 补上（文件现在只 import 了 `useState`）：

```tsx
import { useState, type DragEvent as ReactDragEvent } from 'react';
```

并把 `onDrop` 的形参类型改成 `ReactDragEvent`。

- [ ] **Step 5: 加样式**

`web/src/styles.css` 末尾追加：

```css
/* 拖拽定位的提示。常驻一行，不做浮层——浮层会盖住它让你去找的那个列表。 */
.picker-drop {
  margin: 8px 0;
  padding: 8px 12px;
  border-radius: 6px;
  background: rgba(255, 255, 255, .06);
  font-size: 13px;
  line-height: 1.6;
}
.picker-drop-error { background: rgba(220, 80, 80, .16); }
.picker-drop-hit { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.picker-drop-hit code { flex: 1 1 auto; word-break: break-all; }

/* 命中的子目录。用背景色而不是边框——边框会把行高撑开，列表滚动时会跳。 */
.dirbrowser-hit { background: rgba(120, 180, 255, .18); border-radius: 4px; }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run web/src/components/FolderPicker.test.tsx web/src/components/DirBrowser.test.tsx`
Expected: PASS

- [ ] **Step 7: 三条门禁 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add web/src/components/FolderPicker.tsx web/src/components/FolderPicker.test.tsx \
        web/src/components/DirBrowser.tsx web/src/styles.css
git commit -m "feat: 把文件夹拖进选择器就能定位到它"
```

---

## 阶段 C：网格缩放（Task 7–8）

### Task 7: `gridSize` 迁移成 `cellWidth`

**Files:**
- Modify: `server/lib/store.js:4`（`DEFAULT_SETTINGS`）与 `sanitize`、`server/routes/marks.js:166`（settings 白名单）、`web/src/types.ts:25-29`、`web/src/store/library.ts:162`、`web/src/components/Grid.tsx:12-24`
- Test: `server/lib/store.test.js`（追加）

**Interfaces:**
- Consumes: 无
- Produces:
  - `Settings.cellWidth: number`（`Settings.gridSize` 删除）
  - `server/lib/store.js` 导出 `CELL_WIDTH_MIN = 120`、`CELL_WIDTH_MAX = 420`、`normalizeCellWidth(value: unknown): number`

- [ ] **Step 1: 写失败的测试**

在 `server/lib/store.test.js` 末尾追加：

```js
import { normalizeCellWidth, CELL_WIDTH_MIN, CELL_WIDTH_MAX } from './store.js';

describe('normalizeCellWidth', () => {
  it('三档旧值迁移成现在 CELL_W 表里的那三个数', () => {
    // 迁移必须落在这三个数上，老文件夹的观感才一格都不变。
    expect(normalizeCellWidth('small')).toBe(150);
    expect(normalizeCellWidth('medium')).toBe(210);
    expect(normalizeCellWidth('large')).toBe(290);
  });

  it('合法数字原样通过', () => {
    expect(normalizeCellWidth(180)).toBe(180);
    expect(normalizeCellWidth(CELL_WIDTH_MIN)).toBe(CELL_WIDTH_MIN);
    expect(normalizeCellWidth(CELL_WIDTH_MAX)).toBe(CELL_WIDTH_MAX);
  });

  it('超范围的钳制到边界', () => {
    expect(normalizeCellWidth(50)).toBe(CELL_WIDTH_MIN);
    expect(normalizeCellWidth(9999)).toBe(CELL_WIDTH_MAX);
  });

  it('非数字一律回落 210', () => {
    expect(normalizeCellWidth(undefined)).toBe(210);
    expect(normalizeCellWidth(null)).toBe(210);
    expect(normalizeCellWidth('随便什么')).toBe(210);
    expect(normalizeCellWidth(NaN)).toBe(210);
    expect(normalizeCellWidth({})).toBe(210);
  });

  it('小数取整', () => {
    expect(normalizeCellWidth(180.7)).toBe(181);
  });
});

describe('settings 迁移', () => {
  it('读一个只有 gridSize 的旧文件，得到对应的 cellWidth', async () => {
    await writeMarksFile(tmp, { version: 1, marks: {}, settings: { gridSize: 'large' } });
    const data = await readMarksFile(tmp);
    expect(data.settings.cellWidth).toBe(290);
    expect(data.settings.gridSize).toBeUndefined();
  });

  it('cellWidth 与 gridSize 同时存在时以 cellWidth 为准', async () => {
    await writeMarksFile(tmp, { version: 1, marks: {}, settings: { gridSize: 'small', cellWidth: 333 } });
    const data = await readMarksFile(tmp);
    expect(data.settings.cellWidth).toBe(333);
  });
});
```

**注意**：`writeMarksFile` 内部会调 `sanitize`，所以第二组用例其实是「写进去时就被归一了」。这正是我们要的——旧字段不会在磁盘上留存。

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run server/lib/store.test.js -t "normalizeCellWidth"`
Expected: FAIL，`normalizeCellWidth is not a function`

- [ ] **Step 3: 改 store.js**

`server/lib/store.js` 顶部，把第 4 行的 `DEFAULT_SETTINGS` 换掉并加上迁移函数：

```js
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
```

`sanitize()` 里 settings 那一行（原来是 `settings: { ...DEFAULT_SETTINGS, ...(parsed?.settings ?? {}) }`，两处都有）换成一个共用的辅助函数。在 `sanitize` 上方加：

```js
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
```

然后把 `sanitize()` 里那两处 `settings: { ...DEFAULT_SETTINGS, ...(parsed?.settings ?? {}) }` 都换成：

```js
    settings: sanitizeSettings(parsed?.settings),
```

最后，`setSettings()` 也要归一 —— **只做落盘那一侧是不够的**。`writeMarksFile()` 里的
`sanitize(data)` 返回的是一个**新对象**用于落盘，从不写回 `data` 本身，所以磁盘上的值
永远是钳制过的，而进程内存里的 `data.settings` 从赋值那一刻起就一直是原始的非法值，
直到重启。这份内存对象会被四条路径原样回显给**所有人**（`PUT /settings` 自己的响应体、
`GET /api/library/marks`、`POST /api/library/open`、访客 join/resume），而前端是零防御的
（类型注释写的就是「服务端负责钳制」）。`'banana'` 会让 `cellH` 变成 `NaN`，负数会让
CSS 宽度失效，网格渲染当场坏掉且不会自愈。

```js
    setSettings(patch) {
      // F3: Reject mutations on closed store
      if (closed) throw new Error('Cannot modify a closed MarkStore');
      const next = { ...patch };
      // 只在 patch 真的带了这个字段时才归一：无条件调用的话
      // normalizeCellWidth(undefined) 会算出 210，把用户调好的宽度静默弹回默认值。
      if ('cellWidth' in next) next.cellWidth = normalizeCellWidth(next.cellWidth);
      Object.assign(data.settings, next);
      schedule();
    },
```

- [ ] **Step 4: 改路由白名单**

`server/routes/marks.js:166`：

```js
    const allowed = ['burstThresholdMs', 'cellWidth', 'sort'];
```

同一个处理函数里还要归一一次，位置很关键：**必须在算审计 `from`/`to` 差异之前**。
那段代码是先用 `clean` 的原始值算出 `to`、再调 `setSettings` 的，只改 store 不改这里的话，
管理员发 `9999` 时审计日志会记 `to: {cellWidth: 9999}` 而实际存的是 `420`——**审计日志
说谎比不记还糟**。归一提前之后，那条 `if (current[key] === value) continue;` 也才能正确
判定「归一后与当前值相同 = 什么也没变」，不产生噪音记录。`normalizeCellWidth` 是幂等的，
两层叠加没有副作用。

```js
import { normalizeCellWidth } from '../lib/store.js';
```

```js
    if ('cellWidth' in clean) clean.cellWidth = normalizeCellWidth(clean.cellWidth);
```

- [ ] **Step 5: 改前端类型与默认值**

`web/src/types.ts` 的 `Settings`：

```ts
export interface Settings {
  burstThresholdMs: number;
  /** 网格里一个格子的像素宽度，120–420。服务端 store.js 负责钳制与迁移。 */
  cellWidth: number;
  sort: 'time' | 'name';
}
```

`web/src/store/library.ts:162`：

```ts
  settings: { burstThresholdMs: 1000, cellWidth: 210, sort: 'time' },
```

`web/src/components/Grid.tsx` —— 删掉 `CELL_W` 常量表，第 18、24 行改成：

```tsx
  const cellWidth = useLibrary((s) => s.settings.cellWidth);
```

```tsx
  const cellW = cellWidth;
```

（保留 `cellW` 这个局部名，下面 `cellH`、`ResizeObserver`、`style={{ width: cellW }}` 三处引用因此一个字都不用改。）

- [ ] **Step 6: 跑测试确认通过**

Run: `npm test`
Expected: PASS。凡是断言 `settings.gridSize` 的既有用例都要跟着改成 `cellWidth`——搜 `gridSize` 把它们找出来：

```bash
grep -rn "gridSize" web/src server --include="*.ts" --include="*.tsx" --include="*.js" | grep -v "server/public"
```

改完这条 grep 只应该剩下 `server/lib/store.js` 里那个 `LEGACY_GRID_SIZE` 迁移表。

- [ ] **Step 7: 三条门禁 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add server/lib/store.js server/lib/store.test.js server/routes/marks.js \
        web/src/types.ts web/src/store/library.ts web/src/components/Grid.tsx
git commit -m "refactor: gridSize 三档换成连续的 cellWidth，旧值按原像素迁移"
```

---

### Task 8: 缩放控件

**Files:**
- Create: `web/src/components/ZoomSlider.tsx`、`web/src/components/ZoomSlider.test.tsx`
- Modify: `web/src/components/TopBar.tsx`、`web/src/components/Grid.tsx`、`web/src/store/library.ts`、`web/src/styles.css`

**Interfaces:**
- Consumes: Task 7 的 `Settings.cellWidth`
- Produces: `useLibrary.setCellWidth(px: number, persist?: boolean): void` —— 立刻改本地状态；`persist` 为 true 时防抖 400ms 后 `PUT /api/library/settings`

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/ZoomSlider.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ZoomSlider } from './ZoomSlider';
import { useLibrary } from '../store/library';

beforeEach(() => {
  vi.useFakeTimers();
  useLibrary.setState({ settings: { burstThresholdMs: 1000, cellWidth: 210, sort: 'time' } });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('ZoomSlider', () => {
  it('拖动立刻改本地状态', () => {
    const { getByLabelText } = render(<ZoomSlider />);
    fireEvent.change(getByLabelText('网格缩放'), { target: { value: '300' } });
    expect(useLibrary.getState().settings.cellWidth).toBe(300);
  });

  it('连续拖动只在停下之后发一次请求', async () => {
    // 滑块是连续拖动的，每帧发一个请求会把服务端捶烂，
    // 而且每一次都要走 markStore 的防抖落盘。
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, settings: {} }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    );
    const { getByLabelText } = render(<ZoomSlider />);
    const slider = getByLabelText('网格缩放');

    fireEvent.change(slider, { target: { value: '240' } });
    fireEvent.change(slider, { target: { value: '260' } });
    fireEvent.change(slider, { target: { value: '280' } });
    expect(fetchSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    const settingsCalls = fetchSpy.mock.calls.filter(
      ([url]) => String(url).includes('/api/library/settings'));
    expect(settingsCalls).toHaveLength(1);
    expect(JSON.parse(String(settingsCalls[0][1]?.body))).toEqual({ cellWidth: 280 });
  });

  it('滑块的上下界就是服务端认的那两个数', () => {
    const { getByLabelText } = render(<ZoomSlider />);
    const slider = getByLabelText('网格缩放') as HTMLInputElement;
    expect(slider.min).toBe('120');
    expect(slider.max).toBe('420');
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run web/src/components/ZoomSlider.test.tsx`
Expected: FAIL，`Failed to resolve import "./ZoomSlider"`

- [ ] **Step 3: 在 library store 里加 `setCellWidth`**

`web/src/store/library.ts` —— 在 `LibraryState` 接口里加一行声明：

```ts
  /**
   * 改网格格子宽度。本地状态立刻变（滑块要跟手），落盘防抖 400ms——
   * 滑块是连续拖动的，每帧一个请求会把服务端和 markStore 的落盘一起捶烂。
   */
  setCellWidth: (px: number, persist?: boolean) => void;
```

在 `create<LibraryState>` 的返回对象里（`dismissCloseBlock` 之后）加实现，并在文件顶部模块作用域加一个定时器变量：

```ts
/** 缩放落盘的防抖定时器。模块级：整个前端同时只有一个库开着。 */
let cellWidthTimer: ReturnType<typeof setTimeout> | null = null;
```

```ts
  setCellWidth(px, persist = true) {
    // 钳制在这里也做一遍。服务端 store.js 是权威，但本地状态要立刻用于渲染，
    // 等一趟往返回来再钳制的话，中间那一帧网格会按一个非法宽度铺出来。
    const clamped = Math.min(420, Math.max(120, Math.round(px)));
    set((s) => ({ settings: { ...s.settings, cellWidth: clamped } }));
    if (!persist) return;
    if (cellWidthTimer) clearTimeout(cellWidthTimer);
    cellWidthTimer = setTimeout(() => {
      cellWidthTimer = null;
      void putJSON('/api/library/settings', { cellWidth: clamped }).catch(() => {});
    }, 400);
  },
```

确认 `putJSON` 已在该文件顶部 import（原文件 import 的是 `getJSON, postJSON, openStream, ...`，把 `putJSON` 加进去）。

- [ ] **Step 4: 写 ZoomSlider**

创建 `web/src/components/ZoomSlider.tsx`：

```tsx
import { useLibrary } from '../store/library';

/** 与服务端 store.js 的 CELL_WIDTH_MIN / MAX 必须一致。 */
const MIN = 120;
const MAX = 420;

/**
 * 网格缩放滑块。
 *
 * 改造前 `gridSize` 三档枚举在类型、服务端默认值、Grid 的 CELL_W 表里都存在，
 * **唯独没有任何界面能改它**。这个组件是那条链路缺的最后一环。
 */
export function ZoomSlider() {
  const cellWidth = useLibrary((s) => s.settings.cellWidth);
  const setCellWidth = useLibrary((s) => s.setCellWidth);

  return (
    <label className="zoom-slider">
      <span className="zoom-slider-icon" aria-hidden="true">▦</span>
      <input
        type="range"
        aria-label="网格缩放"
        min={MIN}
        max={MAX}
        step={10}
        value={cellWidth}
        onChange={(e) => setCellWidth(Number(e.target.value))}
      />
    </label>
  );
}
```

- [ ] **Step 5: 接进 TopBar 与 Grid**

`web/src/components/TopBar.tsx` —— 顶部 import，然后把它放进 `.topbar-actions` 之前（多选按钮之后）：

```tsx
import { ZoomSlider } from './ZoomSlider';
```

```tsx
      <ZoomSlider />
```

`web/src/components/Grid.tsx` —— 在 `useEffect(() => { document.body.dataset.cols = ... })` 之后加滚轮缩放：

```tsx
  const setCellWidth = useLibrary((s) => s.setCellWidth);

  // ⌘/Ctrl + 滚轮缩放网格。
  //
  // 这个组合键**浏览器自己也在用**（页面缩放），所以必须 passive: false +
  // preventDefault()——否则用户想缩网格，缩掉的是整个页面，而网格纹丝不动。
  // React 的 onWheel 挂上去是 passive 的，preventDefault 会被忽略，所以这里
  // 只能用原生 addEventListener。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      // deltaY 向上为负 = 放大。步长跟着滚动量走，触控板上才不会一格一格地跳。
      setCellWidth(useLibrary.getState().settings.cellWidth - e.deltaY * 0.5);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setCellWidth]);
```

- [ ] **Step 6: 加样式**

`web/src/styles.css` 末尾追加：

```css
.zoom-slider { display: inline-flex; align-items: center; gap: 6px; }
.zoom-slider input[type="range"] { width: 110px; }
.zoom-slider-icon { opacity: .6; font-size: 12px; }
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run web/src/components/ZoomSlider.test.tsx web/src/components/TopBar.test.tsx web/src/components/Grid.test.ts`
Expected: PASS

- [ ] **Step 8: 三条门禁 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add web/src/components/ZoomSlider.tsx web/src/components/ZoomSlider.test.tsx \
        web/src/components/TopBar.tsx web/src/components/Grid.tsx \
        web/src/store/library.ts web/src/styles.css
git commit -m "feat: 网格缩放滑块 + ⌘/Ctrl 滚轮"
```

---

## 阶段 D：大图（Task 9–10）

> `web/src/components/Lightbox.tsx` **目前零测试**。Task 9 要先把测试文件建起来。

### Task 9: 大图连续缩放

**Files:**
- Create: `web/src/lib/lightboxZoom.ts`、`web/src/lib/lightboxZoom.test.ts`
- Modify: `web/src/components/Lightbox.tsx`、`web/src/styles.css`

**Interfaces:**
- Consumes: 无
- Produces:
  - `ZOOM_MIN = 0.5`、`ZOOM_MAX = 8`、`FIT = 1`
  - `clampScale(s: number): number`
  - `zoomAt(state, factor, pointer, viewport): { scale, pan }` —— 以指针为中心缩放，返回钳制后的新状态
  - `clampPan(pan, scale, viewport): { x, y }` —— 不让图片完全拖出视口

- [ ] **Step 1: 写失败的测试**

创建 `web/src/lib/lightboxZoom.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { clampScale, clampPan, zoomAt, ZOOM_MIN, ZOOM_MAX, FIT } from './lightboxZoom';

const viewport = { w: 1000, h: 800 };

describe('clampScale', () => {
  it('钳制在 0.5 到 8 之间', () => {
    expect(clampScale(0.1)).toBe(ZOOM_MIN);
    expect(clampScale(100)).toBe(ZOOM_MAX);
    expect(clampScale(2.5)).toBe(2.5);
  });

  it('非有限值回落到贴合', () => {
    expect(clampScale(NaN)).toBe(FIT);
    expect(clampScale(Infinity)).toBe(ZOOM_MAX);
  });
});

describe('clampPan', () => {
  it('贴合或更小时平移一律归零', () => {
    // 图片没有超出视口，平移没有任何意义；允许它反而会让图片飘走。
    expect(clampPan({ x: 300, y: 200 }, 1, viewport)).toEqual({ x: 0, y: 0 });
    expect(clampPan({ x: 300, y: 200 }, 0.6, viewport)).toEqual({ x: 0, y: 0 });
  });

  it('放大之后允许在溢出范围内平移', () => {
    // 2× 时图片是 2000×1600，溢出量各 500 / 400，所以平移上限就是这两个数。
    expect(clampPan({ x: 200, y: 100 }, 2, viewport)).toEqual({ x: 200, y: 100 });
  });

  it('超出溢出范围的平移被钳到边界，图片不会被完全拖出视口', () => {
    expect(clampPan({ x: 9999, y: -9999 }, 2, viewport)).toEqual({ x: 500, y: -400 });
  });
});

describe('zoomAt', () => {
  it('以视口正中为中心放大时不产生平移', () => {
    const next = zoomAt({ scale: 1, pan: { x: 0, y: 0 } }, 2, { x: 500, y: 400 }, viewport);
    expect(next.scale).toBe(2);
    expect(next.pan).toEqual({ x: 0, y: 0 });
  });

  it('以偏离中心的点放大时，那个点在屏幕上的位置保持不动', () => {
    // 这是"缩放中心跟随指针"的定义。做不到这一点的话，鼠标指着一张脸滚轮放大，
    // 放大出来的是别的地方，用户得再拖回来。
    const pointer = { x: 700, y: 400 };
    const next = zoomAt({ scale: 1, pan: { x: 0, y: 0 } }, 2, pointer, viewport);
    // 指针相对中心偏 +200；放大 2 倍后该点会跑到 +400，所以要往回补 -200。
    expect(next.pan.x).toBe(-200);
    expect(next.pan.y).toBe(0);
  });

  it('缩放回到贴合时平移一并归零', () => {
    const next = zoomAt({ scale: 2, pan: { x: 300, y: 200 } }, 0.5, { x: 500, y: 400 }, viewport);
    expect(next.scale).toBe(1);
    expect(next.pan).toEqual({ x: 0, y: 0 });
  });

  it('放大到上限之后再滚也不会越界', () => {
    const next = zoomAt({ scale: ZOOM_MAX, pan: { x: 0, y: 0 } }, 4, { x: 500, y: 400 }, viewport);
    expect(next.scale).toBe(ZOOM_MAX);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run web/src/lib/lightboxZoom.test.ts`
Expected: FAIL，`Failed to resolve import "./lightboxZoom"`

- [ ] **Step 3: 写实现**

创建 `web/src/lib/lightboxZoom.ts`：

```ts
/**
 * 大图的连续缩放（规格 §5.1）。
 *
 * 抽成纯函数是因为「缩放中心跟随指针」这条算得对不对，看渲染结果是看不出来的——
 * 它只在指针偏离画面中心时才和错误实现分道扬镳，而那正是最容易写错、
 * 也最容易被"看着差不多"放过去的一种。
 */

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 8;
/** 贴合视口。1 就是 CSS 里 `object-fit: contain` 的那一档。 */
export const FIT = 1;

export interface Pan { x: number; y: number }
export interface ZoomState { scale: number; pan: Pan }
export interface Viewport { w: number; h: number }

export function clampScale(s: number): number {
  if (!Number.isFinite(s)) return Number.isNaN(s) ? FIT : ZOOM_MAX;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s));
}

/**
 * 把平移钳在「图片还有一部分在视口里」的范围内。
 *
 * scale <= 1 时图片没有超出视口，平移没有任何意义——允许它只会让图片飘走，
 * 而用户没有任何参照能把它拖回来。
 */
export function clampPan(pan: Pan, scale: number, viewport: Viewport): Pan {
  if (scale <= FIT) return { x: 0, y: 0 };
  const overflowX = (viewport.w * scale - viewport.w) / 2;
  const overflowY = (viewport.h * scale - viewport.h) / 2;
  return {
    x: Math.min(overflowX, Math.max(-overflowX, pan.x)),
    y: Math.min(overflowY, Math.max(-overflowY, pan.y)),
  };
}

/**
 * 以 `pointer`（视口坐标）为中心，把当前状态缩放 `factor` 倍。
 *
 * 数学上就一句话：指针相对视口中心的偏移量，在缩放前后要落在屏幕上的同一点。
 * 记指针相对中心的偏移为 d，缩放前该点在图片坐标系里的位置是 (d - pan) / scale，
 * 缩放后要它仍然落在 d 上，于是 pan' = d - (d - pan) * (scale' / scale)。
 */
export function zoomAt(
  state: ZoomState, factor: number, pointer: Pan, viewport: Viewport,
): ZoomState {
  const scale = clampScale(state.scale * factor);
  const ratio = scale / state.scale;
  const dx = pointer.x - viewport.w / 2;
  const dy = pointer.y - viewport.h / 2;
  const pan = {
    x: dx - (dx - state.pan.x) * ratio,
    y: dy - (dy - state.pan.y) * ratio,
  };
  return { scale, pan: clampPan(pan, scale, viewport) };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run web/src/lib/lightboxZoom.test.ts`
Expected: PASS，10 个用例全绿

- [ ] **Step 5: 改 Lightbox**

`web/src/components/Lightbox.tsx` —— 把 `zoom: boolean` 换成一个 `{ scale, pan }` 的复合 state。

**scale 与 pan 必须放在同一个 state 里**，不能是两个 `useState`：它们要原子地一起变（`zoomAt` 的返回值就是一对），拆成两个会逼出 setState 套 setState 的写法，而那在 React 18+ 的批处理下行为是未定义的。

顶部 import 加：

```tsx
import { clampPan, zoomAt, FIT, type Pan } from '../lib/lightboxZoom';
```

state 那三行换成：

```tsx
  const [zoom, setZoom] = useState<{ scale: number; pan: Pan }>({ scale: FIT, pan: { x: 0, y: 0 } });
  const { scale, pan } = zoom;
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
```

换图归位那个 effect：

```tsx
  // 换图时归位
  useEffect(() => { setZoom({ scale: FIT, pan: { x: 0, y: 0 } }); }, [id]);
```

原来那个「退出 1:1 时也要归位」的 effect（第 34 行）**整个删掉**——`clampPan` 已经保证了 `scale <= 1` 时平移恒为 0，那条规则现在由纯函数兜住，不再需要一个靠副作用维持的不变量。

键盘处理里空格那一支改成在贴合与 1:1 之间切：

```tsx
      if (e.key === ' ') {
        e.preventDefault(); e.stopPropagation();
        setZoom((z) => ({ scale: z.scale === FIT ? 2 : FIT, pan: { x: 0, y: 0 } }));
      } else if (e.key === 'ArrowRight' && order[index + 1]) {
```

> 注：这里的「1:1」在实现上就是把 scale 抬到 2（原图比预览图清晰得多，2× 是肉眼开始看得出差别的那一档），并同时把 `src` 切到原图——见下面 `src` 的选择规则。

在 `if (!id || !asset) return null;` 上方加滚轮处理：

```tsx
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.002);   // 指数：每一格滚动的手感一致
      setZoom((z) => zoomAt(z, factor,
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
        { w: rect.width, h: rect.height }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [id]);
```

`src` 的选择规则：

```tsx
  // 放大到 1 以上才换原图。预览图在贴合状态下已经够用，而原图是整张 RAW 的
  // 全尺寸 JPG——每翻一张就拉一次的话，翻页会从"瞬间"变成"等一下"。
  const src = scale > FIT ? originalUrl(id) : thumbUrl(id, 'preview');
```

stage 那一段整个换掉：

```tsx
      <div ref={stageRef}
           className={scale > FIT ? 'lb-stage lb-zoom' : 'lb-stage'}
           onPointerDown={(e) => {
             if (scale <= FIT) return;
             dragRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
             (e.target as Element).setPointerCapture?.(e.pointerId);
           }}
           onPointerMove={(e) => {
             const start = dragRef.current;
             if (scale <= FIT || !start) return;
             const rect = stageRef.current?.getBoundingClientRect();
             if (!rect) return;
             setZoom((z) => ({
               scale: z.scale,
               pan: clampPan({ x: e.clientX - start.x, y: e.clientY - start.y },
                 z.scale, { w: rect.width, h: rect.height }),
             }));
           }}
           onPointerUp={() => { dragRef.current = null; }}
           onPointerCancel={() => { dragRef.current = null; }}
           onDoubleClick={() => setZoom((z) => ({
             scale: z.scale === FIT ? 2 : FIT, pan: { x: 0, y: 0 },
           }))}>
        <img src={src} alt={asset.stem} decoding="async" draggable={false}
             style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }} />
      </div>
```

**注意这里去掉了 stage 的 `onClick`。** 它和拖拽平移天然打架：拖完松手会触发一次 `click`，图片当场跳回贴合。点背景（stage 之外，也就是 `.lightbox` 本身）仍然关闭，那条不变。

底部提示文案跟着改：

```tsx
        <span className="muted">
          {scale > FIT
            ? `${scale.toFixed(1)}× — 拖拽平移，双击回到贴合`
            : '滚轮缩放 · 双击放大 · ←→ 翻页 · P 收藏 · X 排除 · Esc 退出'}
        </span>
```

- [ ] **Step 6: 加样式**

`web/src/styles.css` —— 找到 `.lb-stage img` 的规则，把 `transition` 去掉（如果有），并加上：

```css
/* 缩放中心由 transform 自己算，必须是几何中心；默认值就是 50% 50%，
   这里显式写出来是防止将来有人改 .lb-stage img 的 transform-origin
   而不知道 lightboxZoom.ts 的数学依赖它。 */
.lb-stage img { transform-origin: 50% 50%; will-change: transform; }
.lb-stage.lb-zoom { cursor: grab; }
.lb-stage.lb-zoom:active { cursor: grabbing; }
```

- [ ] **Step 7: 三条门禁 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add web/src/lib/lightboxZoom.ts web/src/lib/lightboxZoom.test.ts \
        web/src/components/Lightbox.tsx web/src/styles.css
git commit -m "feat: 大图连续缩放 0.5x-8x，缩放中心跟随指针"
```

---

### Task 10: 大图右上角关闭按钮

**Files:**
- Create: `web/src/components/Lightbox.test.tsx`
- Modify: `web/src/components/Lightbox.tsx`、`web/src/styles.css`

**Interfaces:**
- Consumes: Task 9 改造后的 Lightbox
- Produces: 无新接口

- [ ] **Step 1: 写失败的测试**

创建 `web/src/components/Lightbox.test.tsx`：

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { Lightbox } from './Lightbox';
import { useView } from '../store/view';
import { useMarks } from '../store/marks';
import type { Asset } from '../types';

const asset: Asset = {
  id: 'cam-a/IMG_1', dir: 'cam-a', stem: 'IMG_1',
  raws: ['IMG_1.CR2'], jpg: 'IMG_1.JPG', jpgSize: 1, jpgMtimeMs: 1,
};
const byId = new Map([[asset.id, asset]]);
const order = [asset.id];

beforeEach(() => {
  useView.setState({ lightbox: asset.id });
  useMarks.setState({ marks: {}, marksMeta: {} });
});

describe('Lightbox 关闭按钮', () => {
  it('右上角有一个带 aria-label 的关闭按钮', () => {
    const { getByLabelText } = render(<Lightbox order={order} byId={byId} />);
    expect(getByLabelText('关闭')).toBeTruthy();
  });

  it('点它就关掉大图', () => {
    const { getByLabelText } = render(<Lightbox order={order} byId={byId} />);
    fireEvent.click(getByLabelText('关闭'));
    expect(useView.getState().lightbox).toBeNull();
  });

  it('底部信息条里那个「关闭」已经不在了', () => {
    // 两个关闭按钮是冗余，而右上角是所有人看图时找关闭的第一个地方。
    const { queryByText } = render(<Lightbox order={order} byId={byId} />);
    expect(queryByText('关闭')).toBeNull();   // 文本形式的那个按钮
  });

  it('lightbox 为空时什么都不渲染', () => {
    useView.setState({ lightbox: null });
    const { container } = render(<Lightbox order={order} byId={byId} />);
    expect(container.firstChild).toBeNull();
  });
});
```

> `queryByText('关闭')` 与 `getByLabelText('关闭')` 不冲突：新按钮的可见内容是 `✕`，「关闭」只出现在 `aria-label` 里；`getByText` 只看渲染出来的文本节点。

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run web/src/components/Lightbox.test.tsx`
Expected: FAIL —— `Unable to find a label with the text of: 关闭`

- [ ] **Step 3: 改 Lightbox**

在 `return (` 之后、`<div className="lb-stage">` 之前插入按钮：

```tsx
      {/* 右上角关闭。半透明深色圆底 + 白 ✕，默认 opacity .5，hover/focus 才升到 1——
          深色半透明在亮图和暗图上都读得出来，也不会像纯白或纯色块那样在画面上
          砸一个洞。这是需求原话「按钮颜色最好不要影响图片查看」的落点。 */}
      <button type="button" className="lb-close" aria-label="关闭"
              onClick={closeLightbox}>✕</button>
```

删掉底部信息条里的 `<button onClick={closeLightbox}>关闭</button>`（原第 96 行）。

- [ ] **Step 4: 加样式**

`web/src/styles.css` 末尾追加：

```css
.lb-close {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 3;
  width: 40px;
  height: 40px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, .45);
  backdrop-filter: blur(6px);
  color: #fff;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  opacity: .5;
  transition: opacity .15s ease;
}
.lb-close:hover,
.lb-close:focus-visible { opacity: 1; }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run web/src/components/Lightbox.test.tsx`
Expected: PASS，4 个用例全绿

- [ ] **Step 6: 三条门禁 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add web/src/components/Lightbox.tsx web/src/components/Lightbox.test.tsx web/src/styles.css
git commit -m "feat: 大图右上角关闭按钮，半透明深色不砸洞"
```

---

## 阶段 E：刷新（Task 11–12）

### Task 11: 服务端原地重扫

**Files:**
- Modify: `server/lib/session.js`（抽出 `startPostScan`，新增 `rescanSession`）、`server/routes/library.js`
- Test: `server/lib/session.test.js`（追加）、`server/routes/library.test.js`（追加）

**Interfaces:**
- Consumes: 无
- Produces:
  - `rescanSession(session): Promise<{ removed: number; added: number }>` —— 成功时 resolve，扫描失败时 reject 且**不动旧资产表**
  - `POST /api/library/refresh` —— admin-only，回 `{ ok: true, removed, added }`
  - 新的 SSE 事件 `{ type: 'rescan', removed, added, done: true }` 或 `{ type: 'rescan', error, done: true }`

- [ ] **Step 1: 写失败的测试**

在 `server/lib/session.test.js` 末尾追加：

```js
import { rescanSession } from './session.js';

describe('rescanSession', () => {
  it('磁盘上多了照片，重扫之后资产表跟着变', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rescan-'));
    await fs.writeFile(path.join(root, 'IMG_1.JPG'), 'x');
    const session = await openSession(root);
    expect(session.assets).toHaveLength(1);

    await fs.writeFile(path.join(root, 'IMG_2.JPG'), 'x');
    const result = await rescanSession(session);

    expect(result).toEqual({ removed: 0, added: 1 });
    expect(session.assets).toHaveLength(2);
    expect(session.byId.size).toBe(2);
    await closeSession(session.id);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('磁盘上少了照片，重扫之后从资产表里去掉', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rescan-'));
    await fs.writeFile(path.join(root, 'IMG_1.JPG'), 'x');
    await fs.writeFile(path.join(root, 'IMG_2.JPG'), 'x');
    const session = await openSession(root);

    await fs.rm(path.join(root, 'IMG_2.JPG'));
    const result = await rescanSession(session);

    expect(result).toEqual({ removed: 1, added: 0 });
    expect(session.assets).toHaveLength(1);
    await closeSession(session.id);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('消失的照片的标记留在 markStore 里，不被清掉', async () => {
    // 文件可能只是被临时移走。清掉标记的话，它明天回来时选片进度就没了。
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rescan-'));
    await fs.writeFile(path.join(root, 'IMG_1.JPG'), 'x');
    const session = await openSession(root);
    const id = session.assets[0].id;
    session.markStore.setMark(id, 'pick', { by: 'admin', at: 1 });

    await fs.rm(path.join(root, 'IMG_1.JPG'));
    await rescanSession(session);

    expect(session.assets).toHaveLength(0);
    expect(session.markStore.data.marks[id]).toBe('pick');
    await closeSession(session.id);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('扫描失败时保留旧资产表，会话不被销毁', async () => {
    // 这和开库失败退回选择器**不一样**：那时手上没有任何可用数据，
    // 退回去是唯一选择；这里已经有一份能用的，清掉它是纯损失。
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rescan-'));
    await fs.writeFile(path.join(root, 'IMG_1.JPG'), 'x');
    const session = await openSession(root);
    const before = session.assets;

    await fs.rm(root, { recursive: true, force: true });   // 整个文件夹没了
    await expect(rescanSession(session)).rejects.toThrow();

    expect(session.assets).toBe(before);        // 引用都没换
    expect(session.aborted).toBe(false);
    expect(getSession(session.id)).toBe(session);
    await closeSession(session.id);
  });

  it('并发两次刷新合并成一趟扫描', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rescan-'));
    await fs.writeFile(path.join(root, 'IMG_1.JPG'), 'x');
    const session = await openSession(root);

    const [a, b] = await Promise.all([rescanSession(session), rescanSession(session)]);
    expect(a).toEqual(b);

    await closeSession(session.id);
    await fs.rm(root, { recursive: true, force: true });
  });
});
```

在 `server/routes/library.test.js` 末尾追加：

```js
describe('POST /api/library/refresh', () => {
  it('管理员能刷新', async () => {
    // 具体的 app / session 搭建照抄本文件里 POST /api/library/close 那几条用例的写法。
    const res = await adminPost('/api/library/refresh');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(typeof res.body.removed).toBe('number');
    expect(typeof res.body.added).toBe('number');
  });

  it('访客不能刷新', async () => {
    // 刷新会重置所有人的视图，一个客户的手滑不该有这个权力。
    const res = await guestPost('/api/library/refresh');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('admin-only');
  });
});
```

> `adminPost` / `guestPost` 是本文件已有的辅助函数名，照抄该文件里既有用例的调用方式；名字不一致就用它实际用的那个。

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run server/lib/session.test.js -t "rescanSession"`
Expected: FAIL，`rescanSession is not a function`

- [ ] **Step 3: 抽出 `startPostScan`**

`server/lib/session.js` —— 把 `runScan` 里「扫描成功之后」那一段（读元数据 + 起烤箱）抽成独立函数，放在 `runScan` 上方：

```js
/**
 * 扫描落定之后才做得了的两件事：读元数据、起烤箱。
 *
 * 抽出来是因为 rescanSession 要原样再做一遍——两处各写各的，迟早会分叉成
 * 「刷新之后新照片没有 EXIF 时间，于是全被 groupBursts 拒绝分组」这种
 * 只有在真实素材上才看得见的差异。
 */
function startPostScan(session) {
  readAllMeta(session.root, session.assets, {
    onBatch(batch) {
      if (session.aborted) return;
      for (const m of batch) session.metas.set(m.id, m);
      emit(session, { type: 'meta', metas: batch });
    },
  }).catch((err) => {
    console.error('[meta] 读取失败', err);
  }).finally(() => {
    if (session.aborted) return;
    session.metaDone = true;
    emit(session, { type: 'metaDone' });
  });

  // 动态 import 打破 bake.js ↔ session.js 的循环依赖
  return import('./bake.js').then(({ startBake }) => {
    if (!session.aborted) startBake(session);
  });
}
```

`runScan` 里对应的那一段（从 `readAllMeta(root, assets, {` 到 `if (!session.aborted) startBake(session);`）替换成：

```js
    await startPostScan(session);
```

- [ ] **Step 4: 写 `rescanSession`**

在 `openSession` 下方追加：

```js
/**
 * 原地重扫一个已经开着的会话（规格 §4.2）。
 *
 * 与 `runScan` 的关键区别是**失败处理**：runScan 失败会销毁整个会话（那时
 * 手上没有任何可用数据），而这里失败只是抛出去、旧资产表一个字段都不动——
 * 已经有一份能用的数据，清掉它是纯损失。
 *
 * 并发调用合并成一趟：摄影师连点两下刷新，或者点了之后网络慢又点一次，
 * 不该在同一个文件夹上并行跑两遍扫描。
 */
export async function rescanSession(session) {
  if (session.rescan) return session.rescan;

  session.rescan = (async () => {
    const before = new Set(session.assets.map((a) => a.id));
    try {
      const { assets, warnings, skippedFiles } = await scanFolder(session.root, {
        onBatch(found) {
          if (session.aborted) return;
          // 复用 scan 事件：前端已经有一条渲染扫描进度的路径，
          // 再造一个只在刷新时用的进度事件等于让那段代码有两个来源。
          emit(session, { type: 'scan', found, done: false });
        },
      });
      if (session.aborted) return { removed: 0, added: 0 };

      const after = new Set(assets.map((a) => a.id));
      let removed = 0;
      for (const id of before) if (!after.has(id)) removed++;
      let added = 0;
      for (const id of after) if (!before.has(id)) added++;

      session.assets = assets;
      session.warnings = warnings;
      session.skippedFiles = skippedFiles;
      session.byId = new Map(assets.map((a) => [a.id, a]));
      session.bake = { done: 0, total: assets.filter((a) => a.jpg).length, running: false };
      session.metaDone = false;
      // metas 刻意**不清空**：已经读出来的 EXIF 不会因为重扫而失效，
      // 清掉只会让三千张照片的元数据白读一遍。消失资产的条目留着无害。
      session.scan = { found: session.scan.found, done: true, error: null };

      emit(session, { type: 'rescan', removed, added, done: true });
      await startPostScan(session);
      return { removed, added };
    } catch (err) {
      console.error('[rescan] 重扫失败', err);
      // 规格 §4.2：保留旧资产表，只报告失败。不 abort、不断连接、不注销会话。
      emit(session, { type: 'rescan', error: scanErrorMessage(err), done: true });
      throw err;
    }
  })().finally(() => { session.rescan = null; });

  return session.rescan;
}
```

在 `createSession` 里给 session 对象补一个字段声明（放在 `aborted: false,` 旁边）：

```js
    /** 正在进行的重扫。并发调用合并到同一个 promise 上。 */
    rescan: null,
```

- [ ] **Step 5: 加路由**

`server/routes/library.js` —— 在 `POST /close` 之后加：

```js
/**
 * 原地重扫当前文件夹（规格 §4.2）。
 *
 * **admin-only。** 刷新会替换所有人正在看的那份资产表，一个客户的手滑
 * 不该有这个权力——和导出、开关库同一档。
 */
libraryRouter.post('/refresh', requireAdmin, requireLiveSession, async (req, res, next) => {
  try {
    const { removed, added } = await rescanSession(req.session);
    res.json({ ok: true, removed, added });
  } catch (err) {
    // 扫描失败对客户端是一条要显示的提示，不是一个 500。旧资产表还在，
    // 界面留在原处即可——脱敏后的原因已经通过 SSE 的 rescan 事件发过一遍了。
    res.status(503).json({ error: 'rescan-failed', message: scanErrorMessage(err) });
  }
});
```

`library.js` 顶部 import 里加上 `rescanSession`；`scanErrorMessage` 目前是 `session.js` 的模块私有函数，把它 `export` 出来并在这里 import。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run server/lib/session.test.js server/routes/library.test.js`
Expected: PASS

- [ ] **Step 7: 三条门禁 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add server/lib/session.js server/lib/session.test.js \
        server/routes/library.js server/routes/library.test.js
git commit -m "feat: 原地重扫 —— 扫描失败时保留旧资产表，不退回选择器"
```

---

### Task 12: 前端刷新按钮

**Files:**
- Modify: `web/src/store/library.ts`、`web/src/components/TopBar.tsx`、`web/src/store/view.ts`
- Test: `web/src/store/library.test.ts`（追加）

**Interfaces:**
- Consumes: Task 11 的 `POST /api/library/refresh` 与 `rescan` SSE 事件
- Produces:
  - `useLibrary.refresh(): Promise<void>`
  - `useLibrary.refreshing: boolean`
  - `useLibrary.refreshResult: { removed: number; added: number } | null`
  - `useView.pruneMissing(ids: Set<string>): void` —— 把 cursor / lightbox / selection 里已经不在 ids 里的成员清掉

- [ ] **Step 1: 写失败的测试**

在 `web/src/store/library.test.ts` 末尾追加：

```ts
describe('refresh', () => {
  it('刷新成功后资产表被替换，refreshResult 记下增减', async () => {
    // fetch 的 stub 方式照抄本文件已有用例。
    stubJSON('/api/library/refresh', { ok: true, removed: 2, added: 1 });
    stubJSON('/api/library/assets', { assets: [asset('IMG_9')], warnings: [], skippedFiles: 0 });

    await useLibrary.getState().refresh();

    expect(useLibrary.getState().assets.map((a) => a.id)).toEqual(['IMG_9']);
    expect(useLibrary.getState().refreshResult).toEqual({ removed: 2, added: 1 });
    expect(useLibrary.getState().refreshing).toBe(false);
  });

  it('刷新失败时资产表原样不动，只留一条错误', async () => {
    useLibrary.setState({ assets: [asset('IMG_1')] });
    stubError('/api/library/refresh', 503, { error: 'rescan-failed', message: '扫描文件夹时出错（ENOENT），请重试' });

    await useLibrary.getState().refresh();

    expect(useLibrary.getState().assets.map((a) => a.id)).toEqual(['IMG_1']);
    expect(useLibrary.getState().error).toContain('扫描文件夹时出错');
    expect(useLibrary.getState().refreshing).toBe(false);
  });

  it('刷新掉的资产不再被 cursor / lightbox / selection 指着', async () => {
    // 悬空指针：order.indexOf(cursor) 会静默拿到 -1，键盘导航跳回列表开头，
    // 而大图会停在一张磁盘上已经不存在的照片上。
    useView.setState({
      cursor: 'IMG_1', lightbox: 'IMG_1', selection: new Set(['IMG_1', 'IMG_9']),
    });
    stubJSON('/api/library/refresh', { ok: true, removed: 1, added: 0 });
    stubJSON('/api/library/assets', { assets: [asset('IMG_9')], warnings: [], skippedFiles: 0 });

    await useLibrary.getState().refresh();

    expect(useView.getState().cursor).toBeNull();
    expect(useView.getState().lightbox).toBeNull();
    expect([...useView.getState().selection]).toEqual(['IMG_9']);
  });
});
```

> `stubJSON` / `stubError` / `asset` 是本文件已有的辅助函数名；名字不一致就用它实际用的那个。

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run web/src/store/library.test.ts -t "refresh"`
Expected: FAIL，`refresh is not a function`

- [ ] **Step 3: 在 view store 里加 `pruneMissing`**

`web/src/store/view.ts` —— 接口里加：

```ts
  /**
   * 把 cursor / lightbox / selection 里已经不在 `ids` 中的成员清掉。
   *
   * 刷新之后必须调一次。和 setTab / setDirFilter 清空 cursor 是同一类问题
   * （见那两个 setter 的注释），只是这里的资产是**真的从磁盘上没了**，
   * 而不是暂时被筛掉——留着一个指向不存在文件的 cursor，下一次 P/X
   * 会往服务端发一个必然 400「未知资产」的请求。
   */
  pruneMissing: (ids: Set<string>) => void;
```

实现（放在 `clearSelection` 旁边）：

```ts
  pruneMissing: (ids) => set((s) => {
    const selection = new Set([...s.selection].filter((id) => ids.has(id)));
    return {
      cursor: s.cursor && ids.has(s.cursor) ? s.cursor : null,
      anchor: s.anchor && ids.has(s.anchor) ? s.anchor : null,
      lightbox: s.lightbox && ids.has(s.lightbox) ? s.lightbox : null,
      selection,
    };
  }),
```

- [ ] **Step 4: 在 library store 里加 `refresh`**

`web/src/store/library.ts` —— `LibraryState` 接口里加三项：

```ts
  /** 正在重扫。按钮据此禁用并显示进度。 */
  refreshing: boolean;
  /** 上一次刷新的增减。null = 还没刷新过，或者已经被用户关掉提示。 */
  refreshResult: { removed: number; added: number } | null;
  /** 原地重扫当前文件夹。失败不清空任何东西，只留一条 error。 */
  refresh: () => Promise<void>;
  /** 关掉「N 张已不在磁盘上」那条提示。 */
  dismissRefreshResult: () => void;
```

`EMPTY_LIBRARY` 里加：

```ts
  refreshing: false,
  refreshResult: null as LibraryState['refreshResult'],
```

实现（放在 `dismissCloseBlock` 之后）：

```ts
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
```

SSE 那一段（`stopStream = openStream(...)` 的回调里）在 `else if (event.type === 'meta')` 之前插入一支：

```ts
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
```

- [ ] **Step 5: 加按钮**

`web/src/components/TopBar.tsx` —— 订阅新字段：

```tsx
  const refresh = useLibrary((s) => s.refresh);
  const refreshing = useLibrary((s) => s.refreshing);
  const refreshResult = useLibrary((s) => s.refreshResult);
  const dismissRefreshResult = useLibrary((s) => s.dismissRefreshResult);
```

在「← 换文件夹」按钮之后加：

```tsx
      {/* 刷新不退回选择器：旧网格继续显示到扫完。这是它和「换文件夹」
          最重要的区别，也是「选片过程中照片被移动或删除」这个场景要的东西。 */}
      <button onClick={() => void refresh()} disabled={refreshing}
              title="重新扫描这个文件夹。选片进度不会丢">
        {refreshing ? '正在刷新…' : '刷新'}
      </button>
```

在 `{streamError && ...}` 之后加结果提示：

```tsx
      {refreshResult && (refreshResult.removed > 0 || refreshResult.added > 0) && (
        <button className="refresh-result" onClick={dismissRefreshResult}
                title="点一下关掉这条提示">
          {refreshResult.removed > 0 && `${refreshResult.removed} 张已不在磁盘上`}
          {refreshResult.removed > 0 && refreshResult.added > 0 && ' · '}
          {refreshResult.added > 0 && `新增 ${refreshResult.added} 张`}
        </button>
      )}
```

`web/src/styles.css` 追加：

```css
.refresh-result {
  border: none;
  background: rgba(120, 180, 255, .18);
  color: inherit;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run web/src/store/library.test.ts web/src/store/view.test.ts web/src/components/TopBar.test.tsx`
Expected: PASS

- [ ] **Step 7: 三条门禁 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add web/src/store/library.ts web/src/store/library.test.ts web/src/store/view.ts \
        web/src/components/TopBar.tsx web/src/styles.css
git commit -m "feat: 顶栏刷新按钮 —— 原地重扫，清掉指向消失照片的悬空指针"
```

---

## 阶段 F：数据模型（Task 13–14）

### Task 13: 贡献表的纯函数

**Files:**
- Create: `server/lib/contrib.js`、`server/lib/contrib.test.js`

**Interfaces:**
- Consumes: 无
- Produces（全部是纯函数，不读盘、不产生副作用）：
  - `evaluate(entry): { by: string; mark: 'pick'|'reject'; at: number } | null`
  - `setContribution(entry, by, mark, at): object | null` —— 返回新的 entry（`null` = 这张照片已经没有任何人碰过）
  - `backfill(marks, marksMeta): Record<string, object>`
  - `visibleMark(entry, userId): 'pick' | 'reject' | null`
  - `sanitizeContrib(field): Record<string, object>`

- [ ] **Step 1: 写失败的测试**

创建 `server/lib/contrib.test.js`：

```js
import { describe, it, expect } from 'vitest';
import { evaluate, setContribution, backfill, visibleMark, sanitizeContrib } from './contrib.js';

describe('evaluate', () => {
  it('at 最大的那条赢', () => {
    expect(evaluate({
      u_ab: { mark: 'pick', at: 1234 },
      admin: { mark: 'reject', at: 1240 },
    })).toEqual({ by: 'admin', mark: 'reject', at: 1240 });
  });

  it('只有一个人时就是他', () => {
    expect(evaluate({ u_ab: { mark: 'pick', at: 1 } })).toEqual({ by: 'u_ab', mark: 'pick', at: 1 });
  });

  it('空表或缺失返回 null', () => {
    expect(evaluate({})).toBeNull();
    expect(evaluate(undefined)).toBeNull();
    expect(evaluate(null)).toBeNull();
  });

  it('at 相同时按 userId 字典序取大的，保证结果确定', () => {
    // 同一毫秒内两个人各写一次是可能的。没有这条平局规则，
    // 同一份 contrib 在不同的 Object.entries 顺序下会求出两个不同的答案。
    const entry = { u_aa: { mark: 'pick', at: 5 }, u_bb: { mark: 'reject', at: 5 } };
    expect(evaluate(entry).by).toBe('u_bb');
    expect(evaluate({ u_bb: entry.u_bb, u_aa: entry.u_aa }).by).toBe('u_bb');
  });
});

describe('setContribution', () => {
  it('写入一票', () => {
    expect(setContribution(undefined, 'u_ab', 'pick', 100))
      .toEqual({ u_ab: { mark: 'pick', at: 100 } });
  });

  it('同一个人再写一次是覆盖，不是追加', () => {
    // 每人每张只留最后一次。留完整历史对「她收藏了哪些」毫无帮助，
    // 只会让文件随着选片时长无限增长。
    const entry = setContribution({ u_ab: { mark: 'pick', at: 100 } }, 'u_ab', 'reject', 200);
    expect(entry).toEqual({ u_ab: { mark: 'reject', at: 200 } });
  });

  it('取消标记是删掉这个人的条目', () => {
    const entry = setContribution(
      { u_ab: { mark: 'pick', at: 100 }, admin: { mark: 'pick', at: 50 } },
      'u_ab', null, 200,
    );
    expect(entry).toEqual({ admin: { mark: 'pick', at: 50 } });
  });

  it('最后一个人也取消之后整条返回 null', () => {
    expect(setContribution({ u_ab: { mark: 'pick', at: 100 } }, 'u_ab', null, 200)).toBeNull();
  });

  it('不修改传进来的那个对象', () => {
    const entry = { u_ab: { mark: 'pick', at: 100 } };
    setContribution(entry, 'admin', 'reject', 200);
    expect(entry).toEqual({ u_ab: { mark: 'pick', at: 100 } });
  });

  it('取消之后有效标记回退到上一个人那一票', () => {
    // 这是整套设计里唯一改变现有行为的地方，也是它存在的理由：
    // 现在新娘把摄影师收藏的一张改成排除、再自己取消，摄影师那一票就永久消失了。
    let entry = setContribution(undefined, 'admin', 'pick', 100);
    entry = setContribution(entry, 'u_ab', 'reject', 200);
    expect(evaluate(entry).mark).toBe('reject');

    entry = setContribution(entry, 'u_ab', null, 300);
    expect(evaluate(entry)).toEqual({ by: 'admin', mark: 'pick', at: 100 });
  });
});

describe('backfill', () => {
  it('有归属的按归属回填', () => {
    expect(backfill({ a: 'pick' }, { a: { by: 'u_ab', at: 777 } }))
      .toEqual({ a: { u_ab: { mark: 'pick', at: 777 } } });
  });

  it('没归属的算 admin，时间戳用 0', () => {
    // 那些文件夹是单机选的，标记本来就是摄影师自己按的。
    // at = 0 让任何后来的改动都赢过它，这正是我们想要的。
    expect(backfill({ a: 'pick' }, {})).toEqual({ a: { admin: { mark: 'pick', at: 0 } } });
    expect(backfill({ a: 'reject' }, undefined)).toEqual({ a: { admin: { mark: 'reject', at: 0 } } });
  });

  it('归属字段坏掉时退化成 admin，不抛', () => {
    expect(backfill({ a: 'pick' }, { a: { by: '', at: 'x' } }))
      .toEqual({ a: { admin: { mark: 'pick', at: 0 } } });
  });

  it('没有标记就没有贡献', () => {
    expect(backfill({}, {})).toEqual({});
  });
});

describe('visibleMark', () => {
  const entry = { u_ab: { mark: 'pick', at: 1 }, u_cd: { mark: 'reject', at: 9 }, admin: { mark: 'reject', at: 2 } };

  it('自己的优先于摄影师的', () => {
    // 她改过的那一张，界面上要显示成她改过的样子。
    expect(visibleMark(entry, 'u_ab')).toBe('pick');
  });

  it('自己没碰过时看摄影师的', () => {
    expect(visibleMark(entry, 'u_zz')).toBe('reject');
  });

  it('别的客户那一票一律看不见', () => {
    // u_cd 的 at 最大（有效标记是他的 reject），但对 u_ab 来说不存在。
    expect(visibleMark({ u_cd: { mark: 'pick', at: 9 } }, 'u_ab')).toBeNull();
  });

  it('空表返回 null', () => {
    expect(visibleMark(undefined, 'u_ab')).toBeNull();
    expect(visibleMark({}, 'u_ab')).toBeNull();
  });
});

describe('sanitizeContrib', () => {
  it('放行形状完整的条目', () => {
    const clean = sanitizeContrib({ a: { u_ab: { mark: 'pick', at: 1 } } });
    expect(clean).toEqual({ a: { u_ab: { mark: 'pick', at: 1 } } });
  });

  it('非法标记值、非数字时间戳、空 userId 一律丢弃', () => {
    expect(sanitizeContrib({
      a: { u_ab: { mark: 'maybe', at: 1 } },
      b: { u_ab: { mark: 'pick', at: 'x' } },
      c: { '': { mark: 'pick', at: 1 } },
    })).toEqual({});
  });

  it('字段坏成任何别的形状都退化成空表，不抛', () => {
    // 升级不该让摄影师昨天的选片打不开。
    expect(sanitizeContrib(undefined)).toEqual({});
    expect(sanitizeContrib(null)).toEqual({});
    expect(sanitizeContrib([1, 2, 3])).toEqual({});
    expect(sanitizeContrib('随便什么')).toEqual({});
    expect(sanitizeContrib({ a: 'not-an-object' })).toEqual({});
  });

  it('一张照片里只有部分条目坏掉时，保留好的那些', () => {
    expect(sanitizeContrib({
      a: { u_ok: { mark: 'pick', at: 1 }, u_bad: { mark: 'nope', at: 2 } },
    })).toEqual({ a: { u_ok: { mark: 'pick', at: 1 } } });
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run server/lib/contrib.test.js`
Expected: FAIL，`Failed to resolve import "./contrib.js"`

- [ ] **Step 3: 写实现**

创建 `server/lib/contrib.js`：

```js
/**
 * 贡献表（规格 §1.2–1.4）。
 *
 * 形状是 `{ [assetId]: { [userId]: { mark, at } } }`，**每人每张只留最后一次**。
 * 完整历史在审计日志里，那才是它该待的地方；留在这里只会让文件随着选片
 * 时长无限增长，而且对「她收藏了哪些」这个唯一要回答的问题毫无帮助。
 *
 * 有效标记（`marks`）从这张表求得：`at` 最大的那条赢。标记时结果和改造前
 * 一模一样（后写的 at 最大）；**取消时会回退到上一个人那一票**——那是这套
 * 设计唯一改变的现有行为，也是它存在的理由。
 *
 * 全部是纯函数：不读盘、不产生副作用、时间由调用方注入。
 */

const VALID_MARKS = new Set(['pick', 'reject']);

function isPlainObject(obj) {
  return obj !== null && typeof obj === 'object' && Object.getPrototypeOf(obj) === Object.prototype;
}

/**
 * 求有效标记。
 *
 * 平局（同一毫秒内两个人各写一次）按 userId 字典序取大的。没有这条规则，
 * 同一份 contrib 在不同的 `Object.entries` 顺序下会求出两个不同的答案，
 * 而那个顺序取决于 JSON 的字段书写次序——一个谁也不会去核对的隐式依赖。
 */
export function evaluate(entry) {
  if (!isPlainObject(entry)) return null;
  let best = null;
  for (const [by, v] of Object.entries(entry)) {
    if (!isPlainObject(v)) continue;
    if (best === null || v.at > best.at || (v.at === best.at && by > best.by)) {
      best = { by, mark: v.mark, at: v.at };
    }
  }
  return best;
}

/**
 * 写入一票，返回**新的** entry（不改传进来的那个）。
 * `mark` 为 null 表示取消——删掉这个人的条目，而不是写 `{mark: null}`：
 * 筛选器只有「收藏 / 排除 / 未标记」三个值可筛，null 筛不出来，
 * 而「她取消了」和「她没碰过」对这三个值来说是同一件事。
 *
 * 整条空了返回 null，调用方据此把这个 assetId 整个从表里删掉。
 */
export function setContribution(entry, by, mark, at) {
  const next = isPlainObject(entry) ? { ...entry } : {};
  if (mark === null || mark === undefined) delete next[by];
  else next[by] = { mark, at };
  return Object.keys(next).length === 0 ? null : next;
}

/**
 * 旧文件回填（规格 §1.4）。
 *
 * 没归属的算 `admin`——那些文件夹是单机选的，标记本来就是摄影师自己按的。
 * `at` 缺失时用 0：任何后来的改动都会赢过它。
 */
export function backfill(marks, marksMeta) {
  const contrib = {};
  const meta = isPlainObject(marksMeta) ? marksMeta : {};
  for (const [id, mark] of Object.entries(marks ?? {})) {
    if (!VALID_MARKS.has(mark)) continue;
    const m = isPlainObject(meta[id]) ? meta[id] : {};
    const by = typeof m.by === 'string' && m.by !== '' ? m.by : 'admin';
    const at = typeof m.at === 'number' && Number.isFinite(m.at) ? m.at : 0;
    contrib[id] = { [by]: { mark, at } };
  }
  return contrib;
}

/**
 * `showPeerMarks: false` 时，访客 `userId` 看到的标记（规格 §2.1）。
 * 自己的优先于摄影师的；别的客户那一票一律看不见。
 */
export function visibleMark(entry, userId) {
  if (!isPlainObject(entry)) return null;
  const mine = entry[userId];
  if (isPlainObject(mine)) return mine.mark;
  const admin = entry.admin;
  if (isPlainObject(admin)) return admin.mark;
  return null;
}

/**
 * 读取时的归一。**任何形状的坏数据都只退化成"少一些条目"，绝不抛**——
 * 升级不该让摄影师昨天的选片打不开（与 store.js 的 sanitizeMarksMeta 同一条规矩）。
 */
export function sanitizeContrib(field) {
  const clean = {};
  if (!isPlainObject(field)) return clean;
  for (const [id, entry] of Object.entries(field)) {
    if (!isPlainObject(entry)) continue;
    const kept = {};
    for (const [by, v] of Object.entries(entry)) {
      if (by === '' || !isPlainObject(v)) continue;
      if (!VALID_MARKS.has(v.mark)) continue;
      if (typeof v.at !== 'number' || !Number.isFinite(v.at)) continue;
      kept[by] = { mark: v.mark, at: v.at };
    }
    if (Object.keys(kept).length > 0) clean[id] = kept;
  }
  return clean;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/lib/contrib.test.js`
Expected: PASS，24 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add server/lib/contrib.js server/lib/contrib.test.js
git commit -m "feat: 贡献表的纯函数 —— 求值、回填、按人可见性"
```

---

### Task 14: store.js 接入 contrib 与 hidden

**Files:**
- Modify: `server/lib/store.js`
- Test: `server/lib/store.test.js`（追加）

**Interfaces:**
- Consumes: Task 13 的 `evaluate` / `setContribution` / `backfill` / `sanitizeContrib`
- Produces:
  - `readMarksFile` / `writeMarksFile` 处理的数据形状多两个字段：`hidden: string[]`、`contrib: object`
  - `markStore.setMark(id, mark, { by, at })` —— **行为改变**：改写 contrib，`marks` / `marksMeta` 从 contrib 求得
  - `markStore.setHidden(ids: string[], hidden: boolean): { hidden: string[]; skipped: string[] }`
  - `sanitizeHidden(field, marks): string[]`（导出，供测试直接验证）

- [ ] **Step 1: 写失败的测试**

在 `server/lib/store.test.js` 末尾追加：

```js
import { sanitizeHidden } from './store.js';

describe('sanitizeHidden', () => {
  it('放行未标记的 id', () => {
    expect(sanitizeHidden(['a', 'b'], {})).toEqual(['a', 'b']);
  });

  it('已标记的从 hidden 里剔除（不变量在读取层也兜一道）', () => {
    // 不变量不能只靠写入层挡——那假设了所有写入都经过我们的代码。
    // 脏数据、并发、手改文件都会造出「已标记 ∧ 已隐藏」这个非法状态。
    expect(sanitizeHidden(['a', 'b'], { a: 'pick' })).toEqual(['b']);
  });

  it('去重', () => {
    expect(sanitizeHidden(['a', 'a', 'b'], {})).toEqual(['a', 'b']);
  });

  it('非数组、非字符串元素一律丢弃，不抛', () => {
    expect(sanitizeHidden(undefined, {})).toEqual([]);
    expect(sanitizeHidden({ a: true }, {})).toEqual([]);
    expect(sanitizeHidden(['a', 1, null, '', 'b'], {})).toEqual(['a', 'b']);
  });
});

describe('marks 从 contrib 求得', () => {
  it('写标记时 marks 与 marksMeta 跟着更新', async () => {
    const store = await createMarkStore(tmp);
    store.setMark('a', 'pick', { by: 'u_ab', at: 100 });
    expect(store.data.marks.a).toBe('pick');
    expect(store.data.marksMeta.a).toEqual({ by: 'u_ab', at: 100 });
    expect(store.data.contrib.a).toEqual({ u_ab: { mark: 'pick', at: 100 } });
    await store.close();
  });

  it('后写的赢，和改造前的行为一模一样', async () => {
    const store = await createMarkStore(tmp);
    store.setMark('a', 'pick', { by: 'u_ab', at: 100 });
    store.setMark('a', 'reject', { by: 'admin', at: 200 });
    expect(store.data.marks.a).toBe('reject');
    expect(store.data.marksMeta.a).toEqual({ by: 'admin', at: 200 });
    await store.close();
  });

  it('取消时回退到上一个人那一票', async () => {
    // 改造前：新娘把摄影师收藏的一张改成排除、再自己取消，摄影师那一票就永久消失了。
    const store = await createMarkStore(tmp);
    store.setMark('a', 'pick', { by: 'admin', at: 100 });
    store.setMark('a', 'reject', { by: 'u_ab', at: 200 });
    store.setMark('a', null, { by: 'u_ab', at: 300 });

    expect(store.data.marks.a).toBe('pick');
    expect(store.data.marksMeta.a).toEqual({ by: 'admin', at: 100 });
    await store.close();
  });

  it('所有人都取消之后标记和归属一起消失', async () => {
    const store = await createMarkStore(tmp);
    store.setMark('a', 'pick', { by: 'admin', at: 100 });
    store.setMark('a', null, { by: 'admin', at: 200 });
    expect(store.data.marks.a).toBeUndefined();
    expect(store.data.marksMeta.a).toBeUndefined();
    expect(store.data.contrib.a).toBeUndefined();
    await store.close();
  });

  it('不带归属地写仍然记得住，算作 admin', async () => {
    // 本机单机流程没有 actor 这个概念。改造前这条路径会把归属删掉；
    // 现在它必须落到 admin 名下，否则 contrib 里会出现一张没有任何人的标记。
    const store = await createMarkStore(tmp);
    store.setMark('a', 'pick');
    expect(store.data.marks.a).toBe('pick');
    expect(store.data.contrib.a.admin.mark).toBe('pick');
    await store.close();
  });
});

describe('旧文件回填 contrib', () => {
  it('读一个没有 contrib 的旧文件，contrib 被回填出来', async () => {
    await writeMarksFile(tmp, {
      version: 1,
      marks: { a: 'pick', b: 'reject' },
      marksMeta: { a: { by: 'u_ab', at: 777 } },
      settings: {},
    });
    const data = await readMarksFile(tmp);
    expect(data.contrib).toEqual({
      a: { u_ab: { mark: 'pick', at: 777 } },
      b: { admin: { mark: 'reject', at: 0 } },
    });
  });

  it('回填之后 marks 求值的结果和原来一模一样', async () => {
    await writeMarksFile(tmp, {
      version: 1, marks: { a: 'pick' }, marksMeta: { a: { by: 'u_ab', at: 777 } }, settings: {},
    });
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({ a: 'pick' });
    expect(data.marksMeta).toEqual({ a: { by: 'u_ab', at: 777 } });
  });

  it('已经有 contrib 的文件不回填，以 contrib 为准', async () => {
    await writeMarksFile(tmp, {
      version: 1,
      marks: { a: 'pick' },
      contrib: { a: { admin: { mark: 'reject', at: 5 } } },
      settings: {},
    });
    const data = await readMarksFile(tmp);
    expect(data.marks.a).toBe('reject');
  });
});

describe('setHidden', () => {
  it('隐藏未标记的照片', async () => {
    const store = await createMarkStore(tmp);
    const res = store.setHidden(['a', 'b'], true);
    expect(res).toEqual({ hidden: ['a', 'b'], skipped: [] });
    expect(store.data.hidden).toEqual(['a', 'b']);
    await store.close();
  });

  it('已标记的被跳过，其余照常隐藏', async () => {
    // 框选五十张里有一张收藏过就整批失败，是比部分执行更差的行为，
    // 而不变量在两种做法下同样成立。
    const store = await createMarkStore(tmp);
    store.setMark('a', 'pick', { by: 'admin', at: 1 });
    const res = store.setHidden(['a', 'b'], true);
    expect(res).toEqual({ hidden: ['b'], skipped: ['a'] });
    expect(store.data.hidden).toEqual(['b']);
    await store.close();
  });

  it('取消隐藏', async () => {
    const store = await createMarkStore(tmp);
    store.setHidden(['a', 'b'], true);
    const res = store.setHidden(['a'], false);
    expect(res).toEqual({ hidden: ['b'], skipped: [] });
    expect(store.data.hidden).toEqual(['b']);
    await store.close();
  });

  it('给一张已隐藏的照片打标记会自动取消它的隐藏', async () => {
    // 否则「已标记 ∧ 已隐藏」这个非法状态会从后门溜进来。
    const store = await createMarkStore(tmp);
    store.setHidden(['a'], true);
    store.setMark('a', 'pick', { by: 'admin', at: 1 });
    expect(store.data.hidden).toEqual([]);
    expect(store.data.marks.a).toBe('pick');
    await store.close();
  });

  it('清除标记不会把照片重新隐藏回去', async () => {
    // 自动取消隐藏是一次性的动作，不是一条要维持的双向绑定。
    const store = await createMarkStore(tmp);
    store.setHidden(['a'], true);
    store.setMark('a', 'pick', { by: 'admin', at: 1 });
    store.setMark('a', null, { by: 'admin', at: 2 });
    expect(store.data.hidden).toEqual([]);
    await store.close();
  });

  it('隐藏状态落盘并读得回来', async () => {
    const store = await createMarkStore(tmp);
    store.setHidden(['a', 'b'], true);
    await store.close();
    const data = await readMarksFile(tmp);
    expect(data.hidden).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run server/lib/store.test.js -t "sanitizeHidden"`
Expected: FAIL，`sanitizeHidden is not a function`

- [ ] **Step 3: 改 sanitize**

`server/lib/store.js` 顶部 import 加：

```js
import { backfill, evaluate, sanitizeContrib, setContribution } from './contrib.js';
```

在 `sanitizeMarksMeta` 下方加：

```js
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
```

`sanitize()` 的返回部分整个换成（两个分支合并成一条路径）：

```js
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
```

> `sanitizeMarksMeta` 现在只在回填路径上用到，保留原样不动。

- [ ] **Step 4: 改 setMark，加 setHidden**

`createMarkStore` 返回对象里的 `setMark` 整个替换：

```js
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
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run server/lib/store.test.js`
Expected: PASS。既有用例里凡是断言「不带归属地写会删掉 marksMeta」的，行为已经变了——按上面 `setMark` 的新注释改成断言归属落在 `admin` 名下。

- [ ] **Step 6: 跑全套，修被带崩的路由测试**

Run: `npm test`
Expected: `server/routes/marks.test.js` 可能有用例依赖旧的「不带归属 = 无归属」语义，按新行为更新断言。

- [ ] **Step 7: 三条门禁 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add server/lib/store.js server/lib/store.test.js server/routes/marks.test.js
git commit -m "feat: marks 改成从 contrib 求值 —— 取消标记会回退到上一个人那一票"
```

---

## 阶段 G：隐藏（Task 15–18）

### Task 15: 隐藏的服务端接口

**Files:**
- Modify: `server/routes/marks.js`
- Test: `server/routes/marks.test.js`（追加）、`server/routes/permissions.test.js`（追加）

**Interfaces:**
- Consumes: Task 14 的 `markStore.setHidden`
- Produces:
  - `PUT /api/library/hidden` —— admin-only。请求体 `{ ids: string[], hidden: boolean }`，回 `{ ok: true, hidden: string[], skipped: string[] }`
  - `GET /api/library/marks` 的响应多一个 `hidden: string[]` 字段
  - 新的 SSE 事件 `{ type: 'hidden', origin: 'admin', hidden: string[] }`

- [ ] **Step 1: 写失败的测试**

在 `server/routes/marks.test.js` 末尾追加：

```js
describe('PUT /api/library/hidden', () => {
  it('管理员能隐藏未标记的照片', async () => {
    const res = await adminPut('/api/library/hidden', { ids: ['cam-a/IMG_1'], hidden: true });
    expect(res.status).toBe(200);
    expect(res.body.hidden).toEqual(['cam-a/IMG_1']);
    expect(res.body.skipped).toEqual([]);
  });

  it('已标记的被跳过而不是让整批 400', async () => {
    await adminPut('/api/library/marks', { marks: { 'cam-a/IMG_1': 'pick' } });
    const res = await adminPut('/api/library/hidden', {
      ids: ['cam-a/IMG_1', 'cam-a/IMG_2'], hidden: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.hidden).toEqual(['cam-a/IMG_2']);
    expect(res.body.skipped).toEqual(['cam-a/IMG_1']);
  });

  it('未知资产 400', async () => {
    const res = await adminPut('/api/library/hidden', { ids: ['不存在'], hidden: true });
    expect(res.status).toBe(400);
  });

  it('ids 不是数组 400', async () => {
    const res = await adminPut('/api/library/hidden', { ids: 'cam-a/IMG_1', hidden: true });
    expect(res.status).toBe(400);
  });

  it('hidden 不是布尔 400', async () => {
    const res = await adminPut('/api/library/hidden', { ids: ['cam-a/IMG_1'], hidden: 'yes' });
    expect(res.status).toBe(400);
  });

  it('GET /marks 把 hidden 一起带出来', async () => {
    await adminPut('/api/library/hidden', { ids: ['cam-a/IMG_1'], hidden: true });
    const res = await adminGet('/api/library/marks');
    expect(res.body.hidden).toEqual(['cam-a/IMG_1']);
  });
});
```

在 `server/routes/permissions.test.js` 的权限矩阵里追加一行：`PUT /api/library/hidden` —— admin 200 / editor 403 / viewer 403 / anonymous 401。照抄该文件里既有条目的写法（它已经按「四种身份 × 每一条受保护路由」组织）。

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run server/routes/marks.test.js -t "PUT /api/library/hidden"`
Expected: FAIL，404

- [ ] **Step 3: 写路由**

`server/routes/marks.js` —— `GET /marks` 那条改成把 hidden 带出来：

```js
marksRouter.get('/marks', requirePerm('read'), requireSession, (req, res) => {
  const { marks, settings, marksMeta, hidden } = req.session.markStore.data;
  // marksMeta / hidden 都是平行表，marks 的形状不变。
  // 老客户端读不到这两个字段也照常工作。
  res.json({ marks, settings, marksMeta, hidden });
});
```

在 `PUT /marks` 之后追加：

```js
/**
 * 隐藏 / 取消隐藏（规格 §6）。
 *
 * **admin-only，和导出同一档。** 隐藏改变的是所有人眼前的那一屏，
 * 而它没有撤销入口——客户手一滑就能让摄影师的三百张照片凭空消失。
 * 这是硬编码，界面上找不到、配置里也没有一个开关可以放开它。
 */
marksRouter.put('/hidden', requireAdmin, requireSession, async (req, res, next) => {
  try {
    const ids = req.body?.ids;
    const hidden = req.body?.hidden;
    if (!Array.isArray(ids)) {
      return res.status(400).json({ error: 'ids 必须是数组' });
    }
    if (typeof hidden !== 'boolean') {
      return res.status(400).json({ error: 'hidden 必须是布尔值' });
    }
    // 和 PUT /marks 同一条规矩：整批校验完才动手，否则半路失败没法回滚。
    for (const id of ids) {
      if (typeof id !== 'string' || !req.session.byId.has(id)) {
        return res.status(400).json({ error: `未知资产：${id}` });
      }
    }

    const result = req.session.markStore.setHidden(ids, hidden);

    const err = req.session.markStore.takeError();
    if (err) {
      return res.status(500).json({
        error: 'persist-failed', message: `隐藏状态未能写入磁盘：${err.message}`,
      });
    }

    // 广播整份 hidden 而不是增量：它是一个几百条的字符串数组，
    // 整份推的代价可以忽略，而增量要在两端各维护一套合并规则。
    emit(req.session, { type: 'hidden', origin: 'admin', hidden: result.hidden });

    // 留痕。隐藏和标记一样会改变所有人看到的东西，事后必须解释得清。
    const event = {
      actor: 'admin',
      action: hidden ? 'hidden.add' : 'hidden.remove',
      count: result.hidden.length,
      ...(ids.length <= BULK_ID_LIMIT ? { assetIds: ids } : {}),
      ...(result.skipped.length > 0 ? { skipped: result.skipped.length } : {}),
    };
    for (const share of await auditTargets(req)) {
      await logShareEvent(share, event);
    }

    res.json({ ok: true, hidden: result.hidden, skipped: result.skipped });
  } catch (err) { next(err); }
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/routes/marks.test.js server/routes/permissions.test.js`
Expected: PASS

- [ ] **Step 5: 三条门禁 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add server/routes/marks.js server/routes/marks.test.js server/routes/permissions.test.js
git commit -m "feat: 隐藏接口 —— admin-only，已标记的过滤掉而不是整批失败"
```

---

### Task 16: 前端隐藏状态与筛选

**Files:**
- Modify: `web/src/types.ts`、`web/src/lib/derive.ts`、`web/src/store/marks.ts`、`web/src/store/library.ts`、`web/src/lib/realtime.ts`
- Test: `web/src/lib/derive.test.ts`（追加）、`web/src/store/marks.test.ts`（追加）

**Interfaces:**
- Consumes: Task 15 的 `hidden` 字段与 `hidden` SSE 事件
- Produces:
  - `FilterTab` 加 `'hidden'`
  - `useMarks.hidden: Set<string>`、`useMarks.setHidden(ids, hidden)`、`useMarks.applyRemoteHidden(list)`
  - `derive.ts`：`filterAssets` / `filterGroups` / `countByTab` / `dirCounts` / `dirRejected` 全部多接一个 `hidden: Set<string>` 参数
  - `countByTab` 的返回值加 `hidden: number`

- [ ] **Step 1: 写失败的测试**

在 `web/src/lib/derive.test.ts` 末尾追加：

```ts
describe('隐藏', () => {
  const assets = [a('IMG_1', 'cam-a'), a('IMG_2', 'cam-a'), a('IMG_3', 'cam-b')];
  const hidden = new Set(['IMG_2']);

  it('隐藏的照片不进任何普通 tab', () => {
    expect(filterAssets(assets, {}, 'all', null, hidden).map((x) => x.id)).toEqual(['IMG_1', 'IMG_3']);
    expect(filterAssets(assets, {}, 'none', null, hidden).map((x) => x.id)).toEqual(['IMG_1', 'IMG_3']);
  });

  it('「已隐藏」tab 里只有它们', () => {
    expect(filterAssets(assets, {}, 'hidden', null, hidden).map((x) => x.id)).toEqual(['IMG_2']);
  });

  it('「已隐藏」tab 不受目录筛选以外的东西影响，但目录筛选照常生效', () => {
    expect(filterAssets(assets, {}, 'hidden', 'cam-b', hidden)).toEqual([]);
  });

  it('计数里剔除隐藏的，另外单独给出隐藏数', () => {
    const counts = countByTab(assets, { IMG_1: 'pick' }, hidden);
    expect(counts).toEqual({ all: 2, pick: 1, reject: 0, none: 1, hidden: 1 });
  });

  it('左侧目录的总数也要剔除，否则显示 30 张而网格里只有 12 张', () => {
    expect(dirCounts(assets, hidden)).toEqual([
      { dir: 'cam-a', count: 1 },
      { dir: 'cam-b', count: 1 },
    ]);
  });

  it('目录的排除计数同样剔除隐藏的', () => {
    // dirCounts 按剔除后的数算总数，dirRejected 不剔除的话，
    // 「这个目录是不是全排除了」会得出一个永远为真或永远为假的结论。
    const marks = { IMG_1: 'reject' as const, IMG_2: 'reject' as const };
    expect(dirRejected(assets, marks, hidden).get('cam-a')).toBe(1);
  });

  it('连拍组里被隐藏的成员从组里去掉', () => {
    const groups = [{ key: 'g1', ids: ['IMG_1', 'IMG_2'] }];
    expect(filterGroups(groups, {}, 'all', hidden)).toEqual([{ key: 'g1', ids: ['IMG_1'] }]);
  });

  it('整组都被隐藏时这个组整个消失', () => {
    const groups = [{ key: 'g1', ids: ['IMG_2'] }];
    expect(filterGroups(groups, {}, 'all', hidden)).toEqual([]);
  });
});
```

> `a(id, dir)` 是本文件已有的资产构造辅助函数；名字不一致就用它实际用的那个。

在 `web/src/store/marks.test.ts` 末尾追加：

```ts
describe('hidden', () => {
  it('load 把 hidden 灌进 store', () => {
    useMarks.getState().load({}, undefined, ['a', 'b']);
    expect([...useMarks.getState().hidden]).toEqual(['a', 'b']);
  });

  it('旧文件夹没有这个字段时是空集，不报错', () => {
    useMarks.getState().load({});
    expect(useMarks.getState().hidden.size).toBe(0);
  });

  it('setHidden 乐观更新，失败回滚', async () => {
    stubError('/api/library/hidden', 500, { error: 'persist-failed', message: '写不进去' });
    useMarks.getState().load({}, undefined, []);
    useMarks.getState().setHidden(['a'], true);
    expect(useMarks.getState().hidden.has('a')).toBe(true);   // 乐观
    await flushPromises();
    expect(useMarks.getState().hidden.has('a')).toBe(false);  // 回滚
    expect(useMarks.getState().error).toContain('写不进去');
  });

  it('applyRemoteHidden 用服务端给的整份覆盖', () => {
    useMarks.getState().load({}, undefined, ['a']);
    useMarks.getState().applyRemoteHidden(['b', 'c']);
    expect([...useMarks.getState().hidden]).toEqual(['b', 'c']);
  });
});
```

> `stubError` / `flushPromises` 是本文件已有的辅助函数名；名字不一致就用它实际用的那个。

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run web/src/lib/derive.test.ts -t "隐藏"`
Expected: FAIL —— `filterAssets` 只接四个参数，第五个被忽略，第一条就挂

- [ ] **Step 3: 改类型**

`web/src/types.ts`：

```ts
export type FilterTab = 'all' | 'pick' | 'reject' | 'none' | 'hidden';
```

- [ ] **Step 4: 改 derive.ts**

五个函数各加一个 `hidden: ReadonlySet<string>` 参数，**放在参数表末尾且不给默认值** —— 漏改的调用点必须撞在 `tsc` 上。给默认值会让漏改静默通过，而它的表现是「隐藏功能对那一处不生效」，跑一遍测试也未必看得出来。

```ts
export function filterAssets(
  assets: Asset[], marks: Marks, tab: FilterTab, dirFilter: string | null,
  hidden: ReadonlySet<string>,
): Asset[] {
  return assets.filter((a) => {
    if (dirFilter !== null && a.dir !== dirFilter) return false;
    // 「已隐藏」是一个独立的视图，不和标记正交：隐藏的照片必然未标记
    // （不变量 2），所以这个 tab 下不需要再看 marks。
    if (tab === 'hidden') return hidden.has(a.id);
    if (hidden.has(a.id)) return false;
    const mark = marks[a.id];
    if (tab === 'all') return true;
    if (tab === 'none') return mark === undefined;
    return mark === tab;
  });
}

export function dirCounts(assets: Asset[], hidden: ReadonlySet<string>): { dir: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const a of assets) {
    if (hidden.has(a.id)) continue;
    counts.set(a.dir, (counts.get(a.dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => a.dir.localeCompare(b.dir, 'zh'));
}

export function dirRejected(
  assets: Asset[], marks: Marks, hidden: ReadonlySet<string>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of assets) {
    if (hidden.has(a.id)) continue;
    if (marks[a.id] === 'reject') out.set(a.dir, (out.get(a.dir) ?? 0) + 1);
  }
  return out;
}

export function filterGroups(
  groups: Group[], marks: Marks, tab: FilterTab, hidden: ReadonlySet<string>,
): Group[] {
  // 隐藏集为空且 tab 是 all 时引用不变，下游 memo 不会因为切回全部而重算。
  if (tab === 'all' && hidden.size === 0) return groups;
  const keep = (id: string) => {
    if (tab === 'hidden') return hidden.has(id);
    if (hidden.has(id)) return false;
    if (tab === 'all') return true;
    return tab === 'none' ? marks[id] === undefined : marks[id] === tab;
  };

  const out: Group[] = [];
  for (const group of groups) {
    const ids = group.ids.filter(keep);
    if (ids.length === 0) continue;
    out.push(ids.length === group.ids.length ? group : { key: group.key, ids });
  }
  return out;
}

/** 五个 tab 的数量一次遍历算完。 */
export function countByTab(
  assets: Asset[], marks: Marks, hidden: ReadonlySet<string>,
): Record<FilterTab, number> {
  const out: Record<FilterTab, number> = { all: 0, pick: 0, reject: 0, none: 0, hidden: 0 };
  for (const a of assets) {
    if (hidden.has(a.id)) { out.hidden++; continue; }
    out.all++;
    const mark = marks[a.id];
    if (mark === 'pick') out.pick++;
    else if (mark === 'reject') out.reject++;
    else out.none++;
  }
  return out;
}
```

> `countByTab` 的 `all` 不再是 `assets.length` —— 隐藏的那些不算在里面。这是有意的：顶栏「全部 N」必须和网格里真的能看到的张数一致。

- [ ] **Step 5: 改 marks store**

`web/src/store/marks.ts` —— 接口里加：

```ts
  /** 已隐藏的资产。仅管理员改得动，但访客也持有它（隐藏对所有人生效）。 */
  hidden: Set<string>;
  setHidden: (ids: string[], hidden: boolean) => void;
  /** 服务端广播的整份 hidden。整份覆盖，不做增量合并。 */
  applyRemoteHidden: (list: unknown) => void;
```

`load` 的签名多一个参数：

```ts
  load: (marks: Marks, meta?: unknown, hidden?: unknown) => void;
```

实现：

```ts
    load(marks, meta, hidden) {
      owner.clear();
      inflight.clear();
      set({
        marks: { ...marks },
        marksMeta: sanitizeMeta(meta),
        hidden: sanitizeHiddenList(hidden),
        undoStack: [],
        error: null,
      });
    },

    setHidden(ids, hidden) {
      if (ids.length === 0) return;
      const before = get().hidden;
      const next = new Set(before);
      for (const id of ids) {
        if (hidden) next.add(id);
        else next.delete(id);
      }
      set({ hidden: next, error: null });

      void putJSON<{ hidden: string[] }>('/api/library/hidden', { ids, hidden })
        .then((res) => {
          // 服务端可能跳过了一些（已标记的），以它给的那份为准。
          set({ hidden: new Set(res.hidden) });
        })
        .catch((err: Error) => {
          // 隐藏没有并发保护那一套（owner / inflight）：它只有管理员一个写入方，
          // 不存在"两个人同时改同一张"的竞争。整份回滚即可。
          set({ hidden: before, error: `隐藏未能保存：${err.message}` });
        });
    },

    applyRemoteHidden(list) {
      set({ hidden: sanitizeHiddenList(list) });
    },
```

在 `sanitizeMeta` 旁边加：

```ts
/** 只放行字符串元素。这份数据要进 Set 并直接参与渲染判断，坏元素会静默筛错照片。 */
function sanitizeHiddenList(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((v): v is string => typeof v === 'string' && v !== ''));
}
```

初始状态里加 `hidden: new Set<string>(),`。

- [ ] **Step 6: 接上加载与广播**

`web/src/store/library.ts` —— `MarksResult` 加字段，`open()` 里 `load` 多传一个：

```ts
interface MarksResult {
  marks: Record<string, Mark>;
  settings: Settings;
  marksMeta?: unknown;
  hidden?: unknown;
}
```

```ts
      useMarks.getState().load(loaded.marks, loaded.marksMeta, loaded.hidden);
```

`resetClientState()` 里的 `useMarks.getState().load({})` 保持原样（第三个参数缺省即空集）。

`web/src/lib/realtime.ts` —— `handleRealtimeEvent` 加一支：

```ts
    case 'hidden':
      // 隐藏对所有人生效，访客也要收。整份覆盖，不做增量合并——
      // 它是一个几百条的字符串数组，两端各维护一套合并规则不值得。
      if (!useRealtime.getState().blocked) {
        useMarks.getState().applyRemoteHidden((event as { hidden?: unknown }).hidden);
      }
      return true;
```

`refetchMarks()` 里也要带上：

```ts
    const res = await getJSON<{ marks: Record<string, Mark>; marksMeta?: unknown; hidden?: unknown }>(
      '/api/library/marks');
    if (useRealtime.getState().blocked) return;
    useMarks.getState().reconcile(res.marks ?? {}, res.marksMeta);
    useMarks.getState().applyRemoteHidden(res.hidden);
```

- [ ] **Step 7: 改所有调用点**

```bash
grep -rn "filterAssets\|filterGroups\|countByTab\|dirCounts\|dirRejected" web/src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
```

逐个补上 `hidden` 参数。调用点是 `App.tsx`（`filterGroups`）、`TopBar.tsx`（`countByTab`）、`Sidebar.tsx`（`dirCounts` / `dirRejected`）。三处都从 `useMarks((s) => s.hidden)` 取，并把它加进各自 `useMemo` 的依赖数组。

- [ ] **Step 8: 跑测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 9: 三条门禁 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add web/src/types.ts web/src/lib/derive.ts web/src/lib/derive.test.ts \
        web/src/store/marks.ts web/src/store/marks.test.ts web/src/store/library.ts \
        web/src/lib/realtime.ts web/src/App.tsx web/src/components/TopBar.tsx \
        web/src/components/Sidebar.tsx
git commit -m "feat: 隐藏的前端状态 —— 网格、计数、目录、连拍组一律剔除"
```

---

### Task 17: 隐藏的入口

**Files:**
- Create: `web/src/store/notice.ts`
- Modify: `web/src/store/session.ts`、`web/src/lib/applyMark.ts`、`web/src/lib/useKeyboard.ts`、`web/src/components/MarkBar.tsx`、`web/src/components/Toast.tsx`、`web/src/store/library.ts`
- Test: `web/src/lib/applyMark.test.ts`（新建，若不存在）、`web/src/components/MarkBar.test.tsx`（追加）、`web/src/lib/useKeyboard.test.tsx`（追加）

**Interfaces:**
- Consumes: Task 16 的 `useMarks.setHidden`
- Produces:
  - `useSession.canHide(): boolean` —— 只有 `kind === 'admin'` 为 true
  - `applyHidden(hidden: boolean, opts?: { targets?: string[] }): { hidden: number; skipped: number } | null` —— `null` = 没权限或没目标

- [ ] **Step 1: 写失败的测试**

创建 `web/src/lib/applyMark.test.ts`（若已存在则追加）：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyHidden } from './applyMark';
import { useMarks } from '../store/marks';
import { useSession, setSession } from '../store/session';
import { useView } from '../store/view';

beforeEach(() => {
  useMarks.setState({ marks: {}, marksMeta: {}, hidden: new Set(), error: null });
  useView.setState({ selection: new Set(), cursor: null });
  setSession({ kind: 'admin', user: null });
  vi.spyOn(useMarks.getState(), 'setHidden').mockImplementation(() => {});
});

describe('applyHidden', () => {
  it('访客一律拒绝，连请求都不发', () => {
    // 三道门禁里的第三道。只靠服务端的话，乐观更新会先把照片藏起来、
    // 等 403 回来再弹回去——中间那一瞬间「看起来我藏成功了」最容易误判。
    setSession({ kind: 'user', user: { id: 'u_ab', nickname: '小林', role: 'editor' } });
    expect(applyHidden(true, { targets: ['a'] })).toBeNull();
  });

  it('身份未定时也拒绝（默认拒绝）', () => {
    setSession({ kind: 'none', user: null });
    expect(applyHidden(true, { targets: ['a'] })).toBeNull();
  });

  it('没有目标时返回 null', () => {
    expect(applyHidden(true)).toBeNull();
  });

  it('一批里已标记的被跳过，未标记的照常隐藏', () => {
    // 整批拒绝是更差的选择：框选五十张里有一张收藏过，就什么都做不了。
    useMarks.setState({ marks: { a: 'pick' }, marksMeta: {}, hidden: new Set() });
    expect(applyHidden(true, { targets: ['a', 'b', 'c'] })).toEqual({ hidden: 2, skipped: 1 });
  });

  it('取消隐藏不受「已标记」限制', () => {
    // 已隐藏的必然未标记，所以取消隐藏这条路径上不可能撞上这个限制；
    // 但真要撞上（脏数据），也不该把它挡在外面——那会让它永远藏着。
    useMarks.setState({ marks: { a: 'pick' }, marksMeta: {}, hidden: new Set(['a']) });
    expect(applyHidden(false, { targets: ['a'] })).toEqual({ hidden: 1, skipped: 0 });
  });

  it('没有选区时作用于光标那一张', () => {
    useView.setState({ selection: new Set(), cursor: 'a' });
    expect(applyHidden(true)).toEqual({ hidden: 1, skipped: 0 });
  });
});
```

在 `web/src/components/MarkBar.test.tsx` 末尾追加：

```tsx
describe('隐藏按钮', () => {
  it('管理员的批量操作条上有「隐藏」', () => {
    setSession({ kind: 'admin', user: null });
    useView.setState({ selection: new Set(['a']) });
    const { getByText } = render(<MarkBar />);
    expect(getByText('隐藏')).toBeTruthy();
  });

  it('访客的操作条上整个不渲染这个按钮（不是置灰）', () => {
    // 只读界面只展示有权限的操作。
    setSession({ kind: 'user', user: { id: 'u_ab', nickname: '小林', role: 'editor' } });
    useView.setState({ selection: new Set(['a']) });
    const { queryByText } = render(<MarkBar />);
    expect(queryByText('隐藏')).toBeNull();
    expect(queryByText('收藏')).toBeTruthy();   // 别的按钮照常在
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run web/src/lib/applyMark.test.ts`
Expected: FAIL，`applyHidden is not a function`

- [ ] **Step 3: 加 `canHide`**

`web/src/store/session.ts` —— 接口里加：

```ts
  /**
   * 能不能隐藏照片。**只有管理员**——隐藏改变的是所有人眼前的那一屏，
   * 而它没有撤销入口。和导出同一档，不设"信任的客户"这一档。
   *
   * 单独一个方法而不是让调用方就地写 `kind === 'admin'`：它是整个前端唯一
   * 一份「能不能隐藏」的判断，再写一份等于给自己留一个将来两处不一致的接缝。
   */
  canHide(): boolean;
```

实现（在 `canWrite` 旁边）：

```ts
  canHide() { return get().kind === 'admin'; },
```

- [ ] **Step 4: 加 `applyHidden`**

`web/src/lib/applyMark.ts` 末尾追加：

```ts
/**
 * 全前端**唯一**的隐藏入口。键盘 `H` 与批量操作条都走这里。
 *
 * 返回实际生效的张数与被跳过的张数；没权限或没目标时返回 null
 * （键盘那边靠它决定要不要 preventDefault）。
 *
 * ── 只读门禁 ──────────────────────────────────────────────────────────────
 * 判据用 `session.canHide()` 而不是 `canWrite()`：隐藏比标记更严格，
 * editor 角色的访客能标记但不能隐藏。和 canWrite 一样是**默认拒绝**的。
 */
export function applyHidden(
  hidden: boolean, opts: { targets?: string[] } = {},
): { hidden: number; skipped: number } | null {
  if (!useSession.getState().canHide()) return null;

  const view = useView.getState();
  const targets = opts.targets ?? markTargets(view);
  if (targets.length === 0) return null;

  // 已标记的不能隐藏（规格 §1.5 不变量 2）。服务端会再过滤一遍并回报
  // 权威结果，这里先算一份是为了**立刻**给出那句"M 张因为已有标记被跳过"——
  // 等一趟往返回来再说的话，用户已经在纳闷刚才那一下是不是没生效了。
  // 取消隐藏不受这条限制：已隐藏的必然未标记，真撞上（脏数据）也不该
  // 把它挡在外面，那会让它永远藏着。
  const marks = useMarks.getState().marks;
  const eligible = hidden ? targets.filter((id) => marks[id] === undefined) : targets;
  const skipped = targets.length - eligible.length;
  if (eligible.length === 0) return { hidden: 0, skipped };

  useMarks.getState().setHidden(eligible, hidden);
  return { hidden: eligible.length, skipped };
}
```

- [ ] **Step 5: 接上键盘**

`web/src/lib/useKeyboard.ts`：

顶部 import 改成 `import { applyHidden, applyMark, markTargets } from './applyMark';`，另加 `import { showToast } from '../store/notice';`，并把 tab 表加一档：

```ts
const TABS: FilterTab[] = ['all', 'pick', 'reject', 'none', 'hidden'];
```

在 `switch` 里加一支（放在 `case 'u'` 之后）：

```ts
        case 'h': {
          // 隐藏 / 取消隐藏。作用对象和 P/X 完全一致（markTargets）。
          const inHiddenTab = view.tab === 'hidden';
          const result = applyHidden(!inHiddenTab);
          if (!result) return;             // 没权限或没目标，不吞按键
          e.preventDefault();
          if (result.hidden === 0 && result.skipped > 0) {
            showToast('已标记的照片不能隐藏，先取消标记');
          } else if (result.skipped > 0) {
            showToast(`已隐藏 ${result.hidden} 张，${result.skipped} 张因为已有标记被跳过`);
          }
          return;
        }
```

把数字键那一支扩到 5：

```ts
        case '1': case '2': case '3': case '4': case '5':
          e.preventDefault();
          // 「已隐藏」只有管理员看得到。访客按 5 什么都不该发生——
          // 让他切进一个空的、解释不了的 tab 比不响应更糟。
          if (e.key === '5' && !useSession.getState().canHide()) return;
          view.setTab(TABS[Number(e.key) - 1]);
          return;
```

`showToast` 现在**不存在**——`Toast.tsx` 完全由 `useMarks.undoStack` 与 `useMarks.error` 驱动，没有第三个入口。新建 `web/src/store/notice.ts`：

```ts
import { create } from 'zustand';

interface NoticeState {
  /** 一句一次性提示。null = 没有。 */
  text: string | null;
}

/**
 * 一次性提示。放在独立 store 而不是塞进 marks store，是因为它和标记无关：
 * 「已标记的照片不能隐藏」这种话，marks 那边没有任何字段能自然地表达。
 */
export const useNotice = create<NoticeState>(() => ({ text: null }));

let timer: ReturnType<typeof setTimeout> | null = null;

export function showToast(text: string) {
  if (timer) clearTimeout(timer);
  useNotice.setState({ text });
  timer = setTimeout(() => {
    timer = null;
    useNotice.setState({ text: null });
  }, 3000);
}

/** 换文件夹时清掉。上一个文件夹的提示留到下一个文件夹里是纯噪音。 */
export function clearToast() {
  if (timer) { clearTimeout(timer); timer = null; }
  useNotice.setState({ text: null });
}
```

`web/src/components/Toast.tsx` —— 订阅它，插在**错误之后、撤销提示之前**：

```tsx
  const notice = useNotice((s) => s.text);
```

```tsx
  // 优先级：错误 > 一次性提示 > 撤销提示。
  //
  // 错误压过一切（它需要用户去处理，而且只有手动才关得掉）。一次性提示压过
  // 撤销提示，是因为它解释的是**用户刚按下的那一下为什么没有全部生效**——
  // 而撤销提示（"已更新 N 张"）此刻说的是同一次操作里成功的那部分，
  // 两条同时冒出来只会让人不知道该看哪句。
  if (notice) return <div className="toast">{notice}</div>;
```

`web/src/store/library.ts` 的 `resetClientState()` 里加一句 `clearToast();`。

- [ ] **Step 6: 接上批量操作条**

`web/src/components/MarkBar.tsx`：

```tsx
import { applyHidden, applyMark } from '../lib/applyMark';
import { showToast } from '../store/notice';
```

组件里加：

```tsx
  const canHide = useSession((s) => s.canHide());
```

在「取消标记」按钮之后加：

```tsx
      {/* 隐藏只有管理员看得到。这是主要用法——一次清掉几十张废片，
          逐张点是不现实的，而角标右下角已经挤了 ✓/✕ 两个按钮。 */}
      {canHide && (
        <button type="button" className="markbar-hide" onClick={() => {
          const result = applyHidden(true, { targets: [...selection] });
          clearSelection();
          setSelectMode('single');
          if (result && result.skipped > 0) {
            showToast(result.hidden === 0
              ? '已标记的照片不能隐藏，先取消标记'
              : `已隐藏 ${result.hidden} 张，${result.skipped} 张因为已有标记被跳过`);
          }
        }}>隐藏</button>
      )}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run web/src/lib/applyMark.test.ts web/src/components/MarkBar.test.tsx web/src/lib/useKeyboard.test.tsx`
Expected: PASS

- [ ] **Step 8: 三条门禁 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add web/src/store/session.ts web/src/store/notice.ts web/src/lib/applyMark.ts \
        web/src/lib/applyMark.test.ts web/src/lib/useKeyboard.ts \
        web/src/components/MarkBar.tsx web/src/components/MarkBar.test.tsx \
        web/src/components/Toast.tsx web/src/store/library.ts
git commit -m "feat: 隐藏的入口 —— H 键与批量操作条，仅管理员"
```

---

### Task 18: 第五个 tab

**Files:**
- Modify: `web/src/components/TopBar.tsx`、`web/src/components/Thumb.tsx`、`web/src/styles.css`
- Test: `web/src/components/TopBar.test.tsx`（追加）、`web/src/components/Thumb.test.tsx`（追加）

**Interfaces:**
- Consumes: Task 16 的 `countByTab().hidden`、Task 17 的 `canHide` / `applyHidden`
- Produces: 无新接口

- [ ] **Step 1: 写失败的测试**

在 `web/src/components/TopBar.test.tsx` 末尾追加：

```tsx
describe('已隐藏 tab', () => {
  it('管理员看得到第五个 tab 和它的计数', () => {
    setSession({ kind: 'admin', user: null });
    useMarks.setState({ marks: {}, marksMeta: {}, hidden: new Set(['a', 'b']) });
    useLibrary.setState({ assets: [asset('a'), asset('b'), asset('c')] });
    const { getByText } = render(<TopBar onExport={() => {}} />);
    const tab = getByText('已隐藏').closest('button')!;
    expect(tab.textContent).toContain('2');
  });

  it('访客那一侧整个 tab 不进 DOM', () => {
    setSession({ kind: 'user', user: { id: 'u_ab', nickname: '小林', role: 'editor' } });
    const { queryByText } = render(<TopBar onExport={() => {}} />);
    expect(queryByText('已隐藏')).toBeNull();
    expect(queryByText('全部')).toBeTruthy();
  });
});
```

在 `web/src/components/Thumb.test.tsx` 末尾追加：

```tsx
describe('已隐藏视图里的取消隐藏按钮', () => {
  it('站在「已隐藏」tab 上时每张图有取消隐藏按钮', () => {
    setSession({ kind: 'admin', user: null });
    useView.setState({ tab: 'hidden' });
    const { getByLabelText } = render(<Thumb asset={asset} priority={0} visible />);
    expect(getByLabelText('取消隐藏')).toBeTruthy();
  });

  it('别的 tab 上没有这个按钮', () => {
    setSession({ kind: 'admin', user: null });
    useView.setState({ tab: 'all' });
    const { queryByLabelText } = render(<Thumb asset={asset} priority={0} visible />);
    expect(queryByLabelText('取消隐藏')).toBeNull();
  });

  it('「已隐藏」tab 上不再显示 ✓/✕ 标记按钮', () => {
    // 在这里打标记会自动取消隐藏（不变量 3），那是个会让照片当场从眼前
    // 消失的操作。把它藏在一个看起来只是"标记"的按钮后面是误导。
    setSession({ kind: 'admin', user: null });
    useView.setState({ tab: 'hidden' });
    const { queryByLabelText } = render(<Thumb asset={asset} priority={0} visible />);
    expect(queryByLabelText('收藏')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run web/src/components/TopBar.test.tsx -t "已隐藏 tab"`
Expected: FAIL —— 找不到「已隐藏」

- [ ] **Step 3: 改 TopBar**

`TABS` 常量拆成两截：

```tsx
const TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pick', label: '收藏' },
  { key: 'reject', label: '排除' },
  { key: 'none', label: '未标记' },
];

/** 第五个 tab 只有管理员看得到：隐藏是摄影师的操作，客户那侧没有这个概念。 */
const HIDDEN_TAB: { key: FilterTab; label: string } = { key: 'hidden', label: '已隐藏' };
```

组件里订阅 `canHide` 与 `hidden`，把它拼进 tab 列表：

```tsx
  const canHide = useSession((s) => s.canHide());
  const hidden = useMarks((s) => s.hidden);
```

```tsx
  const counts = useMemo(() => countByTab(inDir, marks, hidden), [inDir, marks, hidden]);
  const tabs = canHide ? [...TABS, HIDDEN_TAB] : TABS;
```

`<nav className="tabs">` 里 `TABS.map` 换成 `tabs.map`。

- [ ] **Step 4: 改 Thumb**

`web/src/components/Thumb.tsx` —— 订阅当前 tab 与 `canHide`：

```tsx
  const tab = useView((s) => s.tab);
  const canHide = useSession((s) => s.canHide());
  const inHiddenTab = tab === 'hidden';
```

把 `{canWrite && (...)}` 那一段的条件改成 `{canWrite && !inHiddenTab && (...)}`，并在它之后加：

```tsx
      {/* 「已隐藏」视图里换成一个取消隐藏按钮。这里**不**显示 ✓/✕ ——
          在这个 tab 里打标记会自动取消隐藏（不变量 3），那是个会让照片
          当场从眼前消失的操作，藏在一个看起来只是"标记"的按钮后面是误导。 */}
      {canHide && inHiddenTab && (
        <div className="thumb-actions">
          <button type="button" className="thumb-act thumb-act-unhide"
                  aria-label="取消隐藏"
                  onClick={(e) => {
                    e.stopPropagation();
                    applyHidden(false, { targets: [asset.id] });
                  }}>↩</button>
        </div>
      )}
```

顶部 import 加 `applyHidden`。

- [ ] **Step 5: 加样式**

`web/src/styles.css` 追加：

```css
.thumb-act-unhide { font-size: 15px; }
.markbar-hide { margin-left: 4px; }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run web/src/components/TopBar.test.tsx web/src/components/Thumb.test.tsx`
Expected: PASS

- [ ] **Step 7: 三条门禁 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add web/src/components/TopBar.tsx web/src/components/TopBar.test.tsx \
        web/src/components/Thumb.tsx web/src/components/Thumb.test.tsx web/src/styles.css
git commit -m "feat: 第五个 tab「已隐藏」，仅管理员可见"
```

---

## 阶段 H：客户维度（Task 19–22）

### Task 19: `showPeerMarks` 开关

**Files:**
- Modify: `server/lib/shares.js`、`server/routes/admin.js`、`web/src/components/SharePanel.tsx`
- Test: `server/lib/shares.test.js`（追加）、`server/routes/admin.test.js`（追加）、`web/src/components/SharePanel.test.tsx`（追加）

**Interfaces:**
- Consumes: 无
- Produces:
  - `Share.showPeerMarks: boolean`（`createShare` 默认 `true`）
  - `PATCH /api/admin/shares/:id` 接受 `showPeerMarks`
  - SSE 事件 `{ type: 'peer-marks', showPeerMarks: boolean }`，只发给该分享的访客

- [ ] **Step 1: 写失败的测试**

在 `server/lib/shares.test.js` 末尾追加：

```js
describe('showPeerMarks', () => {
  it('新建的分享默认公开', async () => {
    // 那是改造前的行为。升级不该悄悄改变已经发出去的链接的表现。
    const share = await createShare({ root: '/tmp/x' });
    expect(share.showPeerMarks).toBe(true);
  });

  it('可以在新建时指定', async () => {
    const share = await createShare({ root: '/tmp/x', showPeerMarks: false });
    expect(share.showPeerMarks).toBe(false);
  });

  it('在可 PATCH 的白名单里', async () => {
    const share = await createShare({ root: '/tmp/x' });
    const updated = await updateShare(share.id, { showPeerMarks: false });
    expect(updated.showPeerMarks).toBe(false);
  });

  it('root 和 token 仍然不在白名单里', async () => {
    // 改 root 等于把一条已经发出去的分享链接静默指向另一个文件夹；
    // 改 token 等于让旧链接失效却不留痕迹。
    const share = await createShare({ root: '/tmp/x' });
    const updated = await updateShare(share.id, { root: '/tmp/y', token: 'hacked' });
    expect(updated.root).toBe('/tmp/x');
    expect(updated.token).toBe(share.token);
  });

  it('老的 shares.json 里没有这个字段时按公开处理', async () => {
    // 读出来是 undefined，所有判据都必须写成 `=== false` 而不是 `!x`。
    const share = await createShare({ root: '/tmp/x' });
    delete share.showPeerMarks;
    expect(share.showPeerMarks === false).toBe(false);
  });
});
```

在 `server/routes/admin.test.js` 末尾追加：

```js
describe('PATCH showPeerMarks', () => {
  it('改得动，并且回在响应里', async () => {
    const share = await createShare({ root: testRoot });
    const res = await adminPatch(`/api/admin/shares/${share.id}`, { showPeerMarks: false });
    expect(res.status).toBe(200);
    expect(res.body.share.showPeerMarks).toBe(false);
  });

  it('非布尔值 400', async () => {
    const share = await createShare({ root: testRoot });
    const res = await adminPatch(`/api/admin/shares/${share.id}`, { showPeerMarks: 'no' });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run server/lib/shares.test.js -t "showPeerMarks"`
Expected: FAIL，`expected undefined to be true`

- [ ] **Step 3: 改 shares.js**

`PATCHABLE_FIELDS` 加一项：

```js
const PATCHABLE_FIELDS = [
  'label', 'expiresAt', 'defaultRole', 'allowUserCreation', 'maxUsers', 'showPeerMarks',
];
```

`createShare` 的参数与 share 对象各加一项：

```js
export async function createShare({
  root,
  label = '',
  expiresAt = null,
  defaultRole = 'editor',
  allowUserCreation = true,
  maxUsers = null,
  // 默认公开：那是改造前的行为。升级不该悄悄改变已经发出去的链接的表现。
  showPeerMarks = true,
} = {}) {
```

```js
      maxUsers,
      showPeerMarks,
    };
```

- [ ] **Step 4: 改 admin.js**

`pickShareFields` 里加上 `showPeerMarks` 的校验（照 `checkBoolean('allowUserCreation', …)` 的写法）：

```js
  if (Object.prototype.hasOwnProperty.call(body, 'showPeerMarks')) {
    checkBoolean('showPeerMarks', body.showPeerMarks);
    out.showPeerMarks = body.showPeerMarks;
  }
```

`publicShare` 里把这个字段带出去：

```js
    showPeerMarks: share.showPeerMarks !== false,
```

> 写成 `!== false` 而不是 `?? true`：老的 `shares.json` 里这个字段可能整个不存在，也可能是别的假值。这一条口径必须和服务端过滤那一处（Task 20）**完全一致**，否则会出现「管理台显示公开、访客实际看不到」这种查都没法查的分歧。

PATCH 路由里，改动落盘之后向该分享的在线访客推一帧（放在现有的 `logShareEvent` 之后）：

```js
    // 开关改完立刻推给在线访客，两个方向都推：true → false 要把别人的标记
    // 从她屏幕上撤掉，false → true 要把它们放出来。复用角色变更那条路径。
    if (Object.prototype.hasOwnProperty.call(patch, 'showPeerMarks')) {
      emitToShare(updated, { type: 'peer-marks', showPeerMarks: updated.showPeerMarks !== false });
    }
```

`emitToShare` 若不存在，参照 `server/lib/presence.js` 里给单条分享的访客发事件的既有写法实现（遍历该 root 会话的 listeners，挑出 `actor.kind === 'user' && actor.share.id === share.id` 的那些）。

- [ ] **Step 5: 改 SharePanel**

`ShareRecord` 接口加 `showPeerMarks: boolean;`。

新建表单加一个复选框状态 `const [showPeerMarks, setShowPeerMarks] = useState(true);`，`submitCreate` 的请求体里带上它，表单里加：

```tsx
        <label className="row">
          <input
            type="checkbox"
            checked={showPeerMarks}
            onChange={(e) => setShowPeerMarks(e.target.checked)}
          />
          让客户看到彼此的选片标记
        </label>
        <p className="muted share-hint">
          关掉之后，每位客户只看得见**自己的**选择和**你的**选择，看不见别的客户选了什么。
          你自己在这边照常看得到全部，也能按人筛。
        </p>
```

已有分享那一行的操作区加一个切换按钮（挨着「关闭新成员」）：

```tsx
                <button onClick={() => void togglePeerMarks(share)} disabled={share.revoked}>
                  {share.showPeerMarks ? '隐藏客户标记' : '公开客户标记'}
                </button>
```

```tsx
  const togglePeerMarks = async (share: ShareRecord) => {
    setRowError(null);
    try {
      await patchJSON(`/api/admin/shares/${share.id}`, { showPeerMarks: !share.showPeerMarks });
      await load();
    } catch (e) {
      setRowError(describeError(e));
    }
  };
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run server/lib/shares.test.js server/routes/admin.test.js web/src/components/SharePanel.test.tsx`
Expected: PASS

- [ ] **Step 7: 三条门禁 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add server/lib/shares.js server/lib/shares.test.js server/routes/admin.js \
        server/routes/admin.test.js web/src/components/SharePanel.tsx \
        web/src/components/SharePanel.test.tsx
git commit -m "feat: 分享加 showPeerMarks 开关，默认公开"
```

---

### Task 20: 服务端按人过滤

**Files:**
- Modify: `server/routes/marks.js`
- Test: `server/routes/marks.test.js`（追加）

**Interfaces:**
- Consumes: Task 13 的 `visibleMark`、Task 19 的 `Share.showPeerMarks`
- Produces:
  - `GET /api/library/marks` 对 `showPeerMarks === false` 的访客返回派生后的 `marks`，且**不含 `contrib`**
  - `PUT /api/library/marks` 的广播按每条连接单独过滤

- [ ] **Step 1: 写失败的测试**

在 `server/routes/marks.test.js` 末尾追加：

```js
describe('showPeerMarks: false 时的按人过滤', () => {
  it('访客看不到别的客户那一票', async () => {
    await guestPut('/api/library/marks', { marks: { 'cam-a/IMG_1': 'pick' } }, { as: 'u_other' });
    const res = await guestGet('/api/library/marks', { as: 'u_me' });
    expect(res.body.marks['cam-a/IMG_1']).toBeUndefined();
  });

  it('访客看得到摄影师那一票', async () => {
    await adminPut('/api/library/marks', { marks: { 'cam-a/IMG_1': 'pick' } });
    const res = await guestGet('/api/library/marks', { as: 'u_me' });
    expect(res.body.marks['cam-a/IMG_1']).toBe('pick');
  });

  it('自己的优先于摄影师的', async () => {
    await adminPut('/api/library/marks', { marks: { 'cam-a/IMG_1': 'reject' } });
    await guestPut('/api/library/marks', { marks: { 'cam-a/IMG_1': 'pick' } }, { as: 'u_me' });
    const res = await guestGet('/api/library/marks', { as: 'u_me' });
    expect(res.body.marks['cam-a/IMG_1']).toBe('pick');
  });

  it('访客的响应里没有 contrib', async () => {
    // 整张贡献表发过去等于把过滤白做了——打开开发者工具就看得见
    // 「妈妈收藏了哪些」。
    const res = await guestGet('/api/library/marks', { as: 'u_me' });
    expect(res.body.contrib).toBeUndefined();
  });

  it('showPeerMarks: true 时访客拿到的就是共编那份，行为不变', async () => {
    await setShowPeerMarks(true);
    await guestPut('/api/library/marks', { marks: { 'cam-a/IMG_1': 'pick' } }, { as: 'u_other' });
    const res = await guestGet('/api/library/marks', { as: 'u_me' });
    expect(res.body.marks['cam-a/IMG_1']).toBe('pick');
  });

  it('管理员照常拿到全部，外加整张 contrib', async () => {
    await guestPut('/api/library/marks', { marks: { 'cam-a/IMG_1': 'pick' } }, { as: 'u_other' });
    const res = await adminGet('/api/library/marks');
    expect(res.body.marks['cam-a/IMG_1']).toBe('pick');
    expect(res.body.contrib['cam-a/IMG_1'].u_other.mark).toBe('pick');
  });
});

describe('广播的按人过滤', () => {
  it('别的访客标记时，隐藏模式下的访客收不到这一帧', async () => {
    // 照抄有效标记发给她会直接泄露；只把值替换成 visibleMark、照发不误，
    // 泄露的是**时机**——她那一格在别人操作的瞬间重渲染一次，
    // 等于告诉她「刚才有人动了这张」。
    const frames = collectFrames({ as: 'u_me' });
    await guestPut('/api/library/marks', { marks: { 'cam-a/IMG_1': 'pick' } }, { as: 'u_other' });
    expect(frames.filter((f) => f.type === 'marks')).toEqual([]);
  });

  it('摄影师标记且她没碰过这张时，她收得到', async () => {
    const frames = collectFrames({ as: 'u_me' });
    await adminPut('/api/library/marks', { marks: { 'cam-a/IMG_1': 'pick' } });
    const marks = frames.filter((f) => f.type === 'marks');
    expect(marks).toHaveLength(1);
    expect(marks[0].changes['cam-a/IMG_1'].mark).toBe('pick');
  });

  it('摄影师标记但她自己碰过这张时，她收不到（她看到的仍是自己那一票）', async () => {
    await guestPut('/api/library/marks', { marks: { 'cam-a/IMG_1': 'pick' } }, { as: 'u_me' });
    const frames = collectFrames({ as: 'u_me' });
    await adminPut('/api/library/marks', { marks: { 'cam-a/IMG_1': 'reject' } });
    expect(frames.filter((f) => f.type === 'marks')).toEqual([]);
  });

  it('管理员那一侧照常收到全部', async () => {
    const frames = collectFrames({ as: 'admin' });
    await guestPut('/api/library/marks', { marks: { 'cam-a/IMG_1': 'pick' } }, { as: 'u_other' });
    expect(frames.filter((f) => f.type === 'marks')).toHaveLength(1);
  });
});
```

> `guestGet` / `guestPut` / `adminGet` / `adminPut` / `collectFrames` / `setShowPeerMarks` 是本文件需要补的辅助函数：`collectFrames` 挂一个假 listener 到会话上并收集 emit 出来的事件（照 `server/lib/session.test.js` 里假订阅者的写法）；`setShowPeerMarks` 直接调 `updateShare`。这一组 describe 的 `beforeEach` 里把该分享设成 `showPeerMarks: false`。

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run server/routes/marks.test.js -t "按人过滤"`
Expected: FAIL —— 访客拿到的是共编那份

- [ ] **Step 3: 写过滤**

`server/routes/marks.js` 顶部 import 加：

```js
import { visibleMark } from '../lib/contrib.js';
```

在 `actorOf` 下方加两个辅助函数：

```js
/**
 * 这条请求 / 这条连接看得见别人的标记吗。
 *
 * 判据写成 `!== false`：老的 `shares.json` 里 `showPeerMarks` 可能整个不存在。
 * 这一条口径必须和 `publicShare()` 里那一处**完全一致**，否则会出现
 * 「管理台显示公开、访客实际看不到」这种查都没法查的分歧。
 *
 * 管理员永远看得见全部——这个开关的语义是「只影响点击链接的客户」。
 */
function seesPeerMarks(actor) {
  if (actor?.kind !== 'user') return true;
  return actor.share?.showPeerMarks !== false;
}

/**
 * 按 actor 派生出他该看到的那份标记。
 *
 * **必须在服务端做，不能只在前端过滤**——和 viewer 角色同一个理由：
 * 前端过滤只是把东西藏起来，数据照样发到了对方的浏览器里，
 * 打开开发者工具就看得见「妈妈收藏了哪些」。
 */
function marksFor(actor, contrib) {
  const userId = actor.user.id;
  const marks = {};
  for (const [id, entry] of Object.entries(contrib)) {
    const mark = visibleMark(entry, userId);
    if (mark !== null && mark !== undefined) marks[id] = mark;
  }
  return marks;
}
```

`GET /marks` 改成：

```js
marksRouter.get('/marks', requirePerm('read'), requireSession, (req, res) => {
  const { marks, settings, marksMeta, hidden, contrib } = req.session.markStore.data;

  if (!seesPeerMarks(req.actor)) {
    // 归属角标一并不给：它会把「这张是别的客户标的」原样说出来，
    // 等于绕过刚刚做的过滤。她自己那些标记的归属就是她自己，不必说。
    return res.json({ marks: marksFor(req.actor, contrib), settings, marksMeta: {}, hidden });
  }

  // contrib 只给管理员：整张贡献表发给访客等于把过滤白做了。
  // 前端的客户维度筛选也只有管理员那一侧会用到它。
  const full = { marks, settings, marksMeta, hidden };
  if (req.actor?.kind === 'admin') full.contrib = contrib;
  res.json(full);
});
```

`PUT /marks` 里那个 `emit(...)` 换成按连接过滤的版本：

```js
      req.session.marksSeq = (req.session.marksSeq ?? 0) + 1;
      const seq = req.session.marksSeq;
      const contrib = req.session.markStore.data.contrib;

      // 每条连接单独算一帧。判据是**新旧 visibleMark 有没有变化**，
      // 不是「把值换掉照发」——后者泄露的是时机：她那一格在别人操作的
      // 瞬间重渲染一次，等于告诉她「刚才有人动了这张」。
      emitPerListener(req.session, (listener) => {
        if (seesPeerMarks(listener.actor)) {
          const changes = {};
          for (const [id, mark] of entries) changes[id] = { mark, by: actor.id, at };
          return { type: 'marks', origin: actor.id, seq, changes };
        }
        const userId = listener.actor.user.id;
        const changes = {};
        for (const [id] of entries) {
          const now = visibleMark(contrib[id], userId);
          if (now === before.get(id)) continue;   // 她看到的没变，这一帧对她不存在
          changes[id] = { mark: now ?? null, by: userId, at };
        }
        return Object.keys(changes).length === 0
          ? null                                   // null = 这条连接不发
          : { type: 'marks', origin: actor.id, seq, changes };
      });
```

> `before` 那个 Map 现在要按**每个访客**各存一份旧的 `visibleMark`，不能复用现有那份（它存的是共编 marks 的旧值，用于审计日志的 `from`）。在 `for (const [id, mark] of entries) { ... setMark ... }` **之前**，先为每条 user 连接算一份旧值：
>
> ```js
> const beforeVisible = new Map();   // listener -> Map<id, mark|null>
> for (const listener of req.session.listeners) {
>   if (seesPeerMarks(listener.actor)) continue;
>   const uid = listener.actor.user.id;
>   const snap = new Map();
>   for (const [id] of entries) snap.set(id, visibleMark(req.session.markStore.data.contrib[id], uid));
>   beforeVisible.set(listener, snap);
> }
> ```
>
> 上面 `emitPerListener` 回调里的 `before.get(id)` 相应改成 `beforeVisible.get(listener).get(id)`。

在 `server/lib/session.js` 里加 `emitPerListener`（放在 `emit` 旁边）：

```js
/**
 * 给每条连接单独算一帧再发。回调返回 `null` 表示这条连接不发。
 *
 * `emit` 是「同一帧发给所有人」，在 showPeerMarks 之前那一直成立。
 * 现在不成立了：同一次写入对不同的访客意味着不同的东西，
 * 而「有没有这一帧」本身就是要被隐藏的信息之一。
 */
export function emitPerListener(session, build) {
  for (const listener of session.listeners) {
    let event;
    try { event = build(listener); } catch (err) { console.error('[emit] 构造事件失败', err); continue; }
    if (event === null || event === undefined) continue;
    try { listener.send(event); } catch { /* 对端已经断了 */ }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/routes/marks.test.js server/lib/session.test.js`
Expected: PASS

- [ ] **Step 5: 三条门禁 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add server/routes/marks.js server/routes/marks.test.js server/lib/session.js
git commit -m "feat: 隐藏模式下按人过滤 marks —— 连广播的时机都不泄露"
```

---

### Task 21: 用户名册与归属显示

> **这个任务独立修掉一个已上报的 bug。** 客户选完照片关掉网页之后，管理员视图里
> 那些照片上的头像会变成 `?`。数据一点没丢——`marksMeta.by`（用户 id）持久化在
> `marks.json` 里，昵称持久化在 `shares/<shareId>/users.json` 里——丢的是前端手上
> **只有 `online` 这份实时名单**，从没拿到过持久名册。`Thumb.tsx` 的 `nicknameFor()`
> 只在 `s.online` 里查（第 41 行），人一离线就查不到，退化成 `'?'` 与「已离开的成员」。
>
> 所以这个任务分两半：服务端把名册发出来，前端改成从名册查昵称、`online` 只用来
> 判断在不在线。

**Files:**
- Modify: `server/routes/admin.js`、`web/src/store/session.ts`、`web/src/components/Thumb.tsx`
- Test: `server/routes/admin.test.js`（追加）、`web/src/components/Thumb.test.tsx`（追加）

**Interfaces:**
- Consumes: `listShares()` / `listUsers(shareId)`
- Produces:
  - `GET /api/admin/library-users` —— admin-only，按当前会话的 root 返回 `{ users: { id, nickname }[] }`
  - `useSession.roster: { id: string; nickname: string }[]` —— 参与过这个文件夹的所有人（含已离线），
    与 `online` 正交：`online` 只回答「在不在线」，`roster` 只回答「叫什么名字」
  - `useSession.loadRoster(): Promise<void>` —— 管理员打开库之后拉一次

- [ ] **Step 1: 写失败的测试**

在 `server/routes/admin.test.js` 末尾追加：

```js
describe('GET /api/admin/library-users', () => {
  it('把当前文件夹下所有分享的用户合并列出', async () => {
    // 筛选下拉必须列出**所有贡献过的人**，包括早就离线的——
    // 客户端手里只有一份在线名单，解析不出他们的昵称。
    const s1 = await createShare({ root: testRoot, label: '新人' });
    const s2 = await createShare({ root: testRoot, label: '父母' });
    await createUser(s1.id, '小林', 'editor');
    await createUser(s2.id, '妈妈', 'editor');

    const res = await adminGet('/api/admin/library-users');
    expect(res.status).toBe(200);
    expect(res.body.users.map((u) => u.nickname).sort()).toEqual(['妈妈', '小林']);
  });

  it('别的文件夹的分享不算进来', async () => {
    const other = await createShare({ root: '/tmp/别的文件夹' });
    await createUser(other.id, '路人', 'editor');
    const res = await adminGet('/api/admin/library-users');
    expect(res.body.users.map((u) => u.nickname)).not.toContain('路人');
  });

  it('已撤销/已过期的分享下的用户照常列出', async () => {
    // 他们的贡献还在 contrib 里，筛不出名字才是问题。
    const s = await createShare({ root: testRoot });
    await createUser(s.id, '老客户', 'editor');
    await revokeShare(s.id);
    const res = await adminGet('/api/admin/library-users');
    expect(res.body.users.map((u) => u.nickname)).toContain('老客户');
  });

  it('响应里没有令牌', async () => {
    const s = await createShare({ root: testRoot });
    await createUser(s.id, '小林', 'editor');
    const res = await adminGet('/api/admin/library-users');
    expect(JSON.stringify(res.body)).not.toContain('token');
    for (const u of res.body.users) expect(Object.keys(u).sort()).toEqual(['id', 'nickname']);
  });

  it('没有打开任何文件夹时回 400', async () => {
    const res = await adminGetWithoutSession('/api/admin/library-users');
    expect(res.status).toBe(400);
  });

  it('访客 403', async () => {
    const res = await guestGet('/api/admin/library-users');
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run server/routes/admin.test.js -t "library-users"`
Expected: FAIL，404

- [ ] **Step 3: 写路由**

`server/routes/admin.js` —— 在分享那一段之后追加：

```js
/**
 * 当前文件夹下所有分享的用户目录（规格 §7.2）。
 *
 * 客户维度的筛选下拉要列出**所有贡献过的人**，包括早就离线的、以及
 * 走另一条链接进来的。客户端手里只有一份在线名单（SSE 推的 presence），
 * 解析不出他们的昵称（README《当前行为里几条必须先知道的事》第 6 条）。
 *
 * `adminRouter.use(requireAdmin)` 已经把整个路由器保护起来了，
 * 管理员本来就读得到这些文件（审计日志页面已经在读），不新增任何权限。
 *
 * **令牌不进这个响应**，只有 id 和 nickname。
 */
adminRouter.get('/library-users', async (req, res, next) => {
  try {
    const root = currentSessionRoot(req);
    if (root === null) {
      return res.status(400).json({ error: 'no-session', message: '还没有打开任何文件夹' });
    }
    // 已撤销 / 已过期的分享**照常算进来**：他们的贡献还留在 contrib 里，
    // 筛得出记录却叫不出名字才是问题。
    const shares = (await listShares()).filter((s) => s.root === root);
    const seen = new Map();
    for (const share of shares) {
      for (const user of await listUsers(share.id)) {
        // 同一个人不可能跨分享共享 id，所以这里的去重只防同一条分享被
        // 重复列出；用 Map 而不是数组是为了让"第一条赢"这件事显式。
        if (!seen.has(user.id)) seen.set(user.id, { id: user.id, nickname: user.nickname });
      }
    }
    res.json({ users: [...seen.values()] });
  } catch (err) { next(err); }
});
```

确认 `listUsers` 已在该文件顶部从 `../lib/users.js` import。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/routes/admin.test.js`
Expected: PASS

- [ ] **Step 5: 前端存名册**

`web/src/store/session.ts` —— 加一个与 `online` 并列的字段。**两者不能合并**：
`online` 是实时的、来自 SSE presence 事件，人一走就没了；`roster` 是持久的、
来自上面那个端点，只有管理员拿得到。把昵称挂在 `online` 上正是这个 bug 的成因。

```ts
  /**
   * 参与过当前文件夹的人（含已离线的）。只有管理员会去拉。
   *
   * 与 online 正交：online 回答「在不在线」，roster 回答「叫什么名字」。
   * 照片上那个头像的昵称必须从这里查——客户关掉网页之后 online 里就没有他了，
   * 而他标过的照片还在，头像不该因此变成一个问号。
   */
  roster: { id: string; nickname: string }[];
  loadRoster: () => Promise<void>;
```

实现（`create` 的返回对象里）：

```ts
  roster: [],
  async loadRoster() {
    // 访客拿不到这个端点（admin-only），拉失败就维持空名册——
    // 昵称退回「已离开的成员」是可接受的降级，整个界面不该因此报错。
    try {
      const { users } = await getJSON<{ users: { id: string; nickname: string }[] }>(
        '/api/admin/library-users');
      set({ roster: users });
    } catch { /* 访客或未开库，保持空 */ }
  },
```

- [ ] **Step 6: 改 Thumb 的昵称解析**

`web/src/components/Thumb.tsx` 的 `nicknameFor()`（第 38–42 行）——最后那一行
从 `online` 换成 `roster`：

```ts
function nicknameFor(s: SessionState, by: string): string | null {
  if (by === 'admin') return '摄影师';
  if (s.user?.id === by) return s.user.nickname;
  // 从**名册**查，不是从 online 查：online 只有此刻连着的人，
  // 客户关掉网页之后他标过的照片还在，头像不该跟着退化成问号。
  return s.roster.find((u) => u.id === by)?.nickname ?? null;
}
```

在 `web/src/components/Thumb.test.tsx` 末尾追加，钉住这条：

```tsx
it('标记者已经离线时，头像仍然显示他的昵称而不是问号', () => {
  // 这是上报的 bug：客户选完照片关掉网页，管理员视图里他标过的照片
  // 头像变成了 '?'。marksMeta 和 users.json 都还在，只是前端查错了地方。
  useSession.setState({
    kind: 'admin',
    online: [],                                            // 人已经走了
    roster: [{ id: 'u_bride', nickname: '新娘' }],          // 但名册还记着
  });
  useMarks.setState({ marks: { IMG_1: 'pick' }, marksMeta: { IMG_1: { by: 'u_bride', at: 1 } } });

  const { getByRole } = render(<Thumb asset={ASSET} />);
  const badge = getByRole('img', { name: /最后修改/ });
  expect(badge.textContent).toBe('新');
  expect(badge.getAttribute('aria-label')).toContain('新娘');
  expect(badge.textContent).not.toBe('?');
});
```

> `render(<Thumb …>)` 的实际 props 照该测试文件里既有用例的写法来，别照抄这里的
> `ASSET` —— 上面只写了这条用例**独有**的那部分。

- [ ] **Step 7: 开库之后拉一次名册**

`web/src/store/library.ts` 的 `open()` 成功之后调 `useSession.getState().loadRoster()`。
放在 `open()` 里而不是组件的 `useEffect` 里：名册是跟着「当前打开的是哪个文件夹」
变的，挂在组件上会在每次挂载时多拉一次，而换文件夹时反而可能不拉。

- [ ] **Step 8: 三条门禁 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add server/routes/admin.js server/routes/admin.test.js \
        web/src/store/session.ts web/src/store/library.ts \
        web/src/components/Thumb.tsx web/src/components/Thumb.test.tsx
git commit -m "fix: 标记者离线后头像不该变成问号——昵称从名册查，不是从在线名单查"
```

---

### Task 22: 成员条——在线状态与点头像筛选

> **入口改过一次。** 这个任务原本是「页签下的客户维度筛选下拉」，用户后来明确要的是
> **点成员条上的头像**筛选，下拉菜单不做了。derive 层与 store 状态（Step 1–4）与入口
> 形态无关，原样保留；换掉的只是 UI 那一截。
>
> 同时补上两条用户提的：头像要**区分在线/离线**，且**离线的人仍然留在条上**——
> 现在 `PresenceBar.tsx` 只渲染 `online`，而且第 22 行 `if (online.length === 0) return null`，
> 客户一走整条成员条直接消失，他标过的照片却还在。
>
> **成员条显示谁**：在线的一律显示；离线的**只在他确实标过照片时**才留下。这样条不会
> 被从没动过手的受邀者撑长，同时保证「照片上有头像，条上一定找得到这个人」——
> 否则点不了、也对不上号。

**Files:**
- Modify: `web/src/lib/derive.ts`、`web/src/store/view.ts`、`web/src/store/marks.ts`、`web/src/store/library.ts`、`web/src/components/PresenceBar.tsx`、`web/src/components/PresenceBar.test.tsx`、`web/src/styles.css`
- Test: `web/src/lib/derive.test.ts`（追加）

**Interfaces:**
- Consumes: Task 13 的 contrib 形状、Task 21 的 `useSession.roster`
- Produces:
  - `useView.clientFilter: string | null`、`useView.setClientFilter(id)`
  - `useMarks.contrib: Contrib`（`Record<string, Record<string, { mark: Mark; at: number }>>`）
  - `derive.ts`：`filterByClient(assets, contrib, clientId, tab): Asset[]`、`countByTabForClient(assets, contrib, clientId, hidden)`、
    `barMembers(roster, online, contrib): { id: string; nickname: string; isOnline: boolean }[]`

- [ ] **Step 1: 写失败的测试**

在 `web/src/lib/derive.test.ts` 末尾追加：

```ts
describe('客户维度', () => {
  const assets = [a('IMG_1', 'c'), a('IMG_2', 'c'), a('IMG_3', 'c'), a('IMG_4', 'c')];
  const contrib = {
    IMG_1: { u_bride: { mark: 'pick' as const, at: 1 } },
    IMG_2: { u_bride: { mark: 'reject' as const, at: 2 }, u_mom: { mark: 'pick' as const, at: 9 } },
    IMG_3: { u_mom: { mark: 'pick' as const, at: 3 } },
    // IMG_4 谁都没碰过
  };
  const noHidden = new Set<string>();

  it('「全部」= 他碰过的', () => {
    expect(filterByClient(assets, contrib, 'u_bride', 'all', noHidden).map((x) => x.id))
      .toEqual(['IMG_1', 'IMG_2']);
  });

  it('「收藏」= 他那一票是 pick，哪怕后来被别人改掉了', () => {
    // 这正是「新娘收藏过的那些」这个问题的答案。按最后改动者筛的话，
    // IMG_2 的有效标记是妈妈的 pick，新娘那一票就查不到了。
    expect(filterByClient(assets, contrib, 'u_bride', 'pick', noHidden).map((x) => x.id))
      .toEqual(['IMG_1']);
    expect(filterByClient(assets, contrib, 'u_mom', 'pick', noHidden).map((x) => x.id))
      .toEqual(['IMG_2', 'IMG_3']);
  });

  it('「排除」= 他那一票是 reject', () => {
    expect(filterByClient(assets, contrib, 'u_bride', 'reject', noHidden).map((x) => x.id))
      .toEqual(['IMG_2']);
  });

  it('「未标记」= 他没碰过的', () => {
    expect(filterByClient(assets, contrib, 'u_bride', 'none', noHidden).map((x) => x.id))
      .toEqual(['IMG_3', 'IMG_4']);
  });

  it('隐藏的照片在任何客户维度下都不出现', () => {
    expect(filterByClient(assets, contrib, 'u_bride', 'all', new Set(['IMG_1'])).map((x) => x.id))
      .toEqual(['IMG_2']);
  });

  it('筛了人之后「全部」= 收藏 + 排除，不再等于整库', () => {
    // 看起来像 bug，其实是需求要的东西：如果「全部」不受筛选影响，
    // 那个页签下的下拉就是个摆设。文案上那个 tab 会改叫「新娘碰过的 N」。
    const counts = countByTabForClient(assets, contrib, 'u_bride', noHidden);
    expect(counts.all).toBe(counts.pick + counts.reject);
    expect(counts).toEqual({ all: 2, pick: 1, reject: 1, none: 2, hidden: 0 });
  });

  it('摄影师自己也能被筛（userId 是字面量 admin）', () => {
    const withAdmin = { IMG_4: { admin: { mark: 'pick' as const, at: 1 } } };
    expect(filterByClient(assets, withAdmin, 'admin', 'pick', noHidden).map((x) => x.id))
      .toEqual(['IMG_4']);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run web/src/lib/derive.test.ts -t "客户维度"`
Expected: FAIL，`filterByClient is not defined`

- [ ] **Step 3: 加 derive 函数**

`web/src/lib/derive.ts` 末尾追加：

```ts
export type Contrib = Record<string, Record<string, { mark: Mark; at: number }> | undefined>;

/**
 * 按某个人的贡献筛选（规格 §7.1）。
 *
 * - 全部 = 他碰过的（`contrib[id][who]` 存在）
 * - 收藏 / 排除 = 他那一票是 pick / reject
 * - 未标记 = 他没碰过的
 *
 * **筛了人之后「全部」不再等于整库**，而是等于「收藏 + 排除」。这不是 bug：
 * 如果「全部」不受筛选影响，那个页签下的下拉就是个摆设。数字对不上的疑虑
 * 由文案消解——筛了人之后那个 tab 显示成「XX 碰过的 N」，不再叫「全部」。
 *
 * 隐藏的照片在任何客户维度下都不出现：隐藏是摄影师的操作，没有客户维度。
 */
export function filterByClient(
  assets: Asset[], contrib: Contrib, who: string, tab: FilterTab,
  hidden: ReadonlySet<string>,
): Asset[] {
  return assets.filter((a) => {
    if (hidden.has(a.id)) return false;
    const mine = contrib[a.id]?.[who];
    if (tab === 'none') return mine === undefined;
    if (mine === undefined) return false;
    if (tab === 'all') return true;
    return mine.mark === tab;
  });
}

/** 客户维度下五个 tab 的数量。一次遍历算完，口径与 filterByClient 完全一致。 */
export function countByTabForClient(
  assets: Asset[], contrib: Contrib, who: string, hidden: ReadonlySet<string>,
): Record<FilterTab, number> {
  const out: Record<FilterTab, number> = { all: 0, pick: 0, reject: 0, none: 0, hidden: 0 };
  for (const a of assets) {
    if (hidden.has(a.id)) { out.hidden++; continue; }
    const mine = contrib[a.id]?.[who];
    if (mine === undefined) { out.none++; continue; }
    out.all++;
    if (mine.mark === 'pick') out.pick++;
    else out.reject++;
  }
  return out;
}
```

- [ ] **Step 4: 在 store 里加状态**

`web/src/store/view.ts` —— `INITIAL` 里加 `clientFilter: null,`，接口加：

```ts
  /**
   * 按客户维度筛选。null = 不筛。仅管理员用得到。
   *
   * **这个筛选只改变看到什么，不改变标记的身份**：筛着「新娘」的时候按 P，
   * 记进 contrib 的仍然是 admin（你自己）。没有任何入口能代替别人投票——
   * 那会直接毁掉审计的价值。
   */
  clientFilter: string | null;
  setClientFilter: (id: string | null) => void;
```

```ts
  // 和 setTab / setDirFilter 同一条规矩：改变可见集合就要清掉可能悬空的指针。
  setClientFilter: (clientFilter) =>
    set({ clientFilter, selection: new Set(), anchor: null, cursor: null, lightbox: null }),
```

`web/src/store/marks.ts` —— 加 `contrib: {} as Contrib`，`load` 再多接一个参数 `contrib?: unknown` 并 sanitize（形状校验照 `sanitizeMeta` 的写法：只放行 `mark` 是 `'pick'|'reject'`、`at` 是有限数的条目）。`setMark` 的乐观更新里同步维护它（写入 `{ [self]: { mark, at } }`，取消时删掉自己那条）。

`web/src/store/library.ts` —— `MarksResult` 加 `contrib?: unknown`，`open()` 里 `load(loaded.marks, loaded.marksMeta, loaded.hidden, loaded.contrib)`。

- [ ] **Step 5: 算「条上显示谁」**

`web/src/lib/derive.ts` 末尾追加。**这是个纯函数**，因为「在线的一律显示、离线的
只在标过照片时才留」这条规则单看渲染结果是看不出对错的——离线且没标过的人不显示，
和这个人压根不存在，在屏幕上长得一模一样。

```ts
/**
 * 成员条上该显示谁（规格 §7.6）。
 *
 * 在线的一律显示；离线的只在 contrib 里确实有过标记时才留下。这样一条用久了的
 * 分享不会被十几个从没动过手的受邀者撑长，同时保证「照片上有头像，条上一定找得到
 * 这个人」——照片上的头像是可点的筛选入口，找不到对应的人就是个死链接。
 *
 * 排序：在线的在前，同组内按昵称，让条不会因为谁上下线而整个跳动。
 */
export function barMembers(
  roster: { id: string; nickname: string }[],
  online: { id: string }[],
  contrib: Contrib,
): { id: string; nickname: string; isOnline: boolean }[] {
  const onlineIds = new Set(online.map((u) => u.id));
  const contributed = new Set<string>();
  for (const perUser of Object.values(contrib)) {
    for (const id of Object.keys(perUser)) contributed.add(id);
  }
  return roster
    .filter((u) => onlineIds.has(u.id) || contributed.has(u.id))
    .map((u) => ({ ...u, isOnline: onlineIds.has(u.id) }))
    .sort((a, b) =>
      a.isOnline === b.isOnline ? a.nickname.localeCompare(b.nickname) : (a.isOnline ? -1 : 1));
}
```

在 `web/src/lib/derive.test.ts` 末尾追加：

```ts
describe('barMembers', () => {
  const roster = [
    { id: 'u_bride', nickname: '新娘' },
    { id: 'u_mom', nickname: '妈妈' },
    { id: 'u_idle', nickname: '没动过手的' },
  ];
  const contrib = { IMG_1: { u_mom: { mark: 'pick' as const, at: 1 } } };

  it('在线的一律显示，哪怕一张都没标过', () => {
    const out = barMembers(roster, [{ id: 'u_idle' }], {});
    expect(out.map((u) => u.id)).toEqual(['u_idle']);
    expect(out[0].isOnline).toBe(true);
  });

  it('离线但标过照片的仍然留在条上', () => {
    // 上报的 bug 的另一半：客户关掉网页之后整条成员条都没了，
    // 而他标过的照片还在，管理员没有任何入口能按他筛。
    const out = barMembers(roster, [], contrib);
    expect(out.map((u) => u.id)).toEqual(['u_mom']);
    expect(out[0].isOnline).toBe(false);
  });

  it('离线且没标过的不显示，条不会被受邀者撑长', () => {
    expect(barMembers(roster, [], {}).map((u) => u.id)).toEqual([]);
  });

  it('在线的排在离线的前面', () => {
    const out = barMembers(roster, [{ id: 'u_bride' }], contrib);
    expect(out.map((u) => u.id)).toEqual(['u_bride', 'u_mom']);
  });
});
```

- [ ] **Step 6: 改 PresenceBar**

`web/src/components/PresenceBar.tsx` 整个换掉渲染部分。三处变化：数据源从 `online`
换成 `barMembers(...)`；离线的加一个 `presence-off` class；整个头像变成可点的筛选按钮。

```tsx
export function PresenceBar() {
  const online = useSession((s) => s.online);
  const roster = useSession((s) => s.roster);
  const kind = useSession((s) => s.kind);
  const contrib = useMarks((s) => s.contrib);
  const clientFilter = useView((s) => s.clientFilter);
  const setClientFilter = useView((s) => s.setClientFilter);

  const members = useMemo(() => barMembers(roster, online, contrib), [roster, online, contrib]);
  if (members.length === 0) return null;

  return (
    <div className="presence-bar">
      {members.map((u) => {
        const active = clientFilter === u.id;
        return (
          <button
            key={u.id}
            type="button"
            // 筛选是管理员专属：访客点了也没有意义，服务端也不会给他别人的 contrib。
            // 第二道防线是「组件干脆不渲染」，所以这里不是置灰而是换成静态 span。
            className={[
              'presence-item',
              u.isOnline ? '' : 'presence-off',
              active ? 'presence-active' : '',
            ].filter(Boolean).join(' ')}
            aria-pressed={active}
            aria-label={`${u.nickname}${u.isOnline ? '' : '（已离线）'}${active ? ' · 正在按他筛选' : ' · 点击只看他标过的'}`}
            title={`${u.nickname}${u.isOnline ? '' : '（已离线）'}`}
            onClick={() => setClientFilter(active ? null : u.id)}
          >
            <span className="presence-dot" style={{ background: avatarColor(u.id) }} aria-hidden="true">
              {avatarInitial(u.nickname)}
            </span>
            <span className="presence-name">{u.nickname}</span>
          </button>
        );
      })}
    </div>
  );
}
```

> 访客那一侧：`kind !== 'admin'` 时**不要**渲染成按钮（三道防线的第二道是「干脆不渲染」，
> 不是置灰）。用同样的 class 渲染一个 `<span>`，视觉一致但点不了。这一条按该文件既有的
> 访客/管理员分支写法来。

在 `web/src/components/PresenceBar.test.tsx` 末尾追加：

```tsx
it('离线成员仍然显示，并带离线样式', () => {
  useSession.setState({ kind: 'admin', online: [], roster: [{ id: 'u_bride', nickname: '新娘' }] });
  useMarks.setState({ contrib: { IMG_1: { u_bride: { mark: 'pick', at: 1 } } } });
  const { getByRole } = render(<PresenceBar />);
  const btn = getByRole('button', { name: /新娘/ });
  expect(btn.className).toContain('presence-off');
});

it('点头像按这个人筛选，再点一下取消', () => {
  useSession.setState({ kind: 'admin', online: [{ id: 'u_bride', nickname: '新娘' }], roster: [{ id: 'u_bride', nickname: '新娘' }] });
  useMarks.setState({ contrib: {} });
  const { getByRole } = render(<PresenceBar />);
  const btn = getByRole('button', { name: /新娘/ });

  fireEvent.click(btn);
  expect(useView.getState().clientFilter).toBe('u_bride');

  fireEvent.click(btn);
  expect(useView.getState().clientFilter).toBeNull();
});
```

- [ ] **Step 7: 加样式**

`web/src/styles.css` 末尾追加：

```css
.presence-item { display: inline-flex; align-items: center; gap: 6px;
  background: none; border: none; padding: 2px 6px; border-radius: 999px;
  cursor: pointer; color: inherit; font: inherit; }
.presence-item:hover { background: var(--bg-2); }
/* 离线：整体压暗 + 头像去饱和。不用灰色纯色块——颜色是按 userId 派生的身份标识，
   换掉颜色等于换了个人。 */
.presence-off { opacity: .5; }
.presence-off .presence-dot { filter: grayscale(.6); }
/* 正在按他筛选：描一圈，比换背景色更不容易和「在线」这个状态混淆。 */
.presence-active { outline: 2px solid var(--accent); outline-offset: 1px; }
```

- [ ] **Step 8: 跑测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 9: 三条门禁 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add web/src/lib/derive.ts web/src/lib/derive.test.ts web/src/store/view.ts \
        web/src/store/marks.ts web/src/store/library.ts \
        web/src/components/PresenceBar.tsx web/src/components/PresenceBar.test.tsx \
        web/src/styles.css
git commit -m "feat: 点成员条头像按客户筛选，离线的人也留在条上"
```

---

## 阶段 I：文档（Task 23）

### Task 23: README 与验收清单

**Files:**
- Modify: `README.md`、`docs/acceptance-collaborative.md`

**Interfaces:**
- Consumes: 前 22 个任务的全部行为
- Produces: 无代码接口

- [ ] **Step 1: 改 README**

按下面这份清单逐条改。**每一条都必须是实际行为的陈述，不是设计意图的复述**——这是本仓库 README 一贯的口径。

1. 《快捷键》表加两行：`H` = 隐藏 / 取消隐藏（仅摄影师）、`5` = 已隐藏（仅摄影师）。
2. 《鼠标与键盘怎么标记》加一段隐藏：只有摄影师能隐、对所有人生效、已标记的不能隐（一批里混着的会被跳过并提示）、在「已隐藏」里打标记会自动取消隐藏、**它不删文件**。
3. 《数据存放》里的 `marks.json` 说明加上：现在含 `hidden` 与 `contrib` 两张平行表，**`contrib` 里带 userId**（`u_` 开头的随机串），不含昵称、不含令牌——交付文件夹给客户时它会跟着走。
4. 新增《刷新》一节：原地重扫、不退回选择器、消失照片的标记留在文件里、只有摄影师能刷新、扫描失败保留旧资产表。
5. 《协同选片》加一节《客户能看到谁的标记》：`showPeerMarks` 开关的两档语义、默认公开、改完立刻生效、**服务端强制**（不是前端藏起来）、以及连广播时机都过滤掉这件事。
6. 同节加《按客户维度筛选》：能回答「新娘收藏过的那些」而不是「最后一次是新娘改的」；筛了人之后「全部」变成「碰过的」、等于收藏 + 排除；筛选不改变标记身份。
7. 《当前行为里几条必须先知道的事》**改第 4 条**——「不做按用户分层的标记」现在只对**有效标记**成立了：共编那份仍然是一份、后写覆盖，但每个人的每一票都留在 `contrib` 里。同时**新增一条**：取消标记会回退到上一个人那一票（这是本次唯一改变的收敛行为）。
8. 《启动》一节加一句 Windows：C 盘以外的盘符现在会被枚举成可浏览的根。
9. 新增一句说明拖拽：把文件夹拖进选择器**只会帮你定位**，不会替你打开——浏览器从不把文件夹的完整路径交给网页。
10. 《测试》一节的用例数字要按实际跑出来的更新（`npm test` 输出里那两个数）。

- [ ] **Step 2: 改验收清单**

`docs/acceptance-collaborative.md` 追加两条**必须在两台真实设备之间**执行的人工验收：

```markdown
### N. 隐藏模式下客户看不到另一个客户的标记

自动化测试只能证明服务端过滤了，**证明不了浏览器里真的没有**。

1. 同一个文件夹挂两条链接，把两条都设成「隐藏客户标记」
2. 访客电脑 A 走链接 1 进来，访客电脑 B 走链接 2 进来
3. A 收藏三张
4. **在 B 上打开开发者工具的网络面板**，刷新页面，逐条看 `/api/library/marks`
   的响应体和 SSE 流：A 那三张的 id 一次都不该出现
5. B 屏幕上那三张仍然是未标记
6. 摄影师这一侧看得到全部六张（A 三张 + 自己的）

### N+1. 取消标记会回退到上一个人那一票

1. 摄影师收藏 IMG_0001
2. 客户把它改成排除
3. 客户再点一次取消
4. **摄影师那一侧 IMG_0001 应该回到「收藏」**，归属角标写的是摄影师

这一条是本次唯一被改变的收敛行为，改造前它会变成「未标记」。
```

- [ ] **Step 3: 三条门禁 + 提交**

```bash
npm test && npx tsc --noEmit && npm run build
git add README.md docs/acceptance-collaborative.md
git commit -m "docs: README 与验收清单补上五条改进"
```

---

## 自查

写完之后对着规格逐节核对的结果：

**规格覆盖** —— 规格九节全部有对应任务：§1 数据模型（T13、T14、T19）、§2 访客看到什么（T20）、§3 文件夹可达性（T1–T6）、§4 缩放与刷新（T7、T8、T11、T12）、§5 大图（T9、T10）、§6 隐藏（T15–T18）、§7 客户维度（T21、T22）、§8 错误处理（散在各任务的测试里）、§9 测试（每个任务的 Step 1）、§10 文档（T23）。

**三处需要执行者注意的已知不确定**：

1. **辅助函数名**。多个任务的测试代码里用了 `adminPut` / `guestGet` / `stubJSON` / `flushPromises` / `a(id, dir)` 这类名字，它们是各测试文件**已有**的辅助函数。写测试前先打开那个文件确认实际叫什么，不一致就用实际的那个——不要新建一份同名的。
2. **`collectFrames` 与 `emitToShare` 需要新写**（T20 / T19）。前者照 `server/lib/session.test.js` 里假订阅者的写法，后者照 `server/lib/presence.js` 里给单条分享发事件的写法。
3. **T22 Step 6 的 `App.tsx` 那段 memo 绕了一圈**（先算可见 id 集合，再把补集当作 hidden 传给 `filterGroups`）。这么写是为了复用 `filterGroups` 的「一串连拍不会被中间几张切断」那条逻辑，而不是再写一份。如果实现时发现更直白的写法，**前提是保住那条性质**——它有专门的用例（`derive.test.ts` 里「先分组再过滤」那几条）。

---

## 执行

**Plan complete and saved to `docs/superpowers/plans/2026-07-31-culling-improvements.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
