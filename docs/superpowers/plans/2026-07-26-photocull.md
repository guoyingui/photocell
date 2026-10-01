# PhotoCull 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个本机运行的 web 选图程序，摄影师选定含 RAW+JPG 配对照片的文件夹，高效浏览缩略图、三态标记、连拍折叠，最后把收藏照片的 RAW 单独导出。

**Architecture:** 单进程 Node 服务只监听 `127.0.0.1`，托管 Vite 构建的 React 前端并提供 JSON/图片 API。服务端用 `sharp` 生成缩略图并落盘缓存，用 `exifr` 只解析 EXIF 段拿拍摄时间；前端用行级虚拟滚动 + 优先级请求队列 + 滚出视口即 abort + blob LRU 来保证任意滚动速度下都不卡顿不泄漏。选片状态是照片文件夹里的一个 JSON 文件，没有数据库。

**Tech Stack:** Node 22 (ESM) · Express 5 · sharp · exifr · p-limit · Vite 6 · React 19 · TypeScript · zustand · @tanstack/react-virtual · Vitest

完整需求见 `docs/superpowers/specs/2026-07-26-photo-culling-design.md`。计划与 spec 冲突时以 spec 为准。

## Global Constraints

- **ESM only.** 根 `package.json` 设 `"type": "module"`，所有文件用 `import`，禁止 `require`。
- **服务只绑 `127.0.0.1`**，端口 5183，被占用则顺延到 5184…5199。绝不使用 `0.0.0.0`。
- **客户端永不传文件路径给图片接口。** `/api/thumb` 与 `/api/original` 只接受 `id`（资产 ID），服务端在内存资产表里查出真实路径。接受路径的接口（目录浏览、打开文件夹、导出目标）一律先过 `assertWithin()`。
- **资产 ID = POSIX 相对目录 + `/` + stem**，根目录下的文件 ID 就是 stem。例：`cam-a/IMG_1234`、`IMG_0001`。路径分隔符在任何平台都用 `/`。
- **标记三态 `pick` / `reject` / 未标记**；未标记不写入 `marks.json`。
- **所有测试用 Vitest**，测试文件与被测文件同目录，命名 `<name>.test.js` / `<name>.test.ts`。
- **macOS 陷阱：** `os.tmpdir()` 返回 `/var/folders/...`，而 `/tmp` 是 `/private/tmp` 的符号链接。所有测试临时目录在使用前必须 `await fs.realpath()`，否则 `isWithin` 断言会假失败。
- **Express 5 通配路由语法变了**：用 `app.get('/*splat', …)`，不是 `app.get('*', …)`。写成 `'*'` 会在启动时抛 `PathError`。
- 中文文案直接写在代码里，不做 i18n。
- 每个任务结束必须提交，commit message 用 `feat:` / `test:` / `chore:` 前缀。

---

## File Structure

```
photocull/
├─ package.json                    单包，无 workspace
├─ vite.config.js                  root: 'web'，构建到 server/public
├─ vitest.config.js
├─ .gitignore
├─ server/
│  ├─ index.js                     启动、装配路由、托管前端、开浏览器
│  ├─ public/                      Vite 构建产物（gitignore）
│  ├─ lib/
│  │  ├─ safepath.js               isWithin / realpathDeep / assertWithin
│  │  ├─ scan.js                   pairEntries(纯) + walk(IO) + scanFolder
│  │  ├─ meta.js                   readMeta / readAllMeta（exifr，并发受限）
│  │  ├─ store.js                  marks.json 原子读写 + 防抖 store
│  │  ├─ thumbs.js                 cacheKey(纯) + getThumb（sharp + 磁盘缓存）
│  │  ├─ bake.js                   后台烘焙队列
│  │  ├─ transfer.js               planTarget / copyVerified / moveVerified / runExport
│  │  ├─ csv.js                    csvCell / csvRow
│  │  └─ session.js                当前打开的库（单例）
│  └─ routes/
│     ├─ fs.js                     GET /roots /list, POST /mkdir
│     ├─ library.js                POST /open, GET /assets /meta/stream /bake/stream
│     ├─ marks.js                  GET /, PUT /, PUT /settings
│     ├─ image.js                  GET /api/thumb, GET /api/original
│     └─ export.js                 POST /, GET /:jobId/stream, POST /:jobId/cancel
└─ web/
   ├─ index.html
   └─ src/
      ├─ main.tsx  ·  App.tsx  ·  types.ts  ·  styles.css
      ├─ lib/
      │  ├─ bursts.ts              groupBursts（纯函数）
      │  ├─ thumbQueue.ts          优先级队列 + abort + 并发闸门
      │  ├─ blobCache.ts           LRU + revokeObjectURL
      │  └─ api.ts                 fetch 封装
      ├─ store/
      │  ├─ library.ts             assets / metas / 加载阶段
      │  ├─ marks.ts               标记 + 撤销栈
      │  └─ view.ts                筛选 tab / 目录过滤 / 阈值 / 选中项
      └─ components/
         ├─ FolderPicker.tsx  ·  TopBar.tsx  ·  Sidebar.tsx
         ├─ Grid.tsx  ·  StackCell.tsx  ·  Thumb.tsx  ·  ExpandedRow.tsx
         ├─ Lightbox.tsx  ·  ExportPanel.tsx  ·  Toast.tsx
```

**责任边界：** 纯逻辑（配对、分组、冲突判定、CSV、LRU、队列）全部与 IO 隔离，单独文件、单独测试。IO 层薄到不值得测。React 组件不写业务逻辑，只消费 store 和纯函数。

---

## Task 1: 项目脚手架与路径安全边界

**Files:**
- Create: `package.json`, `.gitignore`, `vitest.config.js`
- Create: `server/lib/safepath.js`
- Test: `server/lib/safepath.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `isWithin(parent: string, child: string): boolean`
  - `realpathDeep(p: string): Promise<string>`
  - `assertWithin(roots: string[], candidate: string): Promise<string>` — 返回解析后的真实绝对路径，越界抛 `SafePathError`
  - `class SafePathError extends Error`

- [ ] **Step 1: 初始化仓库与依赖**

```bash
cd /Users/guoyg/WebstormProject/选图程序
git init
npm init -y
npm pkg set type=module private=true name=photocull version=1.0.0
npm pkg delete main
npm install express sharp exifr p-limit open
npm install -D vitest vite @vitejs/plugin-react typescript @types/react @types/react-dom concurrently
npm install react react-dom zustand @tanstack/react-virtual
```

不锁定版本号，装最新的。装完把实际版本记进 commit。

- [ ] **Step 2: 写 `.gitignore`**

```
node_modules/
server/public/
.DS_Store
*.log
.photocull/
```

- [ ] **Step 3: 写 `vitest.config.js`**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.js', 'web/src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
});
```

- [ ] **Step 4: 加 npm scripts**

```bash
npm pkg set scripts.test="vitest run"
npm pkg set scripts.test:watch="vitest"
npm pkg set scripts.dev:server="node --watch server/index.js"
npm pkg set scripts.dev:web="vite"
npm pkg set scripts.dev="concurrently -n server,web -c blue,green \"npm run dev:server\" \"npm run dev:web\""
npm pkg set scripts.build="vite build"
npm pkg set scripts.start="npm run build && node server/index.js"
```

- [ ] **Step 5: 写失败的测试 `server/lib/safepath.test.js`**

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isWithin, realpathDeep, assertWithin, SafePathError } from './safepath.js';

describe('isWithin', () => {
  it('子路径在父路径内', () => {
    expect(isWithin('/a', '/a/b')).toBe(true);
  });
  it('自身算在内', () => {
    expect(isWithin('/a', '/a')).toBe(true);
  });
  it('多级子路径在内', () => {
    expect(isWithin('/a', '/a/b/c/d.jpg')).toBe(true);
  });
  it('拒绝 .. 穿越', () => {
    expect(isWithin('/a', '/a/../b')).toBe(false);
  });
  it('拒绝共同前缀的兄弟目录', () => {
    // 这是最容易写错的一条：字符串 startsWith 会误判 /ab 在 /a 内
    expect(isWithin('/a', '/ab')).toBe(false);
  });
  it('拒绝父目录', () => {
    expect(isWithin('/a/b', '/a')).toBe(false);
  });
  it('拒绝完全无关的路径', () => {
    expect(isWithin('/Users/me/photos', '/etc/passwd')).toBe(false);
  });
});

describe('realpathDeep', () => {
  let tmp;
  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sp-')));
  });
  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('已存在的路径直接解析', async () => {
    expect(await realpathDeep(tmp)).toBe(tmp);
  });

  it('多级尚不存在的路径也能解析出绝对路径', async () => {
    const target = path.join(tmp, 'a', 'b', 'c');
    expect(await realpathDeep(target)).toBe(target);
  });

  it('穿过符号链接后返回真实位置', async () => {
    const real = path.join(tmp, 'real');
    const link = path.join(tmp, 'link');
    await fs.mkdir(real);
    await fs.symlink(real, link);
    expect(await realpathDeep(path.join(link, 'x'))).toBe(path.join(real, 'x'));
  });
});

describe('assertWithin', () => {
  let tmp, outside;
  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sp-root-')));
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sp-out-')));
    await fs.mkdir(path.join(tmp, 'sub'));
  });
  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('放行根目录内的路径并返回真实路径', async () => {
    const got = await assertWithin([tmp], path.join(tmp, 'sub'));
    expect(got).toBe(path.join(tmp, 'sub'));
  });

  it('放行尚不存在但将落在根内的路径', async () => {
    const got = await assertWithin([tmp], path.join(tmp, 'new', 'dir'));
    expect(got).toBe(path.join(tmp, 'new', 'dir'));
  });

  it('拒绝 ../ 穿越', async () => {
    await expect(assertWithin([tmp], path.join(tmp, '..', 'evil')))
      .rejects.toBeInstanceOf(SafePathError);
  });

  it('拒绝根外的绝对路径', async () => {
    await expect(assertWithin([tmp], '/etc/passwd'))
      .rejects.toBeInstanceOf(SafePathError);
  });

  it('拒绝指向根外的符号链接', async () => {
    const link = path.join(tmp, 'escape');
    await fs.symlink(outside, link);
    await expect(assertWithin([tmp], link))
      .rejects.toBeInstanceOf(SafePathError);
  });

  it('多个根中任一命中即放行', async () => {
    const got = await assertWithin([outside, tmp], path.join(tmp, 'sub'));
    expect(got).toBe(path.join(tmp, 'sub'));
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run server/lib/safepath.test.js`
Expected: FAIL — `Failed to resolve import "./safepath.js"`

- [ ] **Step 7: 实现 `server/lib/safepath.js`**

```js
import fs from 'node:fs/promises';
import path from 'node:path';

export class SafePathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SafePathError';
    this.status = 403;
  }
}

/**
 * child 是否落在 parent 之内（含 parent 自身）。
 * 用 path.relative 而不是 startsWith —— 后者会把 /ab 误判成在 /a 内。
 */
export function isWithin(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}

/**
 * 解析真实路径。路径可以尚不存在（导出时要新建目录），
 * 此时向上找到最近的存在祖先做 realpath，再把剩余段拼回去。
 */
export async function realpathDeep(p) {
  const abs = path.resolve(p);
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      const real = await fs.realpath(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = path.dirname(cur);
      if (parent === cur) throw new SafePathError(`无法解析路径：${abs}`);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * 断言 candidate 落在 roots 中至少一个之内，返回解析后的真实路径。
 * 所有接受客户端路径的接口都必须先过这里。
 */
export async function assertWithin(roots, candidate) {
  if (typeof candidate !== 'string' || candidate === '') {
    throw new SafePathError('路径不能为空');
  }
  const real = await realpathDeep(candidate);
  const realRoots = await Promise.all(roots.map((r) => realpathDeep(r)));
  if (!realRoots.some((r) => isWithin(r, real))) {
    throw new SafePathError(`路径超出允许范围：${candidate}`);
  }
  return real;
}
```

- [ ] **Step 8: 运行测试确认全部通过**

Run: `npx vitest run server/lib/safepath.test.js`
Expected: PASS，16 个用例全绿

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "feat: 项目脚手架与路径安全边界"
```

---

## Task 2: 扫描与配对

**Files:**
- Create: `server/lib/scan.js`
- Test: `server/lib/scan.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `RAW_EXTS: Set<string>` / `JPG_EXTS: Set<string>`（均为小写、不含点）
  - `pairEntries(entries: Entry[]): {assets: Asset[], warnings: string[], skippedFiles: number}` — 纯函数
    - `Entry = { path: string /* POSIX 相对路径 */, size: number, mtimeMs: number }`
    - `Asset = { id, dir, stem, raws: string[], jpg: string|null, jpgSize: number, jpgMtimeMs: number }`
      - `raws`/`jpg` 是**文件名**（不含目录），`dir` 为 POSIX 相对目录，根目录时是 `''`
  - `walk(root: string, opts?: {maxDepth?: number, onBatch?: (n: number) => void}): Promise<{entries: Entry[], warnings: string[]}>`
  - `scanFolder(root: string, opts?): Promise<{assets, warnings, skippedFiles}>`

- [ ] **Step 1: 写失败的测试 `server/lib/scan.test.js`**

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pairEntries, walk, scanFolder, RAW_EXTS, JPG_EXTS } from './scan.js';

const e = (p, size = 100, mtimeMs = 1000) => ({ path: p, size, mtimeMs });

describe('pairEntries', () => {
  it('同目录同 stem 的 RAW 与 JPG 配成一个资产', () => {
    const { assets } = pairEntries([e('IMG_1234.CR3'), e('IMG_1234.JPG')]);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      id: 'IMG_1234', dir: '', stem: 'IMG_1234',
      raws: ['IMG_1234.CR3'], jpg: 'IMG_1234.JPG',
    });
  });

  it('扩展名大小写不敏感', () => {
    const { assets } = pairEntries([e('a.cr3'), e('a.jpeg')]);
    expect(assets[0].raws).toEqual(['a.cr3']);
    expect(assets[0].jpg).toBe('a.jpeg');
  });

  it('stem 大小写不同也能配对，ID 取首次出现的写法', () => {
    const { assets } = pairEntries([e('IMG_1.CR3'), e('img_1.JPG')]);
    expect(assets).toHaveLength(1);
    expect(assets[0].id).toBe('IMG_1');
  });

  it('不同子目录的同名文件不撞车', () => {
    const { assets } = pairEntries([
      e('cam-a/IMG_1234.CR3'), e('cam-a/IMG_1234.JPG'),
      e('cam-b/IMG_1234.CR3'), e('cam-b/IMG_1234.JPG'),
    ]);
    expect(assets).toHaveLength(2);
    expect(assets.map((a) => a.id).sort()).toEqual(['cam-a/IMG_1234', 'cam-b/IMG_1234']);
  });

  it('多点文件名只剥最后一个扩展名', () => {
    const { assets } = pairEntries([e('2026.07.26_shot.CR3'), e('2026.07.26_shot.JPG')]);
    expect(assets).toHaveLength(1);
    expect(assets[0].stem).toBe('2026.07.26_shot');
  });

  it('一个资产可以带多个 RAW，按字典序排列', () => {
    const { assets } = pairEntries([e('x.DNG'), e('x.CR3'), e('x.JPG')]);
    expect(assets[0].raws).toEqual(['x.CR3', 'x.DNG']);
  });

  it('只有 RAW 的孤儿也产出资产，jpg 为 null', () => {
    const { assets } = pairEntries([e('orphan.NEF')]);
    expect(assets[0]).toMatchObject({ id: 'orphan', jpg: null, raws: ['orphan.NEF'] });
  });

  it('只有 JPG 的孤儿也产出资产，raws 为空数组', () => {
    const { assets } = pairEntries([e('solo.JPG', 555, 42)]);
    expect(assets[0]).toMatchObject({ id: 'solo', raws: [], jpg: 'solo.JPG' });
    expect(assets[0].jpgSize).toBe(555);
    expect(assets[0].jpgMtimeMs).toBe(42);
  });

  it('同 stem 多个 JPG 时取字典序第一个并记警告', () => {
    const { assets, warnings } = pairEntries([e('a.jpg'), e('a.JPEG')]);
    expect(assets[0].jpg).toBe('a.JPEG');
    expect(warnings.some((w) => w.includes('a'))).toBe(true);
  });

  it('非照片扩展名被跳过并计数', () => {
    const { assets, skippedFiles } = pairEntries([e('note.txt'), e('a.CR3'), e('clip.MOV')]);
    expect(assets).toHaveLength(1);
    expect(skippedFiles).toBe(2);
  });

  it('无扩展名的文件被跳过', () => {
    const { assets, skippedFiles } = pairEntries([e('README')]);
    expect(assets).toHaveLength(0);
    expect(skippedFiles).toBe(1);
  });

  it('结果按 id 稳定排序', () => {
    const { assets } = pairEntries([e('b/2.CR3'), e('a/1.CR3'), e('b/1.CR3')]);
    expect(assets.map((a) => a.id)).toEqual(['a/1', 'b/1', 'b/2']);
  });

  it('空输入返回空结果', () => {
    expect(pairEntries([])).toEqual({ assets: [], warnings: [], skippedFiles: 0 });
  });
});

describe('扩展名表', () => {
  it('覆盖主流相机 RAW', () => {
    for (const ext of ['cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'dng', 'pef', 'srw']) {
      expect(RAW_EXTS.has(ext)).toBe(true);
    }
  });
  it('JPG 三种写法都认', () => {
    expect([...JPG_EXTS].sort()).toEqual(['jpe', 'jpeg', 'jpg']);
  });
});

describe('walk', () => {
  let tmp;
  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scan-')));
    await fs.mkdir(path.join(tmp, 'cam-a'), { recursive: true });
    await fs.mkdir(path.join(tmp, '.photocull', 'thumbs'), { recursive: true });
    await fs.mkdir(path.join(tmp, '.hidden'), { recursive: true });
    await fs.mkdir(path.join(tmp, '__MACOSX'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'root.JPG'), 'x');
    await fs.writeFile(path.join(tmp, 'cam-a', 'IMG_1.CR3'), 'xx');
    await fs.writeFile(path.join(tmp, '.photocull', 'thumbs', 'cached.webp'), 'x');
    await fs.writeFile(path.join(tmp, '.hidden', 'secret.JPG'), 'x');
    await fs.writeFile(path.join(tmp, '__MACOSX', 'junk.JPG'), 'x');
  });
  afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('递归收集文件并输出 POSIX 相对路径', async () => {
    const { entries } = await walk(tmp);
    const paths = entries.map((x) => x.path).sort();
    expect(paths).toEqual(['cam-a/IMG_1.CR3', 'root.JPG']);
  });

  it('跳过 .photocull / 隐藏目录 / __MACOSX', async () => {
    const { entries } = await walk(tmp);
    expect(entries.some((x) => x.path.includes('.photocull'))).toBe(false);
    expect(entries.some((x) => x.path.includes('.hidden'))).toBe(false);
    expect(entries.some((x) => x.path.includes('__MACOSX'))).toBe(false);
  });

  it('带上 size 与 mtimeMs', async () => {
    const { entries } = await walk(tmp);
    const one = entries.find((x) => x.path === 'cam-a/IMG_1.CR3');
    expect(one.size).toBe(2);
    expect(one.mtimeMs).toBeGreaterThan(0);
  });

  it('超过深度上限时停止下探并记警告', async () => {
    const { entries, warnings } = await walk(tmp, { maxDepth: 0 });
    expect(entries.map((x) => x.path)).toEqual(['root.JPG']);
    expect(warnings.some((w) => w.includes('深度'))).toBe(true);
  });

  it('不跟随目录符号链接（防环）', async () => {
    const linked = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scan-link-')));
    await fs.writeFile(path.join(linked, 'far.JPG'), 'x');
    await fs.symlink(linked, path.join(tmp, 'loop'));
    const { entries } = await walk(tmp);
    expect(entries.some((x) => x.path.includes('far'))).toBe(false);
    await fs.rm(path.join(tmp, 'loop'), { force: true });
    await fs.rm(linked, { recursive: true, force: true });
  });
});

describe('scanFolder', () => {
  let tmp;
  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scanf-')));
    await fs.mkdir(path.join(tmp, 'cam-b'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'A.CR3'), 'x');
    await fs.writeFile(path.join(tmp, 'A.JPG'), 'x');
    await fs.writeFile(path.join(tmp, 'cam-b', 'A.CR3'), 'x');
    await fs.writeFile(path.join(tmp, 'cam-b', 'A.JPG'), 'x');
    await fs.writeFile(path.join(tmp, 'notes.txt'), 'x');
  });
  afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('端到端产出跨目录不撞车的资产表', async () => {
    const { assets, skippedFiles } = await scanFolder(tmp);
    expect(assets.map((a) => a.id)).toEqual(['A', 'cam-b/A']);
    expect(skippedFiles).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/lib/scan.test.js`
Expected: FAIL — 无法解析 `./scan.js`

- [ ] **Step 3: 实现 `server/lib/scan.js`**

```js
import fs from 'node:fs/promises';
import path from 'node:path';

export const RAW_EXTS = new Set([
  'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf',
  'rw2', 'pef', 'ptx', 'dng', '3fr', 'fff', 'iiq', 'x3f', 'mrw', 'kdc',
  'dcr', 'erf', 'mef', 'mos', 'srw', 'rwl', 'gpr',
]);

export const JPG_EXTS = new Set(['jpg', 'jpeg', 'jpe']);

const SKIP_DIR_NAMES = new Set(['__MACOSX', '.Trashes', '$RECYCLE.BIN', 'System Volume Information']);
const SKIP_DIR_PATTERNS = [/\.lrdata$/i, /^Lightroom Previews/i, /\.lrcat-data$/i];

export const MAX_DEPTH = 8;

function shouldSkipDir(name) {
  if (name.startsWith('.')) return true;           // 含 .photocull
  if (SKIP_DIR_NAMES.has(name)) return true;
  return SKIP_DIR_PATTERNS.some((re) => re.test(name));
}

/** 纯函数：把文件条目配对成资产表。 */
export function pairEntries(entries) {
  const warnings = [];
  let skippedFiles = 0;
  /** @type {Map<string, any>} */
  const byKey = new Map();

  for (const entry of entries) {
    const posix = entry.path.split(path.sep).join('/');
    const slash = posix.lastIndexOf('/');
    const dir = slash === -1 ? '' : posix.slice(0, slash);
    const name = slash === -1 ? posix : posix.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    if (dot <= 0) { skippedFiles++; continue; }

    const ext = name.slice(dot + 1).toLowerCase();
    const isRaw = RAW_EXTS.has(ext);
    const isJpg = JPG_EXTS.has(ext);
    if (!isRaw && !isJpg) { skippedFiles++; continue; }

    const stem = name.slice(0, dot);
    const key = `${dir}/${stem.toLowerCase()}`;   // 目录名保持大小写敏感；/ 不会出现在文件名分量里，故不会碰撞
    let asset = byKey.get(key);
    if (!asset) {
      asset = {
        id: dir ? `${dir}/${stem}` : stem,
        dir, stem, raws: [], jpg: null, jpgSize: 0, jpgMtimeMs: 0,
      };
      byKey.set(key, asset);
    }

    if (isRaw) {
      asset.raws.push(name);
    } else if (asset.jpg === null) {
      asset.jpg = name;
      asset.jpgSize = entry.size;
      asset.jpgMtimeMs = entry.mtimeMs;
    } else {
      const [keep, drop] = [asset.jpg, name].sort();
      if (keep !== asset.jpg) {
        asset.jpg = name; asset.jpgSize = entry.size; asset.jpgMtimeMs = entry.mtimeMs;
      }
      warnings.push(`${asset.id} 有多个 JPG，使用 ${keep}，忽略 ${drop}`);
    }
  }

  const assets = [...byKey.values()];
  for (const a of assets) a.raws.sort();
  assets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { assets, warnings, skippedFiles };
}

/** 递归遍历，不跟随符号链接。 */
export async function walk(root, { maxDepth = MAX_DEPTH, onBatch } = {}) {
  const entries = [];
  const warnings = [];
  let sinceBatch = 0;

  async function visit(absDir, relDir, depth) {
    let dirents;
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      warnings.push(`无法读取目录 ${relDir || '.'}：${err.code}`);
      return;
    }
    for (const d of dirents) {
      const abs = path.join(absDir, d.name);
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        if (shouldSkipDir(d.name)) continue;
        if (depth >= maxDepth) {
          warnings.push(`已达深度上限，跳过 ${rel} 及其子目录`);
          continue;
        }
        await visit(abs, rel, depth + 1);
      } else if (d.isFile()) {
        if (d.name.startsWith('._')) continue; // macOS AppleDouble
        try {
          const st = await fs.stat(abs);
          entries.push({ path: rel, size: st.size, mtimeMs: st.mtimeMs });
          if (onBatch && ++sinceBatch >= 500) { onBatch(entries.length); sinceBatch = 0; }
        } catch (err) {
          warnings.push(`无法读取文件 ${rel}：${err.code}`);
        }
      }
    }
  }

  await visit(root, '', 0);
  if (onBatch && sinceBatch > 0) onBatch(entries.length);
  return { entries, warnings };
}

export async function scanFolder(root, opts = {}) {
  const { entries, warnings: walkWarnings } = await walk(root, opts);
  const { assets, warnings, skippedFiles } = pairEntries(entries);
  return { assets, warnings: [...walkWarnings, ...warnings], skippedFiles };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run server/lib/scan.test.js`
Expected: PASS，全部用例通过

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: 递归扫描与 RAW/JPG 配对"
```

---

## Task 3: EXIF 元数据读取

**Files:**
- Create: `server/lib/meta.js`
- Test: `server/lib/meta.test.js`

**Interfaces:**
- Consumes: Task 2 的 `Asset`
- Produces:
  - `normalizeMeta(raw: object|null, fallbackMtimeMs: number, dir: string): Omit<AssetMeta, 'id'>` — 纯函数
    - `AssetMeta = { id, time, timeSource: 'exif'|'createDate'|'mtime', orientation, body, iso, fNumber, exposureTime, focalLength }`
  - `readAllMeta(root: string, assets: Asset[], opts?: {concurrency?, onBatch?: (metas: AssetMeta[]) => void}): Promise<AssetMeta[]>`

- [ ] **Step 1: 写失败的测试 `server/lib/meta.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { normalizeMeta } from './meta.js';

describe('normalizeMeta', () => {
  it('优先用 DateTimeOriginal', () => {
    const m = normalizeMeta(
      { DateTimeOriginal: new Date('2026-07-26T10:00:00Z'), Model: 'R5', BodySerialNumber: 'SN1' },
      999, 'cam-a');
    expect(m.time).toBe(Date.parse('2026-07-26T10:00:00Z'));
    expect(m.timeSource).toBe('exif');
  });

  it('用 SubSecTimeOriginal 补足毫秒', () => {
    const m = normalizeMeta(
      { DateTimeOriginal: new Date('2026-07-26T10:00:00Z'), SubSecTimeOriginal: '25' }, 0, '');
    expect(m.time).toBe(Date.parse('2026-07-26T10:00:00Z') + 250);
  });

  it('SubSecTimeOriginal 是数字时也能处理', () => {
    const m = normalizeMeta(
      { DateTimeOriginal: new Date('2026-07-26T10:00:00Z'), SubSecTimeOriginal: 7 }, 0, '');
    expect(m.time).toBe(Date.parse('2026-07-26T10:00:00Z') + 700);
  });

  it('无 DateTimeOriginal 时退到 CreateDate', () => {
    const m = normalizeMeta({ CreateDate: new Date('2026-01-01T00:00:00Z') }, 999, '');
    expect(m.time).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(m.timeSource).toBe('createDate');
  });

  it('都没有时退到文件 mtime', () => {
    const m = normalizeMeta(null, 12345, '');
    expect(m.time).toBe(12345);
    expect(m.timeSource).toBe('mtime');
  });

  it('body 由 Model 与序列号组成', () => {
    const m = normalizeMeta({ Model: 'ILCE-7RM5', BodySerialNumber: 'ABC' }, 0, 'cam-a');
    expect(m.body).toBe('ILCE-7RM5|ABC');
  });

  it('机身信息缺失时退化为目录名', () => {
    const m = normalizeMeta({}, 0, 'cam-b');
    expect(m.body).toBe('dir:cam-b');
  });

  it('只有 Model 没有序列号时仍用 Model', () => {
    const m = normalizeMeta({ Model: 'X-T5' }, 0, 'cam-b');
    expect(m.body).toBe('X-T5|');
  });

  it('orientation 缺失或非法时归一为 1', () => {
    expect(normalizeMeta({}, 0, '').orientation).toBe(1);
    expect(normalizeMeta({ Orientation: 99 }, 0, '').orientation).toBe(1);
    expect(normalizeMeta({ Orientation: 6 }, 0, '').orientation).toBe(6);
  });

  it('拍摄参数缺失时为 null 而不是 undefined', () => {
    const m = normalizeMeta({}, 0, '');
    expect(m.iso).toBeNull();
    expect(m.fNumber).toBeNull();
    expect(m.exposureTime).toBeNull();
    expect(m.focalLength).toBeNull();
  });

  it('拍摄参数存在时透传', () => {
    const m = normalizeMeta({ ISO: 400, FNumber: 1.4, ExposureTime: 0.004, FocalLength: 85 }, 0, '');
    expect(m).toMatchObject({ iso: 400, fNumber: 1.4, exposureTime: 0.004, focalLength: 85 });
  });

  it('无效日期不会产出 NaN 时间', () => {
    const m = normalizeMeta({ DateTimeOriginal: new Date('invalid') }, 777, '');
    expect(m.time).toBe(777);
    expect(m.timeSource).toBe('mtime');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/lib/meta.test.js`
Expected: FAIL — 无法解析 `./meta.js`

- [ ] **Step 3: 实现 `server/lib/meta.js`**

```js
import path from 'node:path';
import exifr from 'exifr';
import pLimit from 'p-limit';

const EXIF_PICK = [
  'DateTimeOriginal', 'SubSecTimeOriginal', 'CreateDate', 'Orientation',
  'Model', 'BodySerialNumber', 'ISO', 'FNumber', 'ExposureTime', 'FocalLength',
];

function toTime(value) {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function subSecMs(value) {
  if (value === undefined || value === null) return 0;
  const digits = String(value).replace(/\D/g, '').slice(0, 3);
  if (!digits) return 0;
  return Number(digits.padEnd(3, '0'));
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 纯函数：把 exifr 的原始输出归一化成 AssetMeta（不含 id）。 */
export function normalizeMeta(raw, fallbackMtimeMs, dir) {
  const r = raw || {};
  let time = toTime(r.DateTimeOriginal);
  let timeSource = 'exif';
  if (time !== null) {
    time += subSecMs(r.SubSecTimeOriginal);
  } else {
    time = toTime(r.CreateDate);
    timeSource = 'createDate';
  }
  if (time === null) {
    time = fallbackMtimeMs;
    timeSource = 'mtime';
  }

  const orientation =
    Number.isInteger(r.Orientation) && r.Orientation >= 1 && r.Orientation <= 8 ? r.Orientation : 1;

  const body = r.Model
    ? `${r.Model}|${r.BodySerialNumber ?? ''}`
    : r.BodySerialNumber
      ? `|${r.BodySerialNumber}`
      : `dir:${dir}`;

  return {
    time, timeSource, orientation, body,
    iso: num(r.ISO), fNumber: num(r.FNumber),
    exposureTime: num(r.ExposureTime), focalLength: num(r.FocalLength),
  };
}

/**
 * 并发读取全部资产的元数据。只解析 EXIF 段，不解码像素。
 * 没有 JPG 的资产直接退化到 mtime。
 */
export async function readAllMeta(root, assets, { concurrency = 8, onBatch } = {}) {
  const limit = pLimit(concurrency);
  const out = new Array(assets.length);
  let pending = [];

  await Promise.all(assets.map((asset, i) => limit(async () => {
    let raw = null;
    if (asset.jpg) {
      const abs = path.join(root, ...asset.dir.split('/').filter(Boolean), asset.jpg);
      try {
        raw = await exifr.parse(abs, { pick: EXIF_PICK, translateValues: false });
      } catch {
        raw = null; // 损坏或无 EXIF：静默退化，不阻断整场扫描
      }
    }
    out[i] = { id: asset.id, ...normalizeMeta(raw, asset.jpgMtimeMs, asset.dir) };
    if (onBatch) {
      pending.push(out[i]);
      if (pending.length >= 200) { onBatch(pending); pending = []; }
    }
  })));

  if (onBatch && pending.length) onBatch(pending);
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run server/lib/meta.test.js`
Expected: PASS，12 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: EXIF 元数据读取与归一化"
```

---

## Task 4: 标记存储（原子写与损坏回退）

**Files:**
- Create: `server/lib/store.js`
- Test: `server/lib/store.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `DEFAULT_SETTINGS = { burstThresholdMs: 1000, gridSize: 'medium', sort: 'time' }`
  - `marksDir(root): string` → `<root>/.photocull`
  - `readMarksFile(root): Promise<MarksFile>` — `MarksFile = { version: 1, updatedAt: string, marks: Record<string,'pick'|'reject'>, settings: object, recovered: boolean }`；文件缺失返回空壳；JSON 损坏时回退 `marks.bak.json`
  - `writeMarksFile(root, data): Promise<void>` — 原子写 + 备份
  - `createMarkStore(root, opts?: {debounceMs?: number}): Promise<MarkStore>`
    - `MarkStore = { data, setMark(id, mark|null), setSettings(patch), flush(): Promise<void>, close(): Promise<void> }`

- [ ] **Step 1: 写失败的测试 `server/lib/store.test.js`**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readMarksFile, writeMarksFile, createMarkStore, marksDir, DEFAULT_SETTINGS } from './store.js';

let tmp;
beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'store-')));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const marksPath = (root) => path.join(marksDir(root), 'marks.json');
const bakPath = (root) => path.join(marksDir(root), 'marks.bak.json');

describe('readMarksFile', () => {
  it('文件不存在时返回带默认设置的空壳', async () => {
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({});
    expect(data.settings).toEqual(DEFAULT_SETTINGS);
    expect(data.version).toBe(1);
  });

  it('读出已写入的标记', async () => {
    await writeMarksFile(tmp, { version: 1, marks: { 'cam-a/IMG_1': 'pick' }, settings: DEFAULT_SETTINGS });
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({ 'cam-a/IMG_1': 'pick' });
  });

  it('设置字段与默认值合并，缺失项补齐', async () => {
    await writeMarksFile(tmp, { version: 1, marks: {}, settings: { burstThresholdMs: 2500 } });
    const data = await readMarksFile(tmp);
    expect(data.settings.burstThresholdMs).toBe(2500);
    expect(data.settings.gridSize).toBe(DEFAULT_SETTINGS.gridSize);
  });

  it('主文件损坏时回退到备份', async () => {
    await writeMarksFile(tmp, { version: 1, marks: { a: 'pick' }, settings: {} });
    await writeMarksFile(tmp, { version: 1, marks: { a: 'pick', b: 'reject' }, settings: {} });
    await fs.writeFile(marksPath(tmp), 'not json at all');
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({ a: 'pick' });
    expect(data.recovered).toBe(true);
  });

  it('主文件与备份都损坏时返回空壳且标记未恢复', async () => {
    await fs.mkdir(marksDir(tmp), { recursive: true });
    await fs.writeFile(marksPath(tmp), 'garbage');
    await fs.writeFile(bakPath(tmp), 'garbage');
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({});
    expect(data.recovered).toBe(false);
  });

  it('丢弃非法的标记值', async () => {
    await fs.mkdir(marksDir(tmp), { recursive: true });
    await fs.writeFile(marksPath(tmp),
      JSON.stringify({ version: 1, marks: { a: 'pick', b: 'banana', c: null }, settings: {} }));
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({ a: 'pick' });
  });
});

describe('writeMarksFile', () => {
  it('写入后不留下 .tmp 文件', async () => {
    await writeMarksFile(tmp, { version: 1, marks: { a: 'pick' }, settings: {} });
    const files = await fs.readdir(marksDir(tmp));
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('第二次写入前把旧文件备份走', async () => {
    await writeMarksFile(tmp, { version: 1, marks: { a: 'pick' }, settings: {} });
    await writeMarksFile(tmp, { version: 1, marks: { b: 'reject' }, settings: {} });
    const bak = JSON.parse(await fs.readFile(bakPath(tmp), 'utf8'));
    expect(bak.marks).toEqual({ a: 'pick' });
  });

  it('写入 updatedAt 时间戳', async () => {
    await writeMarksFile(tmp, { version: 1, marks: {}, settings: {} });
    const data = JSON.parse(await fs.readFile(marksPath(tmp), 'utf8'));
    expect(Date.parse(data.updatedAt)).toBeGreaterThan(0);
  });

  it('模拟写入中途崩溃：残留 tmp 不影响读出完整旧数据', async () => {
    await writeMarksFile(tmp, { version: 1, marks: { a: 'pick' }, settings: {} });
    await fs.writeFile(marksPath(tmp) + '.tmp', 'half written');
    const data = await readMarksFile(tmp);
    expect(data.marks).toEqual({ a: 'pick' });
  });
});

describe('createMarkStore', () => {
  it('setMark 后防抖落盘', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 20 });
    store.setMark('a', 'pick');
    expect(store.data.marks.a).toBe('pick');
    await new Promise((r) => setTimeout(r, 80));
    const onDisk = await readMarksFile(tmp);
    expect(onDisk.marks.a).toBe('pick');
    await store.close();
  });

  it('传 null 即取消标记，且不写进文件', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 5 });
    store.setMark('a', 'pick');
    store.setMark('a', null);
    await store.flush();
    const onDisk = await readMarksFile(tmp);
    expect(onDisk.marks).toEqual({});
    await store.close();
  });

  it('连续多次修改只落盘最终状态', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 20 });
    store.setMark('a', 'pick');
    store.setMark('a', 'reject');
    store.setMark('b', 'pick');
    await store.flush();
    const onDisk = await readMarksFile(tmp);
    expect(onDisk.marks).toEqual({ a: 'reject', b: 'pick' });
    await store.close();
  });

  it('setSettings 只合并传入的字段', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 5 });
    store.setSettings({ burstThresholdMs: 2000 });
    await store.flush();
    const onDisk = await readMarksFile(tmp);
    expect(onDisk.settings.burstThresholdMs).toBe(2000);
    expect(onDisk.settings.gridSize).toBe(DEFAULT_SETTINGS.gridSize);
    await store.close();
  });

  it('close 会把未落盘的改动刷出去', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 10000 });
    store.setMark('z', 'pick');
    await store.close();
    const onDisk = await readMarksFile(tmp);
    expect(onDisk.marks.z).toBe('pick');
  });

  it('拒绝非法标记值', async () => {
    const store = await createMarkStore(tmp, { debounceMs: 5 });
    expect(() => store.setMark('a', 'banana')).toThrow();
    await store.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/lib/store.test.js`
Expected: FAIL — 无法解析 `./store.js`

- [ ] **Step 3: 实现 `server/lib/store.js`**

```js
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_SETTINGS = { burstThresholdMs: 1000, gridSize: 'medium', sort: 'time' };
const VALID_MARKS = new Set(['pick', 'reject']);

export const marksDir = (root) => path.join(root, '.photocull');
const marksPath = (root) => path.join(marksDir(root), 'marks.json');
const bakPath = (root) => path.join(marksDir(root), 'marks.bak.json');

function sanitize(parsed) {
  const marks = {};
  for (const [id, mark] of Object.entries(parsed?.marks ?? {})) {
    if (VALID_MARKS.has(mark)) marks[id] = mark;
  }
  return {
    version: 1,
    updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : '',
    marks,
    settings: { ...DEFAULT_SETTINGS, ...(parsed?.settings ?? {}) },
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
  let closed = false;

  async function persist() {
    timer = null;
    writing = writeMarksFile(root, data).finally(() => { writing = null; });
    await writing;
  }

  function schedule() {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      persist().catch((e) => console.error('[marks] 写入失败', e));
    }, debounceMs);
  }

  return {
    data,
    setMark(id, mark) {
      if (mark !== null && !VALID_MARKS.has(mark)) throw new Error(`非法标记值：${mark}`);
      if (mark === null) delete data.marks[id];
      else data.marks[id] = mark;
      schedule();
    },
    setSettings(patch) {
      Object.assign(data.settings, patch);
      schedule();
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (writing) await writing;
      await persist();
    },
    async close() {
      await this.flush();
      closed = true;
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run server/lib/store.test.js`
Expected: PASS，16 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: 标记存储的原子写与损坏回退"
```

---

## Task 5: 缩略图生成与磁盘缓存

**Files:**
- Create: `server/lib/thumbs.js`
- Test: `server/lib/thumbs.test.js`

**Interfaces:**
- Consumes: Task 4 的 `marksDir`
- Produces:
  - `TIERS = { grid: { size: 320, quality: 72 }, preview: { size: 1280, quality: 82 } }`
  - `cacheKey(relPath, mtimeMs, size, tier): string` — 纯函数，16 位十六进制
  - `thumbPath(root, key): string`
  - `getThumb(root, asset, tier): Promise<{ file: string|null, key: string, placeholder: boolean }>`
  - `PLACEHOLDER_SVG: string`

- [ ] **Step 1: 写失败的测试 `server/lib/thumbs.test.js`**

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { cacheKey, getThumb, thumbPath, TIERS } from './thumbs.js';

describe('cacheKey', () => {
  it('相同输入产出相同 key', () => {
    expect(cacheKey('a/b.JPG', 1, 2, 'grid')).toBe(cacheKey('a/b.JPG', 1, 2, 'grid'));
  });
  it('mtime 变化导致 key 变化', () => {
    expect(cacheKey('a.JPG', 1, 2, 'grid')).not.toBe(cacheKey('a.JPG', 9, 2, 'grid'));
  });
  it('文件大小变化导致 key 变化', () => {
    expect(cacheKey('a.JPG', 1, 2, 'grid')).not.toBe(cacheKey('a.JPG', 1, 3, 'grid'));
  });
  it('档位变化导致 key 变化', () => {
    expect(cacheKey('a.JPG', 1, 2, 'grid')).not.toBe(cacheKey('a.JPG', 1, 2, 'preview'));
  });
  it('路径变化导致 key 变化', () => {
    expect(cacheKey('a.JPG', 1, 2, 'grid')).not.toBe(cacheKey('b.JPG', 1, 2, 'grid'));
  });
  it('key 是 16 位十六进制，可安全作文件名', () => {
    expect(cacheKey('a/b c.JPG', 1, 2, 'grid')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('getThumb', () => {
  let tmp;
  const asset = { id: 'cam-a/shot', dir: 'cam-a', stem: 'shot', raws: [], jpg: 'shot.JPG' };

  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'thumb-')));
    await fs.mkdir(path.join(tmp, 'cam-a'), { recursive: true });
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 30, b: 30 } } })
      .jpeg().toFile(path.join(tmp, 'cam-a', 'shot.JPG'));
    const st = await fs.stat(path.join(tmp, 'cam-a', 'shot.JPG'));
    asset.jpgSize = st.size;
    asset.jpgMtimeMs = st.mtimeMs;
  });
  afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('生成 grid 档缩略图，长边等于 320', async () => {
    const { file, placeholder } = await getThumb(tmp, asset, 'grid');
    expect(placeholder).toBe(false);
    const meta = await sharp(file).metadata();
    expect(Math.max(meta.width, meta.height)).toBe(TIERS.grid.size);
    expect(meta.format).toBe('webp');
  });

  it('缓存文件落在 .photocull/thumbs 下', async () => {
    const { file, key } = await getThumb(tmp, asset, 'grid');
    expect(file).toBe(thumbPath(tmp, key));
    expect(file).toContain(path.join('.photocull', 'thumbs'));
  });

  it('第二次调用命中磁盘缓存，不重新生成', async () => {
    const { file } = await getThumb(tmp, asset, 'grid');
    const before = (await fs.stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 30));
    const again = await getThumb(tmp, asset, 'grid');
    expect((await fs.stat(again.file)).mtimeMs).toBe(before);
  });

  it('preview 档不放大小于目标尺寸的原图', async () => {
    const { file } = await getThumb(tmp, asset, 'preview');
    const meta = await sharp(file).metadata();
    expect(Math.max(meta.width, meta.height)).toBe(1200);
  });

  it('没有 JPG 的资产返回占位', async () => {
    const res = await getThumb(tmp, { ...asset, id: 'x', jpg: null }, 'grid');
    expect(res.placeholder).toBe(true);
    expect(res.file).toBeNull();
  });

  it('损坏的 JPG 返回占位而不是抛错', async () => {
    await fs.writeFile(path.join(tmp, 'cam-a', 'broken.JPG'), 'not an image at all');
    const st = await fs.stat(path.join(tmp, 'cam-a', 'broken.JPG'));
    const res = await getThumb(tmp, {
      id: 'cam-a/broken', dir: 'cam-a', stem: 'broken', raws: [], jpg: 'broken.JPG',
      jpgSize: st.size, jpgMtimeMs: st.mtimeMs,
    }, 'grid');
    expect(res.placeholder).toBe(true);
  });

  it('并发请求同一张图不会互相破坏', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => getThumb(tmp, asset, 'grid')));
    for (const r of results) {
      expect(r.placeholder).toBe(false);
      expect((await sharp(r.file).metadata()).format).toBe('webp');
    }
  });

  it('未知档位抛错', async () => {
    await expect(getThumb(tmp, asset, 'huge')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/lib/thumbs.test.js`
Expected: FAIL — 无法解析 `./thumbs.js`

- [ ] **Step 3: 实现 `server/lib/thumbs.js`**

```js
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import pLimit from 'p-limit';
import { marksDir } from './store.js';

export const TIERS = {
  grid: { size: 320, quality: 72 },
  preview: { size: 1280, quality: 82 },
};

export const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 213">' +
  '<rect width="320" height="213" fill="#2a2a2e"/>' +
  '<text x="160" y="112" fill="#7a7a82" font-family="sans-serif" font-size="15" text-anchor="middle">无预览</text>' +
  '</svg>';

// 闸门：不限制的话 sharp 会打满所有核，服务本身失去响应
const limit = pLimit(Math.max(1, os.cpus().length - 1));
// 同 key 的并发请求合流，避免重复生成
const inflight = new Map();

export function cacheKey(relPath, mtimeMs, size, tier) {
  return crypto.createHash('sha1')
    .update(`${relPath} ${mtimeMs} ${size} ${tier}`)
    .digest('hex').slice(0, 16);
}

export const thumbPath = (root, key) => path.join(marksDir(root), 'thumbs', `${key}.webp`);

const jpgRelPath = (asset) => (asset.dir ? `${asset.dir}/${asset.jpg}` : asset.jpg);

let tmpSeq = 0;

async function generate(srcAbs, destAbs, tier) {
  const { size, quality } = TIERS[tier];
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  const tmp = `${destAbs}.${process.pid}.${tmpSeq++}.tmp`;
  await sharp(srcAbs, { failOn: 'none' })
    .rotate()          // 无参数即按 EXIF Orientation 自动摆正
    .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
    .webp({ quality, effort: 4 })
    .toFile(tmp);
  await fs.rename(tmp, destAbs);
}

/**
 * 取缩略图。命中磁盘缓存直接返回路径，否则生成。
 * 失败返回 placeholder:true，由路由回占位 SVG —— 回 500 会让前端反复重试。
 */
export async function getThumb(root, asset, tier) {
  if (!TIERS[tier]) throw new Error(`未知缩略图档位：${tier}`);
  if (!asset.jpg) return { file: null, key: '', placeholder: true };

  const rel = jpgRelPath(asset);
  const key = cacheKey(rel, asset.jpgMtimeMs, asset.jpgSize, tier);
  const dest = thumbPath(root, key);

  try {
    await fs.access(dest);
    return { file: dest, key, placeholder: false };
  } catch { /* 未命中，往下生成 */ }

  if (inflight.has(key)) return inflight.get(key);

  const srcAbs = path.join(root, ...rel.split('/'));
  const job = limit(() => generate(srcAbs, dest, tier))
    .then(() => ({ file: dest, key, placeholder: false }))
    .catch((err) => {
      console.warn(`[thumb] 生成失败 ${rel}: ${err.message}`);
      return { file: null, key, placeholder: true };
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run server/lib/thumbs.test.js`
Expected: PASS，14 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: sharp 缩略图生成与磁盘缓存"
```

---

## Task 6: 会话与只读 HTTP 接口

**Files:**
- Create: `server/lib/session.js`, `server/routes/fs.js`, `server/routes/library.js`, `server/routes/marks.js`, `server/routes/image.js`, `server/index.js`
- Test: `server/routes/routes.test.js`

**Interfaces:**
- Consumes: Task 1 `assertWithin` / `SafePathError`、Task 2 `scanFolder`、Task 3 `readAllMeta`、Task 4 `createMarkStore`、Task 5 `getThumb` / `PLACEHOLDER_SVG`
- Produces:
  - `session.js`：`openSession(root)`、`getSession()`、`closeSession()`、`browseRoots()`、`emit(session, event)`
    - `Session = { root, assets, byId: Map, metas: Map, markStore, metaDone, bake: {done,total,running}, listeners: Set, aborted }`
  - `index.js`：具名导出 `createApp(): express.Express`（供测试注入，不自动 listen）
  - HTTP 契约（后续任务全部依赖这些路径与字段名）：

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/fs/roots` | — | `{roots:[{path,label}], home}` |
| GET | `/api/fs/list?path=` | — | `{path, parent, dirs:[{name,path}]}` |
| POST | `/api/fs/mkdir` | `{parent,name}` | `{path}` |
| POST | `/api/library/open` | `{root}` | `{root,assetCount,warnings,skippedFiles,settings,marksRecovered}` |
| POST | `/api/library/close` | — | `{ok:true}` |
| GET | `/api/library/assets` | — | `{assets:Asset[]}` |
| GET | `/api/library/meta` | — | `{metas:AssetMeta[], done}` |
| GET | `/api/library/stream` | — | SSE：`{type:'meta',metas}` / `{type:'metaDone'}` / `{type:'bake',done,total}` |
| GET | `/api/library/marks` | — | `{marks, settings}` |
| PUT | `/api/library/marks` | `{marks:{id:'pick'\|'reject'\|null}}` | `{ok,marks}` |
| PUT | `/api/library/settings` | `{burstThresholdMs?,gridSize?,sort?}` | `{ok,settings}` |
| GET | `/api/thumb?id=&tier=` | — | image/webp（或占位 svg） |
| GET | `/api/original?id=` | — | image/jpeg |

- [ ] **Step 1: 写失败的测试 `server/routes/routes.test.js`**

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../index.js';
import { closeSession } from '../lib/session.js';

let server, base, tmp;

const api = (p, init) => fetch(base + p, init);
const json = async (p, init) => (await api(p, init)).json();
const openLib = () => json('/api/library/open', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ root: tmp }),
});

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'routes-')));
  await fs.mkdir(path.join(tmp, 'cam-a'), { recursive: true });
  for (const [dir, stem] of [['', 'A'], ['cam-a', 'B']]) {
    const d = path.join(tmp, dir);
    await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 10, g: 90, b: 160 } } })
      .jpeg().toFile(path.join(d, `${stem}.JPG`));
    await fs.writeFile(path.join(d, `${stem}.CR3`), 'fake raw');
  }
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await closeSession();
  await new Promise((r) => server.close(r));
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('GET /api/fs/list', () => {
  it('列出子目录', async () => {
    const data = await json(`/api/fs/list?path=${encodeURIComponent(tmp)}`);
    expect(data.dirs.map((d) => d.name)).toContain('cam-a');
  });
  it('只列目录不列文件', async () => {
    const data = await json(`/api/fs/list?path=${encodeURIComponent(tmp)}`);
    expect(data.dirs.some((d) => d.name.endsWith('.JPG'))).toBe(false);
  });
  it('拒绝越界路径', async () => {
    expect((await api('/api/fs/list?path=%2Fetc%2Fssh')).status).toBe(403);
  });
});

describe('库的打开与关闭', () => {
  it('未打开库时接口返回 409', async () => {
    await closeSession();
    expect((await api('/api/library/assets')).status).toBe(409);
  });

  it('打开文件夹返回资产数', async () => {
    const data = await openLib();
    expect(data.assetCount).toBe(2);
    expect(data.root).toBe(tmp);
  });

  it('资产表按 id 排序且跨目录不撞车', async () => {
    const data = await json('/api/library/assets');
    expect(data.assets.map((a) => a.id)).toEqual(['A', 'cam-a/B']);
  });
});

describe('GET /api/thumb', () => {
  it('返回 webp 并带强缓存头与 ETag', async () => {
    const res = await api('/api/thumb?id=A&tier=grid');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/webp');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('etag')).toBeTruthy();
  });

  it('带 If-None-Match 时返回 304', async () => {
    const first = await api('/api/thumb?id=A&tier=grid');
    const etag = first.headers.get('etag');
    const second = await api('/api/thumb?id=A&tier=grid', { headers: { 'If-None-Match': etag } });
    expect(second.status).toBe(304);
  });

  it('未知 id 返回 404', async () => {
    expect((await api('/api/thumb?id=nope')).status).toBe(404);
  });

  it('id 里塞路径穿越也只是 404，读不到任何文件', async () => {
    const res = await api('/api/thumb?id=' + encodeURIComponent('../../../etc/passwd'));
    expect(res.status).toBe(404);
  });
});

describe('marks 接口', () => {
  it('PUT 后 GET 能读回', async () => {
    await api('/api/library/marks', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marks: { A: 'pick', 'cam-a/B': 'reject' } }),
    });
    const data = await json('/api/library/marks');
    expect(data.marks).toEqual({ A: 'pick', 'cam-a/B': 'reject' });
  });

  it('传 null 取消标记', async () => {
    await api('/api/library/marks', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marks: { A: null } }),
    });
    const data = await json('/api/library/marks');
    expect(data.marks.A).toBeUndefined();
  });

  it('拒绝未知资产 id', async () => {
    const res = await api('/api/library/marks', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marks: { 'ghost/999': 'pick' } }),
    });
    expect(res.status).toBe(400);
  });

  it('PUT settings 合并生效', async () => {
    await api('/api/library/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ burstThresholdMs: 2500 }),
    });
    const data = await json('/api/library/marks');
    expect(data.settings.burstThresholdMs).toBe(2500);
  });
});

describe('GET /api/original', () => {
  it('返回原始 JPG', async () => {
    const res = await api('/api/original?id=A');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/jpeg');
  });
  it('未知资产返回 404', async () => {
    expect((await api('/api/original?id=ghost')).status).toBe(404);
  });
});

describe('GET /api/library/stream', () => {
  it('SSE 首帧补发当前快照', async () => {
    const ctrl = new AbortController();
    const res = await api('/api/library/stream', { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain('"type":"meta"');
    ctrl.abort();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/routes/routes.test.js`
Expected: FAIL — 无法解析 `../index.js`

- [ ] **Step 3: 实现 `server/lib/session.js`**

```js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanFolder } from './scan.js';
import { readAllMeta } from './meta.js';
import { createMarkStore } from './store.js';

let current = null;

export function getSession() {
  return current;
}

/** 目录浏览允许的根：主目录 + 各挂载卷 + 临时目录（测试需要）。 */
export async function browseRoots() {
  const roots = [os.homedir(), os.tmpdir()];
  for (const dir of ['/Volumes', '/media', '/mnt']) {
    try {
      for (const name of await fs.readdir(dir)) roots.push(path.join(dir, name));
    } catch { /* 该平台没这个目录 */ }
  }
  return roots;
}

export function emit(session, event) {
  for (const fn of session.listeners) {
    try { fn(event); } catch { /* 订阅者已断开 */ }
  }
}

export async function closeSession() {
  if (!current) return;
  const old = current;
  current = null;
  old.aborted = true;
  old.listeners.clear();
  await old.markStore.close();
}

export async function openSession(root) {
  await closeSession();

  const { assets, warnings, skippedFiles } = await scanFolder(root);
  const markStore = await createMarkStore(root);

  const session = {
    root, assets, warnings, skippedFiles, markStore,
    byId: new Map(assets.map((a) => [a.id, a])),
    metas: new Map(),
    metaDone: false,
    bake: { done: 0, total: assets.filter((a) => a.jpg).length, running: false },
    aborted: false,
    listeners: new Set(),
  };
  current = session;

  // 元数据后台读，不阻塞打开
  readAllMeta(root, assets, {
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

  return session;
}
```

- [ ] **Step 4: 实现 `server/routes/fs.js`**

```js
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertWithin } from '../lib/safepath.js';
import { browseRoots } from '../lib/session.js';

export const fsRouter = express.Router();

fsRouter.get('/roots', async (req, res, next) => {
  try {
    const roots = await browseRoots();
    res.json({
      roots: roots.map((p) => ({ path: p, label: path.basename(p) || p })),
      home: os.homedir(),
    });
  } catch (err) { next(err); }
});

fsRouter.get('/list', async (req, res, next) => {
  try {
    const target = await assertWithin(await browseRoots(), String(req.query.path ?? os.homedir()));
    const dirents = await fs.readdir(target, { withFileTypes: true });
    const dirs = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, path: path.join(target, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    res.json({ path: target, parent: path.dirname(target), dirs });
  } catch (err) { next(err); }
});

fsRouter.post('/mkdir', async (req, res, next) => {
  try {
    const parent = await assertWithin(await browseRoots(), String(req.body?.parent ?? ''));
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.includes('/') || name.includes('\\') || name === '..') {
      return res.status(400).json({ error: '目录名非法' });
    }
    const target = path.join(parent, name);
    await fs.mkdir(target, { recursive: true });
    res.json({ path: target });
  } catch (err) { next(err); }
});
```

- [ ] **Step 5: 实现 `server/routes/library.js`**

```js
import express from 'express';
import { assertWithin } from '../lib/safepath.js';
import { openSession, getSession, browseRoots, closeSession } from '../lib/session.js';

export const libraryRouter = express.Router();

/** 要求已打开库；未打开返回 409。后续路由都挂在它后面。 */
export function requireSession(req, res, next) {
  const session = getSession();
  if (!session) return res.status(409).json({ error: '尚未打开照片文件夹' });
  req.session = session;
  next();
}

libraryRouter.post('/open', async (req, res, next) => {
  try {
    const root = await assertWithin(await browseRoots(), String(req.body?.root ?? ''));
    const session = await openSession(root);
    res.json({
      root: session.root,
      assetCount: session.assets.length,
      warnings: session.warnings,
      skippedFiles: session.skippedFiles,
      settings: session.markStore.data.settings,
      marksRecovered: session.markStore.data.recovered === true,
    });
  } catch (err) { next(err); }
});

libraryRouter.post('/close', async (req, res, next) => {
  try { await closeSession(); res.json({ ok: true }); } catch (err) { next(err); }
});

libraryRouter.get('/assets', requireSession, (req, res) => {
  res.json({ assets: req.session.assets });
});

libraryRouter.get('/meta', requireSession, (req, res) => {
  res.json({ metas: [...req.session.metas.values()], done: req.session.metaDone });
});

/** SSE：元数据批次 + 烘焙进度。 */
libraryRouter.get('/stream', requireSession, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const session = req.session;

  // 补发快照，订阅者不会漏掉已发生的批次
  send({ type: 'meta', metas: [...session.metas.values()] });
  if (session.metaDone) send({ type: 'metaDone' });
  send({ type: 'bake', ...session.bake });

  session.listeners.add(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); session.listeners.delete(send); });
});
```

- [ ] **Step 6: 实现 `server/routes/marks.js`**

```js
import express from 'express';
import { requireSession } from './library.js';

export const marksRouter = express.Router();

marksRouter.get('/marks', requireSession, (req, res) => {
  const { marks, settings } = req.session.markStore.data;
  res.json({ marks, settings });
});

marksRouter.put('/marks', requireSession, (req, res, next) => {
  try {
    const patch = req.body?.marks;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ error: 'marks 必须是对象' });
    }
    for (const id of Object.keys(patch)) {
      if (!req.session.byId.has(id)) return res.status(400).json({ error: `未知资产：${id}` });
    }
    for (const [id, mark] of Object.entries(patch)) {
      req.session.markStore.setMark(id, mark ?? null);
    }
    res.json({ ok: true, marks: req.session.markStore.data.marks });
  } catch (err) { next(err); }
});

marksRouter.put('/settings', requireSession, (req, res, next) => {
  try {
    const allowed = ['burstThresholdMs', 'gridSize', 'sort'];
    const clean = Object.fromEntries(
      Object.entries(req.body ?? {}).filter(([k]) => allowed.includes(k)));
    req.session.markStore.setSettings(clean);
    res.json({ ok: true, settings: req.session.markStore.data.settings });
  } catch (err) { next(err); }
});
```

- [ ] **Step 7: 实现 `server/routes/image.js`**

```js
import express from 'express';
import path from 'node:path';
import { getSession } from '../lib/session.js';
import { getThumb, PLACEHOLDER_SVG } from '../lib/thumbs.js';

export const imageRouter = express.Router();

const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * 这里只接受资产 id，绝不接受客户端路径。
 * 真实路径永远从内存资产表查出来 —— 穿越攻击在这一步就退化成 404。
 */
imageRouter.get('/thumb', async (req, res, next) => {
  try {
    const session = getSession();
    if (!session) return res.status(409).json({ error: '尚未打开照片文件夹' });

    const asset = session.byId.get(String(req.query.id ?? ''));
    if (!asset) return res.status(404).json({ error: '未知资产' });

    const { file, key, placeholder } = await getThumb(session.root, asset, String(req.query.tier ?? 'grid'));

    if (placeholder) {
      res.set('Cache-Control', 'public, max-age=60');
      return res.type('image/svg+xml').send(PLACEHOLDER_SVG);
    }
    if (req.headers['if-none-match'] === `"${key}"`) {
      res.set({ ETag: `"${key}"`, 'Cache-Control': IMMUTABLE });
      return res.status(304).end();
    }
    res.set({ ETag: `"${key}"`, 'Cache-Control': IMMUTABLE, 'Content-Type': 'image/webp' });
    res.sendFile(file);
  } catch (err) { next(err); }
});

imageRouter.get('/original', (req, res, next) => {
  try {
    const session = getSession();
    if (!session) return res.status(409).json({ error: '尚未打开照片文件夹' });

    const asset = session.byId.get(String(req.query.id ?? ''));
    if (!asset || !asset.jpg) return res.status(404).json({ error: '该资产没有 JPG' });

    const abs = path.join(session.root, ...asset.dir.split('/').filter(Boolean), asset.jpg);
    res.set({
      'Content-Type': 'image/jpeg',
      ETag: `"${asset.jpgMtimeMs}-${asset.jpgSize}"`,
      'Cache-Control': 'private, max-age=3600',
    });
    res.sendFile(abs);   // sendFile 自带 Range 支持
  } catch (err) { next(err); }
});
```

- [ ] **Step 8: 实现 `server/index.js`**

```js
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import open from 'open';
import { SafePathError } from './lib/safepath.js';
import { fsRouter } from './routes/fs.js';
import { libraryRouter } from './routes/library.js';
import { marksRouter } from './routes/marks.js';
import { imageRouter } from './routes/image.js';
import { closeSession } from './lib/session.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.use('/api/fs', fsRouter);
  app.use('/api/library', libraryRouter);
  app.use('/api/library', marksRouter);
  app.use('/api', imageRouter);

  app.use(express.static(publicDir, { index: 'index.html' }));
  // Express 5 的通配语法是 '/*splat'；写成 '*' 会在启动时抛 PathError
  app.get('/*splat', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(publicDir, 'index.html'), (err) => { if (err) next(err); });
  });

  app.use((err, req, res, _next) => {
    const status = err instanceof SafePathError ? 403 : (err.status ?? 500);
    if (status >= 500) console.error('[api]', err);
    res.status(status).json({ error: err.message });
  });

  return app;
}

async function listenWithFallback(app, start = 5183, tries = 17) {
  for (let port = start; port < start + tries; port++) {
    try {
      return await new Promise((resolve, reject) => {
        const server = app.listen(port, '127.0.0.1');   // 只绑本机，绝不用 0.0.0.0
        server.once('listening', () => resolve(server));
        server.once('error', reject);
      });
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`端口 ${start}–${start + tries - 1} 全部被占用`);
}

// 只在直接运行时启动；被测试 import 时不启动
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const server = await listenWithFallback(createApp());
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log(`PhotoCull 已启动：${url}`);
  await open(url);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await closeSession();
      server.close(() => process.exit(0));
    });
  }
}
```

- [ ] **Step 9: 运行测试确认通过**

Run: `npx vitest run server/routes/routes.test.js`
Expected: PASS，17 个用例全绿

- [ ] **Step 10: 跑全量测试确认没有回归**

Run: `npm test`
Expected: PASS，Task 1–6 的测试全部通过

- [ ] **Step 11: 提交**

```bash
git add -A
git commit -m "feat: 会话管理与只读 HTTP 接口"
```

---

## Task 7: 后台烘焙队列

**Files:**
- Create: `server/lib/bake.js`
- Modify: `server/lib/session.js`（在 `openSession` 末尾启动烘焙）
- Test: `server/lib/bake.test.js`

**Interfaces:**
- Consumes: Task 5 `getThumb`、Task 6 `emit`
- Produces:
  - `startBake(session, opts?: {tier?: string}): void` — 幂等，重复调用不会起第二条队列
  - `stopBake(session): void`
  - `prioritizeBake(session, ids: string[]): void` — 把可视区的 id 插到队首

烘焙让位于实时请求：`thumbs.js` 的 `p-limit` 闸门本身就串行化了 sharp 调用，烘焙每处理一张后 `await setTimeout(0)` 让出事件循环，实时请求可以插进 limit 队列。

- [ ] **Step 1: 写失败的测试 `server/lib/bake.test.js`**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { startBake, stopBake, prioritizeBake } from './bake.js';
import { openSession, closeSession } from './session.js';
import { marksDir } from './store.js';

let tmp;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bake-')));
  for (let i = 0; i < 6; i++) {
    await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: i * 40, g: 60, b: 90 } } })
      .jpeg().toFile(path.join(tmp, `S${i}.JPG`));
  }
  await fs.writeFile(path.join(tmp, 'noJpg.CR3'), 'raw only');
});

afterEach(async () => {
  await closeSession();
  await fs.rm(tmp, { recursive: true, force: true });
});

const waitFor = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

describe('startBake', () => {
  it('把所有有 JPG 的资产烤进磁盘缓存', async () => {
    const session = await openSession(tmp);
    startBake(session);
    expect(await waitFor(() => session.bake.done === session.bake.total)).toBe(true);
    const files = await fs.readdir(path.join(marksDir(tmp), 'thumbs'));
    expect(files.filter((f) => f.endsWith('.webp'))).toHaveLength(6);
  });

  it('total 不含没有 JPG 的资产', async () => {
    const session = await openSession(tmp);
    expect(session.bake.total).toBe(6);
  });

  it('重复调用不会重复计数', async () => {
    const session = await openSession(tmp);
    startBake(session);
    startBake(session);
    startBake(session);
    expect(await waitFor(() => session.bake.done === session.bake.total)).toBe(true);
    expect(session.bake.done).toBe(6);
  });

  it('通过 SSE 广播进度', async () => {
    const session = await openSession(tmp);
    const seen = [];
    session.listeners.add((e) => { if (e.type === 'bake') seen.push(e.done); });
    startBake(session);
    expect(await waitFor(() => session.bake.done === session.bake.total)).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBe(6);
  });

  it('stopBake 之后不再推进', async () => {
    const session = await openSession(tmp);
    startBake(session);
    stopBake(session);
    const snapshot = session.bake.done;
    await new Promise((r) => setTimeout(r, 200));
    expect(session.bake.done).toBeLessThanOrEqual(snapshot + 1); // 最多完成正在处理的那一张
    expect(session.bake.running).toBe(false);
  });

  it('会话被关闭后烘焙自行终止', async () => {
    const session = await openSession(tmp);
    startBake(session);
    await closeSession();
    await new Promise((r) => setTimeout(r, 200));
    expect(session.aborted).toBe(true);
  });
});

describe('prioritizeBake', () => {
  it('把指定 id 提到队首优先烤', async () => {
    const session = await openSession(tmp);
    startBake(session);
    prioritizeBake(session, ['S5', 'S4']);
    expect(await waitFor(() => session.bake.done >= 2)).toBe(true);
    expect(session.bake.done).toBeGreaterThanOrEqual(2);
  });

  it('未知 id 被忽略且不报错', async () => {
    const session = await openSession(tmp);
    startBake(session);
    expect(() => prioritizeBake(session, ['ghost'])).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/lib/bake.test.js`
Expected: FAIL — 无法解析 `./bake.js`

- [ ] **Step 3: 实现 `server/lib/bake.js`**

```js
import { setTimeout as delay } from 'node:timers/promises';
import { getThumb } from './thumbs.js';
import { emit } from './session.js';

const state = new WeakMap();   // session -> { queue: string[], queued: Set, stopped: boolean }

export function startBake(session, { tier = 'grid' } = {}) {
  if (state.has(session)) return;   // 幂等

  const queue = session.assets.filter((a) => a.jpg).map((a) => a.id);
  const st = { queue, queued: new Set(queue), stopped: false };
  state.set(session, st);

  session.bake.running = true;
  emit(session, { type: 'bake', ...session.bake });

  (async () => {
    while (st.queue.length > 0) {
      if (st.stopped || session.aborted) break;
      const id = st.queue.shift();
      st.queued.delete(id);
      const asset = session.byId.get(id);
      if (!asset) continue;

      await getThumb(session.root, asset, tier);   // 失败也算处理过，不重试
      session.bake.done++;

      // 每 20 张播报一次，避免 SSE 刷屏
      if (session.bake.done % 20 === 0 || st.queue.length === 0) {
        emit(session, { type: 'bake', ...session.bake });
      }
      await delay(0);   // 让出事件循环，实时请求得以插队进入 sharp 闸门
    }
    session.bake.running = false;
    if (!session.aborted) emit(session, { type: 'bake', ...session.bake });
  })().catch((err) => {
    console.error('[bake] 队列异常', err);
    session.bake.running = false;
  });
}

export function stopBake(session) {
  const st = state.get(session);
  if (!st) return;
  st.stopped = true;
  st.queue.length = 0;
  st.queued.clear();
  session.bake.running = false;
}

/** 把可视区的 id 提到队首。已烤过的 id 不在队列里，自然被忽略。 */
export function prioritizeBake(session, ids) {
  const st = state.get(session);
  if (!st) return;
  const hoist = [];
  for (const id of ids) {
    if (st.queued.has(id)) {
      st.queued.delete(id);
      hoist.push(id);
    }
  }
  if (!hoist.length) return;
  st.queue = [...hoist, ...st.queue.filter((id) => !hoist.includes(id))];
  for (const id of hoist) st.queued.add(id);
}
```

- [ ] **Step 4: 在 `server/lib/session.js` 的 `openSession` 里启动烘焙**

在 `return session;` 之前插入：

```js
  // 动态 import 打破 bake.js ↔ session.js 的循环依赖
  import('./bake.js').then(({ startBake }) => {
    if (!session.aborted) startBake(session);
  });
```

同时在 `closeSession` 里，`old.aborted = true;` 之后插入：

```js
  const { stopBake } = await import('./bake.js');
  stopBake(old);
```

- [ ] **Step 5: 加一个提升烘焙优先级的接口**

在 `server/routes/library.js` 末尾追加：

```js
libraryRouter.post('/prioritize', requireSession, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 400).map(String) : [];
    const { prioritizeBake } = await import('../lib/bake.js');
    prioritizeBake(req.session, ids);
    res.json({ ok: true });
  } catch (err) { next(err); }
});
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run server/lib/bake.test.js`
Expected: PASS，8 个用例全绿

- [ ] **Step 7: 跑全量测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "feat: 后台缩略图烘焙队列"
```

---

## Task 8: 导出引擎（复制 / 移动 / 冲突 / 清单）

**Files:**
- Create: `server/lib/csv.js`, `server/lib/transfer.js`
- Test: `server/lib/csv.test.js`, `server/lib/transfer.test.js`

**Interfaces:**
- Consumes: Task 1 `isWithin`
- Produces（`csv.js`）：
  - `csvCell(value): string`、`csvRow(values: any[]): string`
- Produces（`transfer.js`）：
  - `class TransferError extends Error`
  - `planTarget(destPath, srcStat): Promise<{action:'skip'|'write'|'rename', finalPath: string}>`
  - `copyVerified(src, dest): Promise<void>` — 校验失败会删掉半成品并抛错
  - `moveVerified(src, dest): Promise<void>` — 严格「复制 → 校验 → 删源」
  - `runExport(opts, hooks): Promise<Summary>`
    - `opts = { root, destRoot, assets, marks, includeJpg, jpgSubdir, flatten, mode: 'copy'|'move', manifest }`
    - `hooks = { onProgress(p), signal }`，`p = { done, total, currentFile, skipped, renamed, errors }`
    - `Summary = { exported, skipped, renamed, missingRaw: string[], errors: {id,message}[], canceled, destRoot }`

- [ ] **Step 1: 写失败的测试 `server/lib/csv.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { csvCell, csvRow } from './csv.js';

describe('csvCell', () => {
  it('普通值原样输出', () => {
    expect(csvCell('IMG_1234')).toBe('IMG_1234');
  });
  it('含逗号的值加引号', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
  });
  it('含双引号的值转义成两个双引号', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });
  it('含换行的值加引号', () => {
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });
  it('null 与 undefined 输出空串', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
  it('数字转成字符串', () => {
    expect(csvCell(42)).toBe('42');
  });
  it('前导等号加引号防公式注入', () => {
    expect(csvCell('=1+1')).toBe('"=1+1"');
  });
});

describe('csvRow', () => {
  it('用逗号连接并以 CRLF 结尾', () => {
    expect(csvRow(['a', 'b,c', 1])).toBe('a,"b,c",1\r\n');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/lib/csv.test.js`
Expected: FAIL — 无法解析 `./csv.js`

- [ ] **Step 3: 实现 `server/lib/csv.js`**

```js
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // 前导 = + - @ 会被 Excel 当公式执行，一律加引号
  if (/[",\n\r]/.test(s) || /^[=+\-@]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export const csvRow = (values) => values.map(csvCell).join(',') + '\r\n';
```

- [ ] **Step 4: 运行 csv 测试确认通过**

Run: `npx vitest run server/lib/csv.test.js`
Expected: PASS，8 个用例全绿

- [ ] **Step 5: 写失败的测试 `server/lib/transfer.test.js`**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planTarget, copyVerified, moveVerified, runExport, TransferError } from './transfer.js';

let src, dest;

beforeEach(async () => {
  src = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tx-src-')));
  dest = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tx-dest-')));
});
afterEach(async () => {
  await fs.rm(src, { recursive: true, force: true });
  await fs.rm(dest, { recursive: true, force: true });
});

const write = async (dir, name, content) => {
  const p = path.join(dir, name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
  return p;
};

describe('planTarget', () => {
  it('目标不存在时写入', async () => {
    const s = await write(src, 'a.CR3', 'hello');
    const plan = await planTarget(path.join(dest, 'a.CR3'), await fs.stat(s));
    expect(plan.action).toBe('write');
    expect(plan.finalPath).toBe(path.join(dest, 'a.CR3'));
  });

  it('目标已存在且大小与 mtime 一致时跳过', async () => {
    const s = await write(src, 'a.CR3', 'hello');
    const st = await fs.stat(s);
    const d = await write(dest, 'a.CR3', 'hello');
    await fs.utimes(d, st.atime, st.mtime);
    const plan = await planTarget(d, st);
    expect(plan.action).toBe('skip');
  });

  it('目标存在但内容不同则改名', async () => {
    const s = await write(src, 'a.CR3', 'hello world');
    await write(dest, 'a.CR3', 'different');
    const plan = await planTarget(path.join(dest, 'a.CR3'), await fs.stat(s));
    expect(plan.action).toBe('rename');
    expect(path.basename(plan.finalPath)).toBe('a_1.CR3');
  });

  it('改名会一直找到可用的后缀', async () => {
    const s = await write(src, 'a.CR3', 'hello world');
    await write(dest, 'a.CR3', 'x');
    await write(dest, 'a_1.CR3', 'y');
    await write(dest, 'a_2.CR3', 'z');
    const plan = await planTarget(path.join(dest, 'a.CR3'), await fs.stat(s));
    expect(path.basename(plan.finalPath)).toBe('a_3.CR3');
  });

  it('mtime 差 1 秒以内仍算相同（FAT32 有 2 秒精度）', async () => {
    const s = await write(src, 'a.CR3', 'hello');
    const st = await fs.stat(s);
    const d = await write(dest, 'a.CR3', 'hello');
    await fs.utimes(d, st.atime, new Date(st.mtime.getTime() + 900));
    expect((await planTarget(d, st)).action).toBe('skip');
  });
});

describe('copyVerified', () => {
  it('复制后大小一致并保留 mtime', async () => {
    const s = await write(src, 'a.CR3', 'abcdef');
    const d = path.join(dest, 'sub', 'a.CR3');
    await copyVerified(s, d);
    expect(await fs.readFile(d, 'utf8')).toBe('abcdef');
    const [ss, ds] = [await fs.stat(s), await fs.stat(d)];
    expect(ds.size).toBe(ss.size);
    expect(Math.abs(ds.mtimeMs - ss.mtimeMs)).toBeLessThan(2000);
  });

  it('自动创建缺失的目标子目录', async () => {
    const s = await write(src, 'a.CR3', 'x');
    await copyVerified(s, path.join(dest, 'deep', 'deeper', 'a.CR3'));
    expect(await fs.readFile(path.join(dest, 'deep', 'deeper', 'a.CR3'), 'utf8')).toBe('x');
  });

  it('源文件不存在时抛错且不留下残片', async () => {
    const d = path.join(dest, 'ghost.CR3');
    await expect(copyVerified(path.join(src, 'ghost.CR3'), d)).rejects.toThrow();
    await expect(fs.access(d)).rejects.toThrow();
  });
});

describe('moveVerified', () => {
  it('复制校验通过后才删除源文件', async () => {
    const s = await write(src, 'a.CR3', 'payload');
    const d = path.join(dest, 'a.CR3');
    await moveVerified(s, d);
    expect(await fs.readFile(d, 'utf8')).toBe('payload');
    await expect(fs.access(s)).rejects.toThrow();
  });

  it('复制失败时源文件原封不动', async () => {
    const s = await write(src, 'a.CR3', 'payload');
    // 目标路径的父级是个文件，mkdir 必然失败
    await write(dest, 'blocker', 'x');
    await expect(moveVerified(s, path.join(dest, 'blocker', 'a.CR3'))).rejects.toThrow();
    expect(await fs.readFile(s, 'utf8')).toBe('payload');
  });
});

describe('runExport', () => {
  const mkAssets = async () => {
    await write(src, 'A.CR3', 'raw-a');
    await write(src, 'A.JPG', 'jpg-a');
    await write(src, 'cam-b/B.CR3', 'raw-b');
    await write(src, 'cam-b/B.JPG', 'jpg-b');
    await write(src, 'C.JPG', 'jpg-c-only');
    return [
      { id: 'A', dir: '', stem: 'A', raws: ['A.CR3'], jpg: 'A.JPG' },
      { id: 'cam-b/B', dir: 'cam-b', stem: 'B', raws: ['B.CR3'], jpg: 'B.JPG' },
      { id: 'C', dir: '', stem: 'C', raws: [], jpg: 'C.JPG' },
    ];
  };
  const marks = { A: 'pick', 'cam-b/B': 'pick', C: 'pick' };

  it('只导出收藏的 RAW，保留相对目录结构', async () => {
    const assets = await mkAssets();
    const s = await runExport({ root: src, destRoot: dest, assets, marks, mode: 'copy' }, {});
    expect(s.exported).toBe(2);
    expect(await fs.readFile(path.join(dest, 'A.CR3'), 'utf8')).toBe('raw-a');
    expect(await fs.readFile(path.join(dest, 'cam-b', 'B.CR3'), 'utf8')).toBe('raw-b');
  });

  it('没有 RAW 的收藏项计入 missingRaw 而不是静默丢弃', async () => {
    const assets = await mkAssets();
    const s = await runExport({ root: src, destRoot: dest, assets, marks, mode: 'copy' }, {});
    expect(s.missingRaw).toEqual(['C']);
  });

  it('未收藏的资产不导出', async () => {
    const assets = await mkAssets();
    const s = await runExport({ root: src, destRoot: dest, assets, marks: { A: 'pick' }, mode: 'copy' }, {});
    expect(s.exported).toBe(1);
    await expect(fs.access(path.join(dest, 'cam-b', 'B.CR3'))).rejects.toThrow();
  });

  it('reject 的资产即使在 marks 里也不导出', async () => {
    const assets = await mkAssets();
    const s = await runExport(
      { root: src, destRoot: dest, assets, marks: { A: 'pick', 'cam-b/B': 'reject' }, mode: 'copy' }, {});
    expect(s.exported).toBe(1);
  });

  it('flatten 把所有文件放进单层目录', async () => {
    const assets = await mkAssets();
    await runExport({ root: src, destRoot: dest, assets, marks, mode: 'copy', flatten: true }, {});
    expect(await fs.readFile(path.join(dest, 'B.CR3'), 'utf8')).toBe('raw-b');
  });

  it('includeJpg 同时复制 JPG', async () => {
    const assets = await mkAssets();
    await runExport({ root: src, destRoot: dest, assets, marks, mode: 'copy', includeJpg: true }, {});
    expect(await fs.readFile(path.join(dest, 'A.JPG'), 'utf8')).toBe('jpg-a');
  });

  it('jpgSubdir 把 JPG 放进子目录', async () => {
    const assets = await mkAssets();
    await runExport({
      root: src, destRoot: dest, assets, marks, mode: 'copy', includeJpg: true, jpgSubdir: 'JPG',
    }, {});
    expect(await fs.readFile(path.join(dest, 'JPG', 'A.JPG'), 'utf8')).toBe('jpg-a');
  });

  it('一个资产的多个 RAW 全部导出', async () => {
    await write(src, 'M.CR3', 'r1');
    await write(src, 'M.DNG', 'r2');
    const assets = [{ id: 'M', dir: '', stem: 'M', raws: ['M.CR3', 'M.DNG'], jpg: null }];
    const s = await runExport({ root: src, destRoot: dest, assets, marks: { M: 'pick' }, mode: 'copy' }, {});
    expect(s.exported).toBe(2);
  });

  it('move 模式导出后源 RAW 消失', async () => {
    const assets = await mkAssets();
    await runExport({ root: src, destRoot: dest, assets, marks, mode: 'move' }, {});
    await expect(fs.access(path.join(src, 'A.CR3'))).rejects.toThrow();
    expect(await fs.readFile(path.join(dest, 'A.CR3'), 'utf8')).toBe('raw-a');
  });

  it('拒绝导出到源目录内部', async () => {
    const assets = await mkAssets();
    await expect(runExport(
      { root: src, destRoot: path.join(src, 'out'), assets, marks, mode: 'copy' }, {}))
      .rejects.toBeInstanceOf(TransferError);
  });

  it('拒绝导出到源目录本身', async () => {
    const assets = await mkAssets();
    await expect(runExport({ root: src, destRoot: src, assets, marks, mode: 'copy' }, {}))
      .rejects.toBeInstanceOf(TransferError);
  });

  it('生成 manifest.csv 与 rejected.txt', async () => {
    const assets = await mkAssets();
    await runExport({
      root: src, destRoot: dest, assets,
      marks: { A: 'pick', 'cam-b/B': 'reject' }, mode: 'copy', manifest: true,
      metas: new Map([['A', { time: Date.parse('2026-07-26T09:00:00Z') }]]),
    }, {});
    const csv = await fs.readFile(path.join(dest, 'manifest.csv'), 'utf8');
    expect(csv).toContain('assetId');
    expect(csv).toContain('A');
    const rejected = await fs.readFile(path.join(dest, 'rejected.txt'), 'utf8');
    expect(rejected.trim()).toBe('cam-b/B');
  });

  it('上报进度', async () => {
    const assets = await mkAssets();
    const seen = [];
    await runExport({ root: src, destRoot: dest, assets, marks, mode: 'copy' },
      { onProgress: (p) => seen.push(p.done) });
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBe(2);
  });

  it('signal 中止后停止处理并标记 canceled', async () => {
    const assets = await mkAssets();
    const ctrl = new AbortController();
    ctrl.abort();
    const s = await runExport({ root: src, destRoot: dest, assets, marks, mode: 'copy' },
      { signal: ctrl.signal });
    expect(s.canceled).toBe(true);
    expect(s.exported).toBe(0);
  });

  it('单个文件出错不中断整场导出', async () => {
    await write(src, 'ok.CR3', 'fine');
    const assets = [
      { id: 'ok', dir: '', stem: 'ok', raws: ['ok.CR3'], jpg: null },
      { id: 'gone', dir: '', stem: 'gone', raws: ['gone.CR3'], jpg: null },
    ];
    const s = await runExport({
      root: src, destRoot: dest, assets, marks: { ok: 'pick', gone: 'pick' }, mode: 'copy',
    }, {});
    expect(s.exported).toBe(1);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0].id).toBe('gone');
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run server/lib/transfer.test.js`
Expected: FAIL — 无法解析 `./transfer.js`

- [ ] **Step 7: 实现 `server/lib/transfer.js`**

```js
import fs from 'node:fs/promises';
import path from 'node:path';
import { isWithin } from './safepath.js';
import { csvRow } from './csv.js';

export class TransferError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransferError';
    this.status = 400;
  }
}

const MTIME_TOLERANCE_MS = 2000;   // FAT32 的 mtime 精度是 2 秒

export async function planTarget(destPath, srcStat) {
  let st;
  try {
    st = await fs.stat(destPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { action: 'write', finalPath: destPath };
    throw err;
  }
  if (st.size === srcStat.size && Math.abs(st.mtimeMs - srcStat.mtimeMs) < MTIME_TOLERANCE_MS) {
    return { action: 'skip', finalPath: destPath };
  }
  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const stem = path.basename(destPath, ext);
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, `${stem}_${i}${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return { action: 'rename', finalPath: candidate };
    }
  }
  throw new TransferError(`${destPath} 的重名后缀已用尽`);
}

export async function copyVerified(src, dest) {
  const srcStat = await fs.stat(src);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);

  const destStat = await fs.stat(dest);
  if (destStat.size !== srcStat.size) {
    await fs.rm(dest, { force: true });   // 不留半成品
    throw new TransferError(`复制校验失败：${src} 大小 ${srcStat.size} → ${destStat.size}`);
  }
  await fs.utimes(dest, srcStat.atime, srcStat.mtime);
}

/** 严格顺序：复制 → 校验 → 删源。校验通过前源文件绝不被碰。 */
export async function moveVerified(src, dest) {
  await copyVerified(src, dest);
  await fs.rm(src);
}

const joinRel = (root, dir, name) => path.join(root, ...String(dir).split('/').filter(Boolean), name);

export async function runExport(opts, hooks = {}) {
  const {
    root, destRoot, assets, marks,
    includeJpg = false, jpgSubdir = '', flatten = false,
    mode = 'copy', manifest = false, metas = new Map(),
  } = opts;
  const { onProgress, signal } = hooks;

  if (isWithin(root, destRoot)) {
    throw new TransferError('导出目标不能是源文件夹本身或其子目录');
  }

  const picked = assets.filter((a) => marks[a.id] === 'pick');
  const rejected = assets.filter((a) => marks[a.id] === 'reject').map((a) => a.id);

  const jobs = [];
  const missingRaw = [];
  for (const asset of picked) {
    if (asset.raws.length === 0) missingRaw.push(asset.id);
    for (const raw of asset.raws) jobs.push({ asset, name: raw, kind: 'raw' });
    if (includeJpg && asset.jpg) jobs.push({ asset, name: asset.jpg, kind: 'jpg' });
  }

  const summary = {
    exported: 0, skipped: 0, renamed: 0,
    missingRaw, errors: [], canceled: false, destRoot,
    total: jobs.length,
  };
  const manifestRows = [];

  await fs.mkdir(destRoot, { recursive: true });

  let done = 0;
  for (const job of jobs) {
    if (signal?.aborted) { summary.canceled = true; break; }

    const src = joinRel(root, job.asset.dir, job.name);
    const relDir = flatten ? '' : job.asset.dir;
    const subdir = job.kind === 'jpg' && jpgSubdir ? jpgSubdir : '';
    const dest = path.join(destRoot, subdir, ...relDir.split('/').filter(Boolean), job.name);

    try {
      const srcStat = await fs.stat(src);
      const plan = await planTarget(dest, srcStat);

      if (plan.action === 'skip') {
        summary.skipped++;
      } else {
        if (mode === 'move') await moveVerified(src, plan.finalPath);
        else await copyVerified(src, plan.finalPath);
        summary.exported++;
        if (plan.action === 'rename') summary.renamed++;
      }
      if (job.kind === 'raw') {
        manifestRows.push([
          job.asset.id, 'pick', job.name, job.asset.jpg ?? '',
          metas.get(job.asset.id)?.time ? new Date(metas.get(job.asset.id).time).toISOString() : '',
          path.relative(destRoot, plan.finalPath),
        ]);
      }
    } catch (err) {
      summary.errors.push({ id: job.asset.id, message: err.message });
    }

    done++;
    onProgress?.({
      done, total: jobs.length, currentFile: job.name,
      skipped: summary.skipped, renamed: summary.renamed, errors: summary.errors.length,
    });
  }

  if (manifest && !summary.canceled) {
    const header = csvRow(['assetId', 'mark', 'rawFile', 'jpgFile', 'captureTime', 'exportedAs']);
    await fs.writeFile(
      path.join(destRoot, 'manifest.csv'),
      '\uFEFF' + header + manifestRows.map(csvRow).join(''),   // BOM 让 Excel 正确识别 UTF-8
      'utf8');
    await fs.writeFile(path.join(destRoot, 'rejected.txt'), rejected.join('\n') + '\n', 'utf8');
  }

  return summary;
}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `npx vitest run server/lib/transfer.test.js`
Expected: PASS，25 个用例全绿

- [ ] **Step 9: 跑全量测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 10: 提交**

```bash
git add -A
git commit -m "feat: 导出引擎与 CSV 清单"
```

---

## Task 9: 导出 HTTP 接口与 SSE 进度

**Files:**
- Create: `server/routes/export.js`
- Modify: `server/index.js`（挂载 `/api/export`）
- Test: `server/routes/export.test.js`

**Interfaces:**
- Consumes: Task 6 `requireSession`、Task 8 `runExport`、Task 1 `assertWithin`
- Produces：

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/api/export` | `{destRoot, includeJpg, jpgSubdir, flatten, mode, manifest, confirmCount}` | `{jobId, total}` |
| GET | `/api/export/:jobId/stream` | — | SSE：`{type:'progress',...}` / `{type:'done',summary}` / `{type:'error',message}` |
| POST | `/api/export/:jobId/cancel` | — | `{ok:true}` |

`mode:'move'` 时必须传 `confirmCount`，且必须等于服务端算出的待移动文件数，否则 400。这是「输入数量确认」这道坎的服务端强制点——前端弹窗只是 UI，真正的闸门在这里。

- [ ] **Step 1: 写失败的测试 `server/routes/export.test.js`**

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../index.js';
import { closeSession } from '../lib/session.js';

let server, base, tmp, out;

const api = (p, init) => fetch(base + p, init);
const post = (p, body) => api(p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
});

async function waitDone(jobId) {
  const res = await api(`/api/export/${jobId}/stream`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (const line of buf.split('\n\n')) {
      if (!line.startsWith('data: ')) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === 'done') { reader.cancel(); return event.summary; }
      if (event.type === 'error') { reader.cancel(); throw new Error(event.message); }
    }
  }
  throw new Error('SSE 在 done 之前结束');
}

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'exp-src-')));
  out = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'exp-out-')));
  await fs.mkdir(path.join(tmp, 'cam-a'), { recursive: true });
  for (const [dir, stem] of [['', 'A'], ['cam-a', 'B']]) {
    await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 5, g: 5, b: 5 } } })
      .jpeg().toFile(path.join(tmp, dir, `${stem}.JPG`));
    await fs.writeFile(path.join(tmp, dir, `${stem}.CR3`), `raw-${stem}`);
  }

  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  await post('/api/library/open', { root: tmp });
  await api('/api/library/marks', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ marks: { A: 'pick', 'cam-a/B': 'pick' } }),
  });
});

afterAll(async () => {
  await closeSession();
  await new Promise((r) => server.close(r));
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(out, { recursive: true, force: true });
});

describe('POST /api/export', () => {
  it('复制模式导出收藏的 RAW', async () => {
    const { jobId, total } = await (await post('/api/export', { destRoot: out, mode: 'copy' })).json();
    expect(total).toBe(2);
    const summary = await waitDone(jobId);
    expect(summary.exported).toBe(2);
    expect(await fs.readFile(path.join(out, 'A.CR3'), 'utf8')).toBe('raw-A');
    expect(await fs.readFile(path.join(out, 'cam-a', 'B.CR3'), 'utf8')).toBe('raw-B');
  });

  it('重复导出到同一目录全部跳过', async () => {
    const { jobId } = await (await post('/api/export', { destRoot: out, mode: 'copy' })).json();
    const summary = await waitDone(jobId);
    expect(summary.skipped).toBe(2);
    expect(summary.exported).toBe(0);
  });

  it('move 模式缺少 confirmCount 时拒绝', async () => {
    const res = await post('/api/export', { destRoot: out, mode: 'move' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('确认');
  });

  it('move 模式 confirmCount 不匹配时拒绝', async () => {
    const res = await post('/api/export', { destRoot: out, mode: 'move', confirmCount: 99 });
    expect(res.status).toBe(400);
  });

  it('拒绝导出到源文件夹内部', async () => {
    const res = await post('/api/export', { destRoot: path.join(tmp, 'inside'), mode: 'copy' });
    expect(res.status).toBe(400);
  });

  it('拒绝越界的导出目标', async () => {
    const res = await post('/api/export', { destRoot: '/etc/photocull-out', mode: 'copy' });
    expect(res.status).toBe(403);
  });

  it('未打开库时返回 409', async () => {
    await closeSession();
    expect((await post('/api/export', { destRoot: out, mode: 'copy' })).status).toBe(409);
    await post('/api/library/open', { root: tmp });
    await api('/api/library/marks', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marks: { A: 'pick', 'cam-a/B': 'pick' } }),
    });
  });
});

describe('导出 SSE 与取消', () => {
  it('未知 jobId 的 stream 返回 404', async () => {
    expect((await api('/api/export/nope/stream')).status).toBe(404);
  });

  it('cancel 未知 jobId 返回 404', async () => {
    expect((await post('/api/export/nope/cancel')).status).toBe(404);
  });

  it('导出完成后 summary 里带 destRoot', async () => {
    const out2 = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'exp-out2-')));
    const { jobId } = await (await post('/api/export', { destRoot: out2, mode: 'copy', manifest: true })).json();
    const summary = await waitDone(jobId);
    expect(summary.destRoot).toBe(out2);
    expect(await fs.readFile(path.join(out2, 'manifest.csv'), 'utf8')).toContain('assetId');
    await fs.rm(out2, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run server/routes/export.test.js`
Expected: FAIL — 无法解析 `./export.js`

- [ ] **Step 3: 实现 `server/routes/export.js`**

```js
import express from 'express';
import crypto from 'node:crypto';
import { assertWithin } from '../lib/safepath.js';
import { browseRoots } from '../lib/session.js';
import { requireSession } from './library.js';
import { runExport } from '../lib/transfer.js';

export const exportRouter = express.Router();

const jobs = new Map();   // jobId -> { events, listeners, finished, controller, summary, error }

const JOB_TTL_MS = 10 * 60 * 1000;

function createJob() {
  const job = {
    id: crypto.randomUUID(),
    events: [],
    listeners: new Set(),
    finished: false,
    controller: new AbortController(),
    summary: null,
    error: null,
  };
  jobs.set(job.id, job);
  setTimeout(() => jobs.delete(job.id), JOB_TTL_MS).unref?.();
  return job;
}

function push(job, event) {
  job.events.push(event);
  for (const fn of job.listeners) {
    try { fn(event); } catch { /* 订阅者已断开 */ }
  }
}

/** 数一遍这次会动多少个文件 —— move 模式的确认闸门要跟它比对。 */
function countJobs(session, { includeJpg }) {
  let n = 0;
  for (const asset of session.assets) {
    if (session.markStore.data.marks[asset.id] !== 'pick') continue;
    n += asset.raws.length;
    if (includeJpg && asset.jpg) n += 1;
  }
  return n;
}

exportRouter.post('/', requireSession, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const mode = body.mode === 'move' ? 'move' : 'copy';
    const includeJpg = body.includeJpg === true;

    const destRoot = await assertWithin(await browseRoots(), String(body.destRoot ?? ''));
    const total = countJobs(req.session, { includeJpg });

    if (mode === 'move') {
      if (!Number.isInteger(body.confirmCount)) {
        return res.status(400).json({ error: '移动模式必须输入确认数量' });
      }
      if (body.confirmCount !== total) {
        return res.status(400).json({ error: `确认数量不符：应为 ${total}，收到 ${body.confirmCount}` });
      }
    }

    const job = createJob();
    res.json({ jobId: job.id, total });

    const opts = {
      root: req.session.root,
      destRoot,
      assets: req.session.assets,
      marks: req.session.markStore.data.marks,
      metas: req.session.metas,
      includeJpg,
      jpgSubdir: typeof body.jpgSubdir === 'string' ? body.jpgSubdir : '',
      flatten: body.flatten === true,
      manifest: body.manifest !== false,
      mode,
    };

    runExport(opts, {
      signal: job.controller.signal,
      onProgress: (p) => push(job, { type: 'progress', ...p }),
    }).then((summary) => {
      job.summary = summary;
      job.finished = true;
      push(job, { type: 'done', summary });
    }).catch((err) => {
      job.error = err.message;
      job.finished = true;
      push(job, { type: 'error', message: err.message });
    });
  } catch (err) { next(err); }
});

exportRouter.get('/:jobId/stream', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: '未知导出任务' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  for (const event of job.events) send(event);   // 补发已发生的事件，订阅者不会漏
  if (job.finished) return res.end();

  job.listeners.add(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); job.listeners.delete(send); });
});

exportRouter.post('/:jobId/cancel', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: '未知导出任务' });
  job.controller.abort();
  res.json({ ok: true });
});
```

- [ ] **Step 4: 在 `server/index.js` 里挂载**

在 `import { imageRouter } …` 之后加：

```js
import { exportRouter } from './routes/export.js';
```

在 `app.use('/api', imageRouter);` 之后加：

```js
  app.use('/api/export', exportRouter);
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run server/routes/export.test.js`
Expected: PASS，10 个用例全绿

- [ ] **Step 6: 跑全量测试**

Run: `npm test`
Expected: PASS，服务端全部测试通过

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat: 导出 HTTP 接口与 SSE 进度"
```

---

## Task 10: 前端脚手架与文件夹选择

**Files:**
- Create: `vite.config.js`, `tsconfig.json`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/types.ts`, `web/src/styles.css`, `web/src/lib/api.ts`, `web/src/store/library.ts`, `web/src/components/DirBrowser.tsx`, `web/src/components/FolderPicker.tsx`
- Test: 手动验收（本任务无纯逻辑可测）

**Interfaces:**
- Consumes: Task 6 的 HTTP 契约
- Produces:
  - `types.ts`：`Asset`、`AssetMeta`、`Mark`、`Settings`、`FilterTab`
  - `api.ts`：`getJSON<T>(path)`、`postJSON<T>(path, body)`、`putJSON<T>(path, body)`、`openStream(path, onEvent): () => void`
  - `store/library.ts`：`useLibrary` — `{ root, assets, metas, settings, phase, warnings, open(root), close() }`
    - `phase: 'idle' | 'scanning' | 'ready'`，`metas: Map<string, AssetMeta>`
  - `components/DirBrowser.tsx`：`<DirBrowser onLocationChange={(path) => void} maxHeight?={number} rowAction?={(dir) => ReactNode} />`
    - 纯导航器：只负责「现在浏览到哪个目录」，选中语义留给父组件。**Task 17 的导出面板复用同一个组件**，两处不得各写一份目录浏览逻辑。

- [ ] **Step 1: 写 `vite.config.js`**

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../server/public', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:5183', changeOrigin: false } },
  },
});
```

- [ ] **Step 2: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["web/src"]
}
```

- [ ] **Step 3: 写 `web/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>PhotoCull 选图</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: 写 `web/src/types.ts`**

```ts
export type Mark = 'pick' | 'reject';

export interface Asset {
  id: string;
  dir: string;
  stem: string;
  raws: string[];
  jpg: string | null;
  jpgSize: number;
  jpgMtimeMs: number;
}

export interface AssetMeta {
  id: string;
  time: number;
  timeSource: 'exif' | 'createDate' | 'mtime';
  orientation: number;
  body: string;
  iso: number | null;
  fNumber: number | null;
  exposureTime: number | null;
  focalLength: number | null;
}

export interface Settings {
  burstThresholdMs: number;
  gridSize: 'small' | 'medium' | 'large';
  sort: 'time' | 'name';
}

export type FilterTab = 'all' | 'pick' | 'reject' | 'none';
```

- [ ] **Step 5: 写 `web/src/lib/api.ts`**

```ts
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(body.error ?? res.statusText), { status: res.status });
  }
  return res.json() as Promise<T>;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const getJSON = <T,>(path: string) => req<T>(path);
export const postJSON = <T,>(path: string, body: unknown = {}) => req<T>(path, jsonInit('POST', body));
export const putJSON = <T,>(path: string, body: unknown = {}) => req<T>(path, jsonInit('PUT', body));

/** 订阅 SSE，返回取消订阅函数。 */
export function openStream(path: string, onEvent: (event: any) => void): () => void {
  const source = new EventSource(path);
  source.onmessage = (e) => {
    try { onEvent(JSON.parse(e.data)); } catch { /* 忽略心跳等非 JSON 帧 */ }
  };
  source.onerror = () => { /* EventSource 会自动重连，不做处理 */ };
  return () => source.close();
}
```

- [ ] **Step 6: 写 `web/src/store/library.ts`**

```ts
import { create } from 'zustand';
import { getJSON, postJSON, openStream } from '../lib/api';
import type { Asset, AssetMeta, Settings } from '../types';

interface OpenResult {
  root: string;
  assetCount: number;
  warnings: string[];
  skippedFiles: number;
  settings: Settings;
  marksRecovered: boolean;
}

interface LibraryState {
  root: string | null;
  assets: Asset[];
  metas: Map<string, AssetMeta>;
  settings: Settings;
  warnings: string[];
  skippedFiles: number;
  metaDone: boolean;
  bake: { done: number; total: number };
  phase: 'idle' | 'scanning' | 'ready';
  error: string | null;
  open: (root: string) => Promise<void>;
  close: () => Promise<void>;
}

let stopStream: (() => void) | null = null;

export const useLibrary = create<LibraryState>((set, get) => ({
  root: null,
  assets: [],
  metas: new Map(),
  settings: { burstThresholdMs: 1000, gridSize: 'medium', sort: 'time' },
  warnings: [],
  skippedFiles: 0,
  metaDone: false,
  bake: { done: 0, total: 0 },
  phase: 'idle',
  error: null,

  async open(root) {
    stopStream?.();
    set({ phase: 'scanning', error: null, assets: [], metas: new Map(), metaDone: false });
    try {
      const info = await postJSON<OpenResult>('/api/library/open', { root });
      const { assets } = await getJSON<{ assets: Asset[] }>('/api/library/assets');
      set({
        root: info.root, assets, settings: info.settings,
        warnings: info.warnings, skippedFiles: info.skippedFiles, phase: 'ready',
      });

      stopStream = openStream('/api/library/stream', (event) => {
        if (event.type === 'meta') {
          // 复制一份 Map 才能触发 zustand 的订阅者更新
          const next = new Map(get().metas);
          for (const m of event.metas as AssetMeta[]) next.set(m.id, m);
          set({ metas: next });
        } else if (event.type === 'metaDone') {
          set({ metaDone: true });
        } else if (event.type === 'bake') {
          set({ bake: { done: event.done, total: event.total } });
        }
      });
    } catch (err) {
      set({ phase: 'idle', error: (err as Error).message });
    }
  },

  async close() {
    stopStream?.();
    stopStream = null;
    await postJSON('/api/library/close');
    set({ root: null, assets: [], metas: new Map(), phase: 'idle', metaDone: false });
  },
}));
```

- [ ] **Step 7: 写 `web/src/components/DirBrowser.tsx`**

选源文件夹和选导出目标是同一件事，只是选中后的动作不同。做成一个受控导航器，Task 17 直接复用。

```tsx
import { useEffect, useState, type ReactNode } from 'react';
import { getJSON } from '../lib/api';

interface Listing { path: string; parent: string; dirs: { name: string; path: string }[] }

interface Props {
  /** 每次导航后回报当前所在目录。父组件决定「当前目录」意味着什么。 */
  onLocationChange: (path: string) => void;
  maxHeight?: number;
  /** 每行右侧的额外操作，比如 FolderPicker 的「直接打开」。 */
  rowAction?: (dir: { name: string; path: string }) => ReactNode;
}

export function DirBrowser({ onLocationChange, maxHeight = 260, rowAction }: Props) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);

  const browse = async (path?: string) => {
    setError(null);
    try {
      const next = await getJSON<Listing>(
        `/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`);
      setListing(next);
      onLocationChange(next.path);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => { void browse(); }, []);

  return (
    <div className="dirbrowser">
      <div className="dirbrowser-path">
        <button onClick={() => listing && void browse(listing.parent)} disabled={!listing}>上级</button>
        <code>{listing?.path ?? '…'}</code>
      </div>
      <ul className="dirbrowser-list" style={{ maxHeight }}>
        {listing?.dirs.map((d) => (
          <li key={d.path}>
            <button className="dirbrowser-name" onClick={() => void browse(d.path)}>{d.name}</button>
            {rowAction?.(d)}
          </li>
        ))}
        {listing?.dirs.length === 0 && <li className="muted">（没有子文件夹）</li>}
      </ul>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 7b: 写 `web/src/components/FolderPicker.tsx`**

```tsx
import { useState } from 'react';
import { useLibrary } from '../store/library';
import { DirBrowser } from './DirBrowser';

const RECENT_KEY = 'photocull.recent';

const readRecent = (): string[] => {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); } catch { return []; }
};

export function rememberRecent(root: string) {
  const next = [root, ...readRecent().filter((p) => p !== root)].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

export function FolderPicker() {
  const [here, setHere] = useState('');
  const [manual, setManual] = useState('');
  const recent = readRecent();
  const open = useLibrary((s) => s.open);
  const phase = useLibrary((s) => s.phase);
  const libError = useLibrary((s) => s.error);

  const choose = async (root: string) => {
    rememberRecent(root);
    await open(root);
  };

  return (
    <div className="picker">
      <h1>选择照片文件夹</h1>

      {recent.length > 0 && (
        <div className="picker-recent">
          <h2>最近打开</h2>
          {recent.map((p) => (
            <button key={p} className="picker-recent-item" onClick={() => void choose(p)}>{p}</button>
          ))}
        </div>
      )}

      <DirBrowser
        onLocationChange={setHere}
        maxHeight={Math.round(window.innerHeight * 0.44)}
        rowAction={(d) => (
          <button className="ghost" onClick={() => void choose(d.path)}>打开</button>
        )}
      />

      <div className="picker-actions">
        <button className="primary" onClick={() => here && void choose(here)}
                disabled={!here || phase === 'scanning'}>
          {phase === 'scanning' ? '正在扫描…' : '打开当前文件夹'}
        </button>
      </div>

      <div className="picker-manual">
        <input value={manual} onChange={(e) => setManual(e.target.value)}
               placeholder="或直接粘贴绝对路径" />
        <button onClick={() => manual.trim() && void choose(manual.trim())}>打开</button>
      </div>

      {libError && <p className="error">{libError}</p>}
    </div>
  );
}
```

- [ ] **Step 8: 写 `web/src/App.tsx` 与 `web/src/main.tsx`**

`App.tsx`（本任务只到「打开后显示资产数」，网格在 Task 13 接上）：

```tsx
import { useLibrary } from './store/library';
import { FolderPicker } from './components/FolderPicker';

export function App() {
  const phase = useLibrary((s) => s.phase);
  const root = useLibrary((s) => s.root);
  const assets = useLibrary((s) => s.assets);
  const metas = useLibrary((s) => s.metas);
  const bake = useLibrary((s) => s.bake);
  const close = useLibrary((s) => s.close);

  if (phase !== 'ready') return <FolderPicker />;

  return (
    <div className="app">
      <header className="topbar">
        <button onClick={() => void close()}>← 换文件夹</button>
        <code>{root}</code>
        <span>{assets.length} 张</span>
        <span>元数据 {metas.size}/{assets.length}</span>
        <span>缓存 {bake.done}/{bake.total}</span>
      </header>
    </div>
  );
}
```

`main.tsx`：

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
```

- [ ] **Step 9: 写 `web/src/styles.css` 的基础骨架**

```css
:root {
  --bg: #17171a;
  --bg-2: #202024;
  --fg: #e8e8ec;
  --muted: #8a8a95;
  --line: #32323a;
  --pick: #37c26b;
  --reject: #e2564c;
  --accent: #5b9dff;
  color-scheme: dark;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  overscroll-behavior: none;
}

button {
  background: var(--bg-2); color: var(--fg); border: 1px solid var(--line);
  border-radius: 6px; padding: 6px 12px; cursor: pointer; font: inherit;
}
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: .45; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #08111f; font-weight: 600; }
button.ghost { background: none; border-color: transparent; color: var(--muted); }

code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
.muted { color: var(--muted); }
.error { color: var(--reject); }

.picker { max-width: 760px; margin: 8vh auto; padding: 0 24px; }
.picker h1 { font-size: 20px; font-weight: 600; }
.picker h2 { font-size: 13px; font-weight: 600; color: var(--muted); margin: 20px 0 8px; }
.picker-recent-item { display: block; width: 100%; text-align: left; margin-bottom: 4px; font-family: ui-monospace, monospace; }
.dirbrowser-path { display: flex; gap: 10px; align-items: center; margin: 16px 0; }
.dirbrowser-path code { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dirbrowser-list { list-style: none; padding: 0; margin: 0; overflow: auto;
  border: 1px solid var(--line); border-radius: 8px; }
.dirbrowser-list li { display: flex; justify-content: space-between; padding: 2px 8px; }
.dirbrowser-name { flex: 1; text-align: left; background: none; border-color: transparent; }
.picker-actions { display: flex; justify-content: flex-end; margin-top: 12px; }
.picker-manual { display: flex; gap: 8px; margin-top: 16px; }
.picker-manual input { flex: 1; background: var(--bg-2); color: var(--fg);
  border: 1px solid var(--line); border-radius: 6px; padding: 7px 10px; font: inherit; }

.topbar { display: flex; gap: 16px; align-items: center; padding: 10px 16px;
  border-bottom: 1px solid var(--line); background: var(--bg-2); }
```

- [ ] **Step 10: 类型检查通过**

Run: `npx tsc --noEmit`
Expected: 无错误输出

- [ ] **Step 11: 手动验收**

分两个终端跑：

```bash
npm run dev
```

浏览器开 `http://127.0.0.1:5173`，确认：目录能一级级点进去；点「打开当前文件夹」后顶栏出现路径、张数，「元数据 N/M」在几秒内涨到满；「缓存 N/M」持续增长。刷新页面后「最近打开」里有刚才那个路径。

- [ ] **Step 12: 提交**

```bash
git add -A
git commit -m "feat: 前端脚手架与文件夹选择"
```

---

## Task 11: 连拍分组纯函数

**Files:**
- Create: `web/src/lib/bursts.ts`
- Test: `web/src/lib/bursts.test.ts`

**Interfaces:**
- Consumes: `types.ts` 的 `AssetMeta`
- Produces:
  - `interface BurstItem { id: string; time: number; timeSource: AssetMeta['timeSource']; body: string }`
  - `interface Group { key: string; ids: string[] }` — `key` 是组内第一张的 id
  - `groupBursts(items: BurstItem[], thresholdMs: number): Group[]` — **覆盖全部输入**，单张也返回长度为 1 的组，这样网格里「一个格子 = 一个组」的渲染是统一的

- [ ] **Step 1: 写失败的测试 `web/src/lib/bursts.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { groupBursts, type BurstItem } from './bursts';

const item = (id: string, time: number, body = 'R5|SN1',
              timeSource: BurstItem['timeSource'] = 'exif'): BurstItem =>
  ({ id, time, timeSource, body });

describe('groupBursts', () => {
  it('空输入返回空数组', () => {
    expect(groupBursts([], 1000)).toEqual([]);
  });

  it('单张返回一个长度为 1 的组', () => {
    expect(groupBursts([item('a', 0)], 1000)).toEqual([{ key: 'a', ids: ['a'] }]);
  });

  it('间隔小于阈值且同机身的相邻两张合成一组', () => {
    const groups = groupBursts([item('a', 0), item('b', 500)], 1000);
    expect(groups).toEqual([{ key: 'a', ids: ['a', 'b'] }]);
  });

  it('间隔恰好等于阈值仍算同组', () => {
    expect(groupBursts([item('a', 0), item('b', 1000)], 1000)[0].ids).toEqual(['a', 'b']);
  });

  it('间隔超过阈值则分开', () => {
    const groups = groupBursts([item('a', 0), item('b', 1001)], 1000);
    expect(groups.map((g) => g.ids)).toEqual([['a'], ['b']]);
  });

  it('链式合并：a-b 近、b-c 近，三张合成一组', () => {
    const groups = groupBursts([item('a', 0), item('b', 400), item('c', 800)], 500);
    expect(groups).toHaveLength(1);
    expect(groups[0].ids).toEqual(['a', 'b', 'c']);
  });

  it('不同机身即使时间重合也不合并', () => {
    const groups = groupBursts([item('a', 0, 'R5|SN1'), item('b', 10, 'Z9|SN2')], 1000);
    expect(groups.map((g) => g.ids)).toEqual([['a'], ['b']]);
  });

  it('时间戳完全相同且同机身仍合并', () => {
    expect(groupBursts([item('a', 500), item('b', 500)], 1000)[0].ids).toEqual(['a', 'b']);
  });

  it('timeSource 为 mtime 的照片永不参与合并', () => {
    const groups = groupBursts(
      [item('a', 0, 'R5|SN1', 'mtime'), item('b', 100, 'R5|SN1', 'mtime')], 1000);
    expect(groups.map((g) => g.ids)).toEqual([['a'], ['b']]);
  });

  it('一端是 mtime 也不合并', () => {
    const groups = groupBursts(
      [item('a', 0, 'R5|SN1', 'exif'), item('b', 100, 'R5|SN1', 'mtime')], 1000);
    expect(groups).toHaveLength(2);
  });

  it('createDate 来源可以参与合并', () => {
    const groups = groupBursts(
      [item('a', 0, 'R5|SN1', 'createDate'), item('b', 100, 'R5|SN1', 'createDate')], 1000);
    expect(groups[0].ids).toEqual(['a', 'b']);
  });

  it('乱序输入会先按时间排序', () => {
    const groups = groupBursts([item('c', 900), item('a', 0), item('b', 400)], 500);
    expect(groups[0].ids).toEqual(['a', 'b', 'c']);
  });

  it('时间相同时按 id 稳定排序', () => {
    const groups = groupBursts([item('b', 100), item('a', 100)], 0);
    expect(groups[0].ids).toEqual(['a', 'b']);
  });

  it('阈值为 0 时只有时间完全相同的才合并', () => {
    const groups = groupBursts([item('a', 100), item('b', 100), item('c', 101)], 0);
    expect(groups.map((g) => g.ids)).toEqual([['a', 'b'], ['c']]);
  });

  it('跨天的两张不会因为阈值大而误合并', () => {
    const day = 86_400_000;
    const groups = groupBursts([item('a', 0), item('b', day)], 5000);
    expect(groups).toHaveLength(2);
  });

  it('每个输入项都恰好出现在一个组里', () => {
    const items = Array.from({ length: 50 }, (_, i) => item(`x${i}`, i * 300));
    const groups = groupBursts(items, 500);
    const flat = groups.flatMap((g) => g.ids);
    expect(flat).toHaveLength(50);
    expect(new Set(flat).size).toBe(50);
  });

  it('组的 key 是组内第一张的 id', () => {
    const groups = groupBursts([item('a', 0), item('b', 100)], 1000);
    expect(groups[0].key).toBe('a');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run web/src/lib/bursts.test.ts`
Expected: FAIL — 无法解析 `./bursts`

- [ ] **Step 3: 实现 `web/src/lib/bursts.ts`**

```ts
import type { AssetMeta } from '../types';

export interface BurstItem {
  id: string;
  time: number;
  timeSource: AssetMeta['timeSource'];
  body: string;
}

export interface Group {
  key: string;
  ids: string[];
}

/**
 * 相邻两张合成同组，需同时满足：
 *   1. 时间差 <= 阈值
 *   2. 同一机身（Model+序列号；都缺失时退化为 dir:<目录>）
 *   3. 两端的时间都不是 mtime 回退 —— 文件 mtime 精度不足以判连拍
 *
 * 返回的组覆盖全部输入，单张也是一个长度 1 的组，
 * 这样网格渲染可以统一按「一个格子 = 一个组」处理。
 */
export function groupBursts(items: BurstItem[], thresholdMs: number): Group[] {
  if (items.length === 0) return [];

  const sorted = [...items].sort((a, b) =>
    a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const groups: Group[] = [];
  let current: BurstItem[] = [sorted[0]];

  const joinable = (prev: BurstItem, next: BurstItem) =>
    next.time - prev.time <= thresholdMs &&
    prev.body === next.body &&
    prev.timeSource !== 'mtime' &&
    next.timeSource !== 'mtime';

  for (let i = 1; i < sorted.length; i++) {
    if (joinable(sorted[i - 1], sorted[i])) {
      current.push(sorted[i]);
    } else {
      groups.push({ key: current[0].id, ids: current.map((x) => x.id) });
      current = [sorted[i]];
    }
  }
  groups.push({ key: current[0].id, ids: current.map((x) => x.id) });
  return groups;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run web/src/lib/bursts.test.ts`
Expected: PASS，17 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: 连拍分组纯函数"
```

---

## Task 12: 缩略图优先级队列与 blob LRU

这是「快速滚动不炸」的两块核心机制，都是纯逻辑，必须先测透再接进 UI。

**Files:**
- Create: `web/src/lib/blobCache.ts`, `web/src/lib/thumbQueue.ts`
- Test: `web/src/lib/blobCache.test.ts`, `web/src/lib/thumbQueue.test.ts`

**Interfaces:**
- Produces（`blobCache.ts`）：
  - `createBlobCache(capacity: number, revoke?: (url: string) => void): BlobCache`
  - `BlobCache = { get(key): string | undefined; set(key, url): void; has(key): boolean; get size(): number; clear(): void }`
- Produces（`thumbQueue.ts`）：
  - `createThumbQueue(opts: { concurrency: number; fetchImpl?: typeof fetch }): ThumbQueue`
  - `ThumbQueue = { request(key, url, priority): Promise<Blob>; cancel(key): void; reprioritize(score: (key: string) => number): void; get pending(): number; get active(): number }`
  - `cancel` 会 abort 进行中的请求并让对应 promise 以 `AbortError` 拒绝

- [ ] **Step 1: 写失败的测试 `web/src/lib/blobCache.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { createBlobCache } from './blobCache';

describe('createBlobCache', () => {
  it('存进去能取出来', () => {
    const c = createBlobCache(3);
    c.set('a', 'blob:a');
    expect(c.get('a')).toBe('blob:a');
    expect(c.has('a')).toBe(true);
  });

  it('未存过的 key 返回 undefined', () => {
    expect(createBlobCache(3).get('nope')).toBeUndefined();
  });

  it('超出容量时淘汰最久未使用的并 revoke', () => {
    const revoke = vi.fn();
    const c = createBlobCache(2, revoke);
    c.set('a', 'blob:a');
    c.set('b', 'blob:b');
    c.set('c', 'blob:c');
    expect(c.has('a')).toBe(false);
    expect(revoke).toHaveBeenCalledWith('blob:a');
    expect(c.size).toBe(2);
  });

  it('get 会把条目提为最新，改变淘汰顺序', () => {
    const revoke = vi.fn();
    const c = createBlobCache(2, revoke);
    c.set('a', 'blob:a');
    c.set('b', 'blob:b');
    c.get('a');              // a 变成最新，b 成为最久未用
    c.set('c', 'blob:c');
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
    expect(revoke).toHaveBeenCalledWith('blob:b');
  });

  it('重复 set 同一 key 时 revoke 旧值', () => {
    const revoke = vi.fn();
    const c = createBlobCache(3, revoke);
    c.set('a', 'blob:old');
    c.set('a', 'blob:new');
    expect(revoke).toHaveBeenCalledWith('blob:old');
    expect(c.get('a')).toBe('blob:new');
    expect(c.size).toBe(1);
  });

  it('clear 会 revoke 全部条目', () => {
    const revoke = vi.fn();
    const c = createBlobCache(5, revoke);
    c.set('a', 'blob:a');
    c.set('b', 'blob:b');
    c.clear();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(c.size).toBe(0);
  });

  it('容量为 1 时每次 set 都淘汰上一个', () => {
    const revoke = vi.fn();
    const c = createBlobCache(1, revoke);
    c.set('a', 'blob:a');
    c.set('b', 'blob:b');
    expect(c.size).toBe(1);
    expect(revoke).toHaveBeenCalledWith('blob:a');
  });

  it('滚过远超容量的条目后内存占用保持恒定', () => {
    const revoke = vi.fn();
    const c = createBlobCache(100, revoke);
    for (let i = 0; i < 3000; i++) c.set(`k${i}`, `blob:${i}`);
    expect(c.size).toBe(100);
    expect(revoke).toHaveBeenCalledTimes(2900);   // 泄漏就是这里对不上
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run web/src/lib/blobCache.test.ts`
Expected: FAIL — 无法解析 `./blobCache`

- [ ] **Step 3: 实现 `web/src/lib/blobCache.ts`**

```ts
export interface BlobCache {
  get(key: string): string | undefined;
  set(key: string, url: string): void;
  has(key: string): boolean;
  readonly size: number;
  clear(): void;
}

/**
 * blob URL 的 LRU。淘汰时必须 revokeObjectURL —— 不释放的话
 * 滚过几千张缩略图会攒下数百 MB 永不回收的内存。
 * Map 的迭代顺序即插入顺序，第一个 key 就是最久未使用的。
 */
export function createBlobCache(
  capacity: number,
  revoke: (url: string) => void = (url) => URL.revokeObjectURL(url),
): BlobCache {
  const map = new Map<string, string>();

  return {
    get(key) {
      const url = map.get(key);
      if (url === undefined) return undefined;
      map.delete(key);      // 重新插入即提为最新
      map.set(key, url);
      return url;
    },
    set(key, url) {
      const old = map.get(key);
      if (old !== undefined) {
        map.delete(key);
        if (old !== url) revoke(old);
      }
      map.set(key, url);
      while (map.size > capacity) {
        const oldest = map.keys().next().value as string;
        const evicted = map.get(oldest)!;
        map.delete(oldest);
        revoke(evicted);
      }
    },
    has: (key) => map.has(key),
    get size() { return map.size; },
    clear() {
      for (const url of map.values()) revoke(url);
      map.clear();
    },
  };
}
```

- [ ] **Step 4: 运行 blobCache 测试确认通过**

Run: `npx vitest run web/src/lib/blobCache.test.ts`
Expected: PASS，8 个用例全绿

- [ ] **Step 5: 写失败的测试 `web/src/lib/thumbQueue.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { createThumbQueue } from './thumbQueue';

/** 可控的假 fetch：记录调用顺序，手动 resolve。 */
function makeFetch() {
  const calls: string[] = [];
  const pending = new Map<string, (blob: Blob) => void>();
  const rejects = new Map<string, (err: Error) => void>();

  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push(url);
    return new Promise((resolve, reject) => {
      pending.set(url, (blob) => resolve({ ok: true, blob: async () => blob } as Response));
      rejects.set(url, reject);
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  }) as unknown as typeof fetch;

  return {
    fetchImpl, calls,
    finish: (url: string) => pending.get(url)?.(new Blob(['x'])),
    fail: (url: string) => rejects.get(url)?.(new Error('boom')),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createThumbQueue', () => {
  it('并发数达到上限后其余请求排队', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 2, fetchImpl: f.fetchImpl });
    for (let i = 0; i < 5; i++) void q.request(`k${i}`, `/u${i}`, i);
    await tick();
    expect(f.calls).toHaveLength(2);
    expect(q.active).toBe(2);
    expect(q.pending).toBe(3);
  });

  it('一个完成后自动放行下一个', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 1, fetchImpl: f.fetchImpl });
    void q.request('a', '/a', 0);
    void q.request('b', '/b', 0);
    await tick();
    expect(f.calls).toEqual(['/a']);
    f.finish('/a');
    await tick();
    expect(f.calls).toEqual(['/a', '/b']);
  });

  it('优先级数值小的先出队', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 1, fetchImpl: f.fetchImpl });
    void q.request('block', '/block', 0);
    await tick();
    void q.request('far', '/far', 900);
    void q.request('near', '/near', 5);
    f.finish('/block');
    await tick();
    expect(f.calls[1]).toBe('/near');
  });

  it('reprioritize 会重排还在排队的项', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 1, fetchImpl: f.fetchImpl });
    void q.request('block', '/block', 0);
    await tick();
    void q.request('a', '/a', 10);
    void q.request('b', '/b', 20);
    q.reprioritize((key) => (key === 'b' ? 1 : 999));   // 滚动后 b 进了视口中心
    f.finish('/block');
    await tick();
    expect(f.calls[1]).toBe('/b');
  });

  it('cancel 排队中的项使其出队且 promise 以 AbortError 拒绝', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 1, fetchImpl: f.fetchImpl });
    void q.request('block', '/block', 0);
    await tick();
    const p = q.request('gone', '/gone', 1);
    expect(q.pending).toBe(1);
    q.cancel('gone');
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(q.pending).toBe(0);
    f.finish('/block');
    await tick();
    expect(f.calls).toEqual(['/block']);   // 被取消的那个从未发出请求
  });

  it('cancel 进行中的项会 abort 网络请求', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 2, fetchImpl: f.fetchImpl });
    const p = q.request('a', '/a', 0);
    await tick();
    expect(q.active).toBe(1);
    q.cancel('a');
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(q.active).toBe(0);
  });

  it('取消进行中的项后队列继续放行下一个', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 1, fetchImpl: f.fetchImpl });
    void q.request('a', '/a', 0).catch(() => {});
    void q.request('b', '/b', 1);
    await tick();
    q.cancel('a');
    await tick();
    expect(f.calls).toEqual(['/a', '/b']);
  });

  it('同一 key 重复请求复用同一个 promise，只发一次网络请求', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 4, fetchImpl: f.fetchImpl });
    const p1 = q.request('a', '/a', 0);
    const p2 = q.request('a', '/a', 0);
    await tick();
    expect(f.calls).toHaveLength(1);
    f.finish('/a');
    expect(await p1).toBe(await p2);
  });

  it('请求成功时 resolve 出 Blob', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 1, fetchImpl: f.fetchImpl });
    const p = q.request('a', '/a', 0);
    await tick();
    f.finish('/a');
    expect(await p).toBeInstanceOf(Blob);
  });

  it('请求失败时 reject 且不卡死队列', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 1, fetchImpl: f.fetchImpl });
    const p = q.request('a', '/a', 0).catch((e) => e);
    void q.request('b', '/b', 1);
    await tick();
    f.fail('/a');
    await p;
    await tick();
    expect(f.calls).toEqual(['/a', '/b']);
    expect(q.active).toBe(1);
  });

  it('cancel 不存在的 key 不报错', () => {
    const q = createThumbQueue({ concurrency: 1, fetchImpl: makeFetch().fetchImpl });
    expect(() => q.cancel('ghost')).not.toThrow();
  });

  it('大量入队后并发始终不超过上限', async () => {
    const f = makeFetch();
    const q = createThumbQueue({ concurrency: 6, fetchImpl: f.fetchImpl });
    for (let i = 0; i < 500; i++) void q.request(`k${i}`, `/u${i}`, i).catch(() => {});
    await tick();
    expect(q.active).toBe(6);
    expect(f.calls).toHaveLength(6);
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run web/src/lib/thumbQueue.test.ts`
Expected: FAIL — 无法解析 `./thumbQueue`

- [ ] **Step 7: 实现 `web/src/lib/thumbQueue.ts`**

```ts
interface Entry {
  key: string;
  url: string;
  priority: number;
  controller: AbortController;
  promise: Promise<Blob>;
  resolve: (blob: Blob) => void;
  reject: (err: Error) => void;
  started: boolean;
}

export interface ThumbQueue {
  request(key: string, url: string, priority: number): Promise<Blob>;
  cancel(key: string): void;
  reprioritize(score: (key: string) => number): void;
  readonly pending: number;
  readonly active: number;
}

function abortError() {
  const err = new Error('请求已取消');
  err.name = 'AbortError';
  return err;
}

/**
 * 缩略图请求队列。三件事：
 *   1. 并发闸门 —— 对齐浏览器同域连接数，避免请求互相饿死
 *   2. 优先级出队 —— 距视口中心近的先发，滚动停下时眼睛看的那行最先出图
 *   3. cancel 即 abort —— 快速滚动掠过的图，请求在半路被掐断，不占带宽也不堵后端
 */
export function createThumbQueue({
  concurrency,
  fetchImpl = fetch,
}: { concurrency: number; fetchImpl?: typeof fetch }): ThumbQueue {
  const queued = new Map<string, Entry>();
  const running = new Map<string, Entry>();

  function pump() {
    while (running.size < concurrency && queued.size > 0) {
      let best: Entry | null = null;
      for (const entry of queued.values()) {
        if (best === null || entry.priority < best.priority) best = entry;
      }
      if (best === null) return;

      queued.delete(best.key);
      running.set(best.key, best);
      best.started = true;
      void start(best);
    }
  }

  async function start(entry: Entry) {
    try {
      const res = await fetchImpl(entry.url, { signal: entry.controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      entry.resolve(await res.blob());
    } catch (err) {
      entry.reject(err as Error);
    } finally {
      running.delete(entry.key);
      pump();
    }
  }

  return {
    request(key, url, priority) {
      const existing = queued.get(key) ?? running.get(key);
      if (existing) {
        existing.priority = Math.min(existing.priority, priority);
        return existing.promise;
      }

      let resolve!: (blob: Blob) => void;
      let reject!: (err: Error) => void;
      const promise = new Promise<Blob>((res, rej) => { resolve = res; reject = rej; });

      const entry: Entry = {
        key, url, priority, controller: new AbortController(),
        promise, resolve, reject, started: false,
      };
      queued.set(key, entry);
      pump();
      return promise;
    },

    cancel(key) {
      const waiting = queued.get(key);
      if (waiting) {
        queued.delete(key);
        waiting.reject(abortError());
        return;
      }
      const active = running.get(key);
      if (active) active.controller.abort();   // finally 里会 running.delete + pump
    },

    reprioritize(score) {
      for (const entry of queued.values()) entry.priority = score(entry.key);
    },

    get pending() { return queued.size; },
    get active() { return running.size; },
  };
}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `npx vitest run web/src/lib/thumbQueue.test.ts`
Expected: PASS，12 个用例全绿

- [ ] **Step 9: 跑全量测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 10: 提交**

```bash
git add -A
git commit -m "feat: 缩略图优先级队列与 blob LRU"
```

---

## Task 13: 标记 store（撤销栈）与视图 store（筛选、分组派生）

**Files:**
- Create: `web/src/store/marks.ts`, `web/src/store/view.ts`, `web/src/lib/derive.ts`
- Test: `web/src/lib/derive.test.ts`, `web/src/store/marks.test.ts`

**Interfaces:**
- Consumes: Task 11 `groupBursts`、Task 10 `types.ts` / `api.ts`
- Produces（`derive.ts`，纯函数，UI 的全部业务逻辑都在这里）：
  - `filterAssets(assets: Asset[], marks: Record<string, Mark|undefined>, tab: FilterTab, dirFilter: string | null): Asset[]`
  - `toBurstItems(assets: Asset[], metas: Map<string, AssetMeta>): BurstItem[]` — 缺元数据的资产用 `jpgMtimeMs` + `timeSource:'mtime'` 兜底，保证元数据还没读完时网格也能排出来
  - `dirCounts(assets: Asset[]): { dir: string; count: number }[]`
  - `groupMarkSummary(ids: string[], marks): { picked: number; rejected: number; total: number }`
- Produces（`store/marks.ts`）：
  - `useMarks` — `{ marks, undoStack, setMark(ids: string[], mark: Mark|null), undo(), load(marks), pickCount, rejectCount }`
  - 写服务端是 fire-and-forget 的乐观更新；失败时回滚并抛 toast
- Produces（`store/view.ts`）：
  - `useView` — `{ tab, dirFilter, threshold, expanded: Set<string>, cursor: string|null, selection: Set<string>, lightbox: string|null, anchor: string|null, setTab, setDirFilter, setThreshold, toggleExpand, collapseAll, setCursor, clearSelection, openLightbox, closeLightbox }`
    - 注意：没有 setSelection —— 选区通过 `setCursor(id, { extend, order })` 设置，另有 `clearSelection()`

- [ ] **Step 1: 写失败的测试 `web/src/lib/derive.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { filterAssets, toBurstItems, dirCounts, groupMarkSummary } from './derive';
import type { Asset, AssetMeta } from '../types';

const asset = (id: string, dir = '', jpg: string | null = 'x.JPG'): Asset => ({
  id, dir, stem: id.split('/').pop()!, raws: ['x.CR3'], jpg,
  jpgSize: 10, jpgMtimeMs: 5000,
});

const assets = [asset('A'), asset('cam-a/B', 'cam-a'), asset('cam-a/C', 'cam-a'), asset('D')];
const marks = { A: 'pick', 'cam-a/B': 'reject', 'cam-a/C': 'pick' } as const;

describe('filterAssets', () => {
  it('all 返回全部', () => {
    expect(filterAssets(assets, marks, 'all', null)).toHaveLength(4);
  });
  it('pick 只返回收藏', () => {
    expect(filterAssets(assets, marks, 'pick', null).map((a) => a.id)).toEqual(['A', 'cam-a/C']);
  });
  it('reject 只返回排除', () => {
    expect(filterAssets(assets, marks, 'reject', null).map((a) => a.id)).toEqual(['cam-a/B']);
  });
  it('none 只返回未标记', () => {
    expect(filterAssets(assets, marks, 'none', null).map((a) => a.id)).toEqual(['D']);
  });
  it('目录过滤与 tab 正交叠加', () => {
    expect(filterAssets(assets, marks, 'pick', 'cam-a').map((a) => a.id)).toEqual(['cam-a/C']);
  });
  it('目录过滤只匹配该层，不含更深的子目录', () => {
    const deep = [...assets, asset('cam-a/sub/E', 'cam-a/sub')];
    expect(filterAssets(deep, {}, 'all', 'cam-a').map((a) => a.id)).toEqual(['cam-a/B', 'cam-a/C']);
  });
  it('根目录过滤用空串', () => {
    expect(filterAssets(assets, {}, 'all', '').map((a) => a.id)).toEqual(['A', 'D']);
  });
});

describe('toBurstItems', () => {
  it('有元数据时用 EXIF 时间与机身', () => {
    const metas = new Map<string, AssetMeta>([['A', {
      id: 'A', time: 111, timeSource: 'exif', orientation: 1, body: 'R5|SN',
      iso: null, fNumber: null, exposureTime: null, focalLength: null,
    }]]);
    expect(toBurstItems([asset('A')], metas)[0])
      .toEqual({ id: 'A', time: 111, timeSource: 'exif', body: 'R5|SN' });
  });

  it('元数据未到时用 jpgMtimeMs 兜底且标为 mtime', () => {
    const item = toBurstItems([asset('cam-a/B', 'cam-a')], new Map())[0];
    expect(item).toEqual({ id: 'cam-a/B', time: 5000, timeSource: 'mtime', body: 'dir:cam-a' });
  });

  it('兜底项因为 timeSource 是 mtime，不会被误分进连拍组', () => {
    const items = toBurstItems([asset('A'), asset('B')], new Map());
    expect(items.every((i) => i.timeSource === 'mtime')).toBe(true);
  });
});

describe('dirCounts', () => {
  it('按目录统计并按目录名排序', () => {
    expect(dirCounts(assets)).toEqual([
      { dir: '', count: 2 },
      { dir: 'cam-a', count: 2 },
    ]);
  });
  it('空输入返回空数组', () => {
    expect(dirCounts([])).toEqual([]);
  });
});

describe('groupMarkSummary', () => {
  it('统计组内收藏与排除数', () => {
    expect(groupMarkSummary(['A', 'cam-a/B', 'cam-a/C'], marks))
      .toEqual({ picked: 2, rejected: 1, total: 3 });
  });
  it('全未标记时计数为 0', () => {
    expect(groupMarkSummary(['D'], marks)).toEqual({ picked: 0, rejected: 0, total: 1 });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run web/src/lib/derive.test.ts`
Expected: FAIL — 无法解析 `./derive`

- [ ] **Step 3: 实现 `web/src/lib/derive.ts`**

```ts
import type { Asset, AssetMeta, FilterTab, Mark } from '../types';
import type { BurstItem } from './bursts';

type Marks = Record<string, Mark | undefined>;

export function filterAssets(
  assets: Asset[], marks: Marks, tab: FilterTab, dirFilter: string | null,
): Asset[] {
  return assets.filter((a) => {
    if (dirFilter !== null && a.dir !== dirFilter) return false;
    const mark = marks[a.id];
    if (tab === 'all') return true;
    if (tab === 'none') return mark === undefined;
    return mark === tab;
  });
}

/**
 * 元数据是后台陆续到达的。还没到的资产用文件 mtime 兜底，
 * 并把 timeSource 标成 'mtime' —— groupBursts 会因此拒绝把它们并进连拍组，
 * 所以「元数据加载途中」不会出现错误的分组闪烁。
 */
export function toBurstItems(assets: Asset[], metas: Map<string, AssetMeta>): BurstItem[] {
  return assets.map((a) => {
    const meta = metas.get(a.id);
    if (meta) {
      return { id: a.id, time: meta.time, timeSource: meta.timeSource, body: meta.body };
    }
    return { id: a.id, time: a.jpgMtimeMs, timeSource: 'mtime' as const, body: `dir:${a.dir}` };
  });
}

export function dirCounts(assets: Asset[]): { dir: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const a of assets) counts.set(a.dir, (counts.get(a.dir) ?? 0) + 1);
  return [...counts.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => a.dir.localeCompare(b.dir, 'zh'));
}

export function groupMarkSummary(ids: string[], marks: Marks) {
  let picked = 0;
  let rejected = 0;
  for (const id of ids) {
    if (marks[id] === 'pick') picked++;
    else if (marks[id] === 'reject') rejected++;
  }
  return { picked, rejected, total: ids.length };
}
```

- [ ] **Step 4: 运行 derive 测试确认通过**

Run: `npx vitest run web/src/lib/derive.test.ts`
Expected: PASS，14 个用例全绿

- [ ] **Step 5: 写失败的测试 `web/src/store/marks.test.ts`**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useMarks } from './marks';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
  useMarks.getState().load({});
});

const marks = () => useMarks.getState().marks;

describe('useMarks', () => {
  it('setMark 立即更新本地状态（乐观更新）', () => {
    useMarks.getState().setMark(['a'], 'pick');
    expect(marks().a).toBe('pick');
  });

  it('setMark 传 null 取消标记', () => {
    useMarks.getState().setMark(['a'], 'pick');
    useMarks.getState().setMark(['a'], null);
    expect(marks().a).toBeUndefined();
  });

  it('批量标记一次生效', () => {
    useMarks.getState().setMark(['a', 'b', 'c'], 'reject');
    expect(marks()).toEqual({ a: 'reject', b: 'reject', c: 'reject' });
  });

  it('undo 恢复上一步的全部 id', () => {
    useMarks.getState().setMark(['a'], 'pick');
    useMarks.getState().setMark(['a', 'b'], 'reject');
    useMarks.getState().undo();
    expect(marks()).toEqual({ a: 'pick' });
  });

  it('批量标记算一步撤销', () => {
    useMarks.getState().setMark(['a', 'b', 'c'], 'pick');
    useMarks.getState().undo();
    expect(marks()).toEqual({});
  });

  it('连续 undo 逐步回退', () => {
    useMarks.getState().setMark(['a'], 'pick');
    useMarks.getState().setMark(['b'], 'pick');
    useMarks.getState().undo();
    useMarks.getState().undo();
    expect(marks()).toEqual({});
  });

  it('撤销栈为空时 undo 无副作用', () => {
    expect(() => useMarks.getState().undo()).not.toThrow();
    expect(marks()).toEqual({});
  });

  it('撤销栈上限 50 步', () => {
    for (let i = 0; i < 60; i++) useMarks.getState().setMark([`k${i}`], 'pick');
    expect(useMarks.getState().undoStack).toHaveLength(50);
  });

  it('pickCount 与 rejectCount 实时反映当前标记', () => {
    useMarks.getState().setMark(['a', 'b'], 'pick');
    useMarks.getState().setMark(['c'], 'reject');
    expect(useMarks.getState().pickCount()).toBe(2);
    expect(useMarks.getState().rejectCount()).toBe(1);
  });

  it('load 覆盖当前标记并清空撤销栈', () => {
    useMarks.getState().setMark(['a'], 'pick');
    useMarks.getState().load({ z: 'reject' });
    expect(marks()).toEqual({ z: 'reject' });
    expect(useMarks.getState().undoStack).toHaveLength(0);
  });

  it('把改动 PUT 给服务端', () => {
    useMarks.getState().setMark(['a'], 'pick');
    expect(fetch).toHaveBeenCalledWith('/api/library/marks', expect.objectContaining({ method: 'PUT' }));
  });

  it('服务端写入失败时回滚本地状态', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, statusText: 'boom', json: async () => ({ error: 'boom' }),
    })));
    useMarks.getState().setMark(['a'], 'pick');
    await new Promise((r) => setTimeout(r, 10));
    expect(marks().a).toBeUndefined();
    expect(useMarks.getState().error).toBeTruthy();
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run web/src/store/marks.test.ts`
Expected: FAIL — 无法解析 `./marks`

- [ ] **Step 7: 实现 `web/src/store/marks.ts`**

```ts
import { create } from 'zustand';
import { putJSON } from '../lib/api';
import type { Mark } from '../types';

type Marks = Record<string, Mark | undefined>;
type UndoEntry = { id: string; before: Mark | undefined }[];

const UNDO_LIMIT = 50;

interface MarksState {
  marks: Marks;
  undoStack: UndoEntry[];
  error: string | null;
  load: (marks: Marks) => void;
  setMark: (ids: string[], mark: Mark | null) => void;
  undo: () => void;
  pickCount: () => number;
  rejectCount: () => number;
}

export const useMarks = create<MarksState>((set, get) => {
  /** 应用一批改动并把服务端写入做成乐观更新：失败即整批回滚。 */
  function apply(entries: UndoEntry, next: Marks, pushUndo: boolean) {
    const before = get().marks;
    set((s) => ({
      marks: next,
      undoStack: pushUndo ? [...s.undoStack, entries].slice(-UNDO_LIMIT) : s.undoStack,
      error: null,
    }));

    const patch: Record<string, Mark | null> = {};
    for (const { id } of entries) patch[id] = next[id] ?? null;

    void putJSON('/api/library/marks', { marks: patch }).catch((err: Error) => {
      set({ marks: before, error: `保存失败：${err.message}` });
    });
  }

  return {
    marks: {},
    undoStack: [],
    error: null,

    load(marks) {
      set({ marks: { ...marks }, undoStack: [], error: null });
    },

    setMark(ids, mark) {
      if (ids.length === 0) return;
      const current = get().marks;
      const entries: UndoEntry = ids.map((id) => ({ id, before: current[id] }));
      const next = { ...current };
      for (const id of ids) {
        if (mark === null) delete next[id];
        else next[id] = mark;
      }
      apply(entries, next, true);
    },

    undo() {
      const stack = get().undoStack;
      if (stack.length === 0) return;
      const entries = stack[stack.length - 1];
      const next = { ...get().marks };
      for (const { id, before } of entries) {
        if (before === undefined) delete next[id];
        else next[id] = before;
      }
      set((s) => ({ undoStack: s.undoStack.slice(0, -1) }));
      apply(entries, next, false);
    },

    pickCount: () => Object.values(get().marks).filter((m) => m === 'pick').length,
    rejectCount: () => Object.values(get().marks).filter((m) => m === 'reject').length,
  };
});
```

- [ ] **Step 8: 实现 `web/src/store/view.ts`（无单测，逻辑全在 derive.ts 里）**

```ts
import { create } from 'zustand';
import { putJSON } from '../lib/api';
import type { FilterTab } from '../types';

interface ViewState {
  tab: FilterTab;
  dirFilter: string | null;
  threshold: number;
  expanded: Set<string>;
  cursor: string | null;
  anchor: string | null;
  selection: Set<string>;
  lightbox: string | null;
  setTab: (tab: FilterTab) => void;
  setDirFilter: (dir: string | null) => void;
  setThreshold: (ms: number, persist?: boolean) => void;
  toggleExpand: (key: string) => void;
  collapseAll: () => void;
  setCursor: (id: string | null, opts?: { extend?: boolean; order?: string[] }) => void;
  clearSelection: () => void;
  openLightbox: (id: string) => void;
  closeLightbox: () => void;
}

export const useView = create<ViewState>((set, get) => ({
  tab: 'all',
  dirFilter: null,
  threshold: 1000,
  expanded: new Set(),
  cursor: null,
  anchor: null,
  selection: new Set(),
  lightbox: null,

  setTab: (tab) => set({ tab, selection: new Set(), anchor: null }),
  setDirFilter: (dirFilter) => set({ dirFilter, selection: new Set(), anchor: null }),

  setThreshold(ms, persist = false) {
    set({ threshold: ms, expanded: new Set() });   // 阈值一变，展开状态失去意义
    if (persist) void putJSON('/api/library/settings', { burstThresholdMs: ms }).catch(() => {});
  },

  toggleExpand(key) {
    const next = new Set(get().expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    set({ expanded: next });
  },

  collapseAll: () => set({ expanded: new Set() }),

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
  openLightbox: (id) => set({ lightbox: id, cursor: id }),
  closeLightbox: () => set({ lightbox: null }),
}));
```

- [ ] **Step 9: 运行测试确认通过**

Run: `npx vitest run web/src/store/marks.test.ts web/src/lib/derive.test.ts`
Expected: PASS，26 个用例全绿

- [ ] **Step 10: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误输出

- [ ] **Step 11: 提交**

```bash
git add -A
git commit -m "feat: 标记撤销栈与视图派生逻辑"
```

---

## Task 14: 虚拟网格、缩略图瓦片与连拍卡牌堆

**Files:**
- Create: `web/src/components/Thumb.tsx`, `web/src/components/StackCell.tsx`, `web/src/components/Grid.tsx`, `web/src/lib/thumbSource.ts`
- Modify: `web/src/App.tsx`, `web/src/styles.css`
- Test: 手动验收（渲染层）

**Interfaces:**
- Consumes: Task 12 `createThumbQueue` / `createBlobCache`、Task 11 `groupBursts`、Task 13 `derive` 与两个 store
- Produces:
  - `thumbSource.ts`：`useThumb(id: string, priority: number, enabled: boolean): { url: string | null; failed: boolean }`
    - 单例队列（并发 6）+ 单例 LRU（1200）；组件卸载或 `enabled` 转 false 时自动 `cancel`
  - `Grid.tsx`：`<Grid />` — 自带虚拟滚动，消费 store，无 props

- [ ] **Step 1: 实现 `web/src/lib/thumbSource.ts`**

```ts
import { useEffect, useRef, useState } from 'react';
import { createThumbQueue } from './thumbQueue';
import { createBlobCache } from './blobCache';

// 并发 6 对齐浏览器同域连接数；LRU 1200 张，约占 40–60MB
const queue = createThumbQueue({ concurrency: 6 });
const cache = createBlobCache(1200);
const failed = new Set<string>();

export const thumbUrl = (id: string, tier: 'grid' | 'preview' = 'grid') =>
  `/api/thumb?id=${encodeURIComponent(id)}&tier=${tier}`;

export function clearThumbCache() {
  cache.clear();
  failed.clear();
}

/**
 * enabled 就是「在视口内」。转 false 时立刻 cancel —— 这是快速滚动时
 * 飞过的几百张图不会占带宽、不会堵后端队列的原因。
 */
export function useThumb(id: string, priority: number, enabled: boolean) {
  const [url, setUrl] = useState<string | null>(() => cache.get(id) ?? null);
  const [isFailed, setFailed] = useState(() => failed.has(id));
  const idRef = useRef(id);
  idRef.current = id;

  useEffect(() => {
    const cached = cache.get(id);
    if (cached) { setUrl(cached); return; }
    if (failed.has(id)) { setFailed(true); return; }
    if (!enabled) return;

    let alive = true;
    setUrl(null);

    queue.request(id, thumbUrl(id), priority)
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        cache.set(id, objectUrl);            // LRU 负责 revoke，这里不手动释放
        if (alive && idRef.current === id) setUrl(objectUrl);
      })
      .catch((err: Error) => {
        if (err.name === 'AbortError') return;   // 滚出视口，不是错误
        failed.add(id);
        if (alive && idRef.current === id) setFailed(true);
      });

    return () => {
      alive = false;
      queue.cancel(id);   // 滚出视口即 abort：飞过的图不占带宽、不堵后端队列
    };
    // 依赖数组刻意不含 priority —— priority 只作首次入队的初值，
    // 后续重排由 reprioritizeThumbs 负责。加进来会导致重复 fetch。
  }, [id, enabled]);

  // 注意：这里不能用 priority 再调一次 queue.request —— 已加载完的图既不在
  // 排队集合也不在进行中集合里，request 会把它当成新请求重新 fetch 一遍。
  // 滚动引起的优先级重排走 reprioritizeThumbs（Task 18），只动队列里还没发出的项。

  return { url, failed: isFailed };
}
```

- [ ] **Step 2: 实现 `web/src/components/Thumb.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { useThumb } from '../lib/thumbSource';
import { useMarks } from '../store/marks';
import { useView } from '../store/view';
import type { Asset } from '../types';

interface Props {
  asset: Asset;
  priority: number;
  visible: boolean;
  compact?: boolean;
}

export function Thumb({ asset, priority, visible, compact }: Props) {
  const { url, failed } = useThumb(asset.id, priority, visible);
  const mark = useMarks((s) => s.marks[asset.id]);
  const cursor = useView((s) => s.cursor);
  const selected = useView((s) => s.selection.has(asset.id));
  const setCursor = useView((s) => s.setCursor);
  const openLightbox = useView((s) => s.openLightbox);

  const imgRef = useRef<HTMLImageElement>(null);
  const [decoded, setDecoded] = useState(false);

  // 先解码再显示，避免解码卡在主线程上造成滚动掉帧
  useEffect(() => {
    setDecoded(false);
    if (!url) return;
    let alive = true;
    const img = new Image();
    img.src = url;
    img.decode().then(() => { if (alive) setDecoded(true); }).catch(() => { if (alive) setDecoded(true); });
    return () => { alive = false; };
  }, [url]);

  const cls = [
    'thumb',
    compact ? 'thumb-compact' : '',
    mark ? `thumb-${mark}` : '',
    cursor === asset.id ? 'thumb-cursor' : '',
    selected ? 'thumb-selected' : '',
  ].filter(Boolean).join(' ');

  return (
    <figure
      className={cls}
      data-id={asset.id}
      onClick={(e) => setCursor(asset.id, { extend: e.shiftKey })}
      onDoubleClick={() => openLightbox(asset.id)}
    >
      {url && decoded
        ? <img ref={imgRef} src={url} alt={asset.stem} decoding="async" draggable={false} />
        : <div className={failed ? 'thumb-failed' : 'thumb-skeleton'}>{failed ? '无法预览' : ''}</div>}

      <figcaption>{asset.stem}</figcaption>
      {mark === 'pick' && <span className="badge badge-pick">✓</span>}
      {mark === 'reject' && <span className="badge badge-reject">✕</span>}
      {asset.raws.length === 0 && <span className="badge badge-warn" title="没有 RAW 文件">无 RAW</span>}
      {asset.jpg === null && <span className="badge badge-warn" title="没有 JPG 预览">无 JPG</span>}
    </figure>
  );
}
```

- [ ] **Step 3: 实现 `web/src/components/StackCell.tsx`**

```tsx
import { Thumb } from './Thumb';
import { useMarks } from '../store/marks';
import { useView } from '../store/view';
import { groupMarkSummary } from '../lib/derive';
import type { Asset } from '../types';
import type { Group } from '../lib/bursts';

interface Props {
  group: Group;
  byId: Map<string, Asset>;
  priority: number;
  visible: boolean;
}

/** 单张就是普通瓦片；多张渲染成卡牌堆，右上角 ×N，点击就地展开。 */
export function StackCell({ group, byId, priority, visible }: Props) {
  const marks = useMarks((s) => s.marks);
  const expanded = useView((s) => s.expanded.has(group.key));
  const toggleExpand = useView((s) => s.toggleExpand);

  const head = byId.get(group.ids[0]);
  if (!head) return null;
  if (group.ids.length === 1) {
    return <Thumb asset={head} priority={priority} visible={visible} />;
  }

  const summary = groupMarkSummary(group.ids, marks);
  const cls = [
    'stack',
    expanded ? 'stack-open' : '',
    summary.picked === summary.total ? 'stack-all-pick' : '',
    summary.rejected === summary.total ? 'stack-all-reject' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cls}>
      <span className="stack-paper stack-paper-2" aria-hidden />
      <span className="stack-paper stack-paper-1" aria-hidden />
      <Thumb asset={head} priority={priority} visible={visible} />
      <button className="stack-count" onClick={() => toggleExpand(group.key)}
              title={expanded ? '收起这组连拍' : '展开这组连拍'}>
        ×{group.ids.length}
      </button>
      {summary.picked > 0 && (
        <span className="stack-summary">{summary.picked}/{summary.total} 已选</span>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 实现 `web/src/components/Grid.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { useView } from '../store/view';
import { filterAssets, toBurstItems } from '../lib/derive';
import { groupBursts, type Group } from '../lib/bursts';
import { StackCell } from './StackCell';
import { Thumb } from './Thumb';
import { postJSON } from '../lib/api';

const CELL_W = { small: 150, medium: 210, large: 290 } as const;
const ROW_GAP = 12;
const OVERSCAN_ROWS = 2;

type Row =
  | { kind: 'grid'; groups: Group[] }
  | { kind: 'expanded'; group: Group };

export function Grid() {
  const assets = useLibrary((s) => s.assets);
  const metas = useLibrary((s) => s.metas);
  const gridSize = useLibrary((s) => s.settings.gridSize);
  const marks = useMarks((s) => s.marks);
  const { tab, dirFilter, threshold, expanded } = useView();

  const scrollRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(6);

  const cellW = CELL_W[gridSize];
  const cellH = Math.round(cellW * 0.75) + 26;   // 4:3 图 + 文件名行

  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  const visibleAssets = useMemo(
    () => filterAssets(assets, marks, tab, dirFilter),
    [assets, marks, tab, dirFilter]);

  const groups = useMemo(
    () => groupBursts(toBurstItems(visibleAssets, metas), threshold),
    [visibleAssets, metas, threshold]);

  // 列数随容器宽度变化
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setCols(Math.max(1, Math.floor((entry.contentRect.width - ROW_GAP) / (cellW + ROW_GAP))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [cellW]);

  // 把组切成行；展开的连拍组独占一整行
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let bucket: Group[] = [];
    const flush = () => { if (bucket.length) { out.push({ kind: 'grid', groups: bucket }); bucket = []; } };

    for (const group of groups) {
      if (group.ids.length > 1 && expanded.has(group.key)) {
        flush();
        out.push({ kind: 'expanded', group });
      } else {
        bucket.push(group);
        if (bucket.length === cols) flush();
      }
    }
    flush();
    return out;
  }, [groups, cols, expanded]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i].kind === 'expanded'
      ? Math.round(cellH * 0.8) + ROW_GAP + 16
      : cellH + ROW_GAP),
    overscan: OVERSCAN_ROWS,
  });

  const items = virtualizer.getVirtualItems();

  // 把可视区的 id 报给服务端，让烘焙队列先烤这些
  useEffect(() => {
    if (items.length === 0) return;
    const ids: string[] = [];
    for (const item of items) {
      const row = rows[item.index];
      if (row.kind === 'expanded') ids.push(...row.group.ids);
      else for (const g of row.groups) ids.push(g.ids[0]);
    }
    const timer = setTimeout(() => {
      void postJSON('/api/library/prioritize', { ids }).catch(() => {});
    }, 250);   // 滚动停下 250ms 才上报，避免刷屏
    return () => clearTimeout(timer);
  }, [items.length && items[0].index, items.length && items[items.length - 1].index]);

  // 优先级 = 距可视区中心的行距。滚动停下时，眼睛看的那行最先出图。
  const centerRow = items.length ? (items[0].index + items[items.length - 1].index) / 2 : 0;

  if (visibleAssets.length === 0) {
    return <div className="grid-empty">这个视图下没有照片</div>;
  }

  return (
    <div className="grid-scroll" ref={scrollRef}>
      <div className="grid-inner" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const row = rows[item.index];
          const priority = Math.abs(item.index - centerRow);
          return (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className={row.kind === 'expanded' ? 'grid-row grid-row-expanded' : 'grid-row'}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row.kind === 'grid'
                ? row.groups.map((g) => (
                    <div key={g.key} className="grid-cell" style={{ width: cellW }}>
                      <StackCell group={g} byId={byId} priority={priority} visible />
                    </div>
                  ))
                : (
                  <>
                    <span className="expanded-label">连拍 {row.group.ids.length} 张</span>
                    <div className="expanded-strip">
                      {row.group.ids.map((id) => {
                        const asset = byId.get(id);
                        return asset
                          ? <Thumb key={id} asset={asset} priority={priority} visible compact />
                          : null;
                      })}
                    </div>
                  </>
                )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 追加网格样式到 `web/src/styles.css`**

```css
.app { display: flex; flex-direction: column; height: 100vh; }
.grid-empty { padding: 60px; text-align: center; color: var(--muted); }

.grid-scroll { flex: 1; overflow: auto; contain: strict; padding: 12px; }
.grid-inner { position: relative; width: 100%; }
.grid-row { position: absolute; top: 0; left: 0; width: 100%;
  display: flex; gap: 12px; padding-bottom: 12px; }
.grid-row-expanded { flex-direction: column; gap: 6px;
  background: #1d1d22; border: 1px solid var(--line); border-radius: 10px; padding: 10px; }
.expanded-label { font-size: 12px; color: var(--muted); }
.expanded-strip { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; }

.thumb { position: relative; margin: 0; background: var(--bg-2);
  border: 2px solid transparent; border-radius: 8px; overflow: hidden; cursor: pointer; }
.thumb img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: contain; background: #101013; }
.thumb-compact { width: 150px; flex: 0 0 auto; }
.thumb figcaption { font-size: 11px; color: var(--muted); padding: 4px 6px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.thumb-skeleton, .thumb-failed { width: 100%; aspect-ratio: 4 / 3; background: #101013;
  display: grid; place-items: center; font-size: 12px; color: var(--muted); }
.thumb-skeleton { background: linear-gradient(100deg, #101013 30%, #1b1b21 50%, #101013 70%);
  background-size: 200% 100%; animation: shimmer 1.4s linear infinite; }
@keyframes shimmer { to { background-position: -200% 0; } }

.thumb-pick { border-color: var(--pick); }
.thumb-reject { border-color: var(--reject); opacity: .55; }
.thumb-cursor { outline: 2px solid var(--accent); outline-offset: 1px; }
.thumb-selected { background: #26303f; }

.badge { position: absolute; top: 6px; font-size: 11px; font-weight: 700; line-height: 1;
  padding: 3px 5px; border-radius: 4px; color: #08111f; }
.badge-pick { left: 6px; background: var(--pick); }
.badge-reject { left: 6px; background: var(--reject); color: #fff; }
.badge-warn { right: 6px; background: #d9a441; }

.stack { position: relative; }
.stack-paper { position: absolute; inset: 0; border-radius: 8px;
  background: var(--bg-2); border: 1px solid var(--line); }
.stack-paper-1 { transform: translate(4px, 4px); }
.stack-paper-2 { transform: translate(8px, 8px); opacity: .6; }
.stack .thumb { position: relative; }
.stack-count { position: absolute; top: 6px; right: 6px; z-index: 2;
  padding: 2px 7px; font-size: 11px; font-weight: 700; border-radius: 10px;
  background: rgba(0,0,0,.72); border: 1px solid var(--line); }
.stack-summary { position: absolute; bottom: 26px; right: 6px; z-index: 2;
  font-size: 10px; padding: 2px 5px; border-radius: 4px; background: rgba(0,0,0,.72); color: var(--pick); }
.stack-all-pick .stack-paper { border-color: var(--pick); }
.stack-all-reject .stack-paper { border-color: var(--reject); }
```

- [ ] **Step 6: 在 `App.tsx` 里接上 Grid 并在打开库时载入标记**

把 `App.tsx` 改为：

```tsx
import { useEffect } from 'react';
import { useLibrary } from './store/library';
import { useMarks } from './store/marks';
import { useView } from './store/view';
import { getJSON } from './lib/api';
import { clearThumbCache } from './lib/thumbSource';
import { FolderPicker } from './components/FolderPicker';
import { Grid } from './components/Grid';
import type { Mark, Settings } from './types';

export function App() {
  const phase = useLibrary((s) => s.phase);
  const root = useLibrary((s) => s.root);
  const assets = useLibrary((s) => s.assets);
  const metas = useLibrary((s) => s.metas);
  const bake = useLibrary((s) => s.bake);
  const close = useLibrary((s) => s.close);
  const loadMarks = useMarks((s) => s.load);
  const setThreshold = useView((s) => s.setThreshold);

  useEffect(() => {
    if (phase !== 'ready') return;
    clearThumbCache();
    void getJSON<{ marks: Record<string, Mark>; settings: Settings }>('/api/library/marks')
      .then(({ marks, settings }) => {
        loadMarks(marks);
        setThreshold(settings.burstThresholdMs);
      });
  }, [phase, root]);

  if (phase !== 'ready') return <FolderPicker />;

  return (
    <div className="app">
      <header className="topbar">
        <button onClick={() => void close()}>← 换文件夹</button>
        <code>{root}</code>
        <span>{assets.length} 张</span>
        <span className="muted">元数据 {metas.size}/{assets.length}</span>
        <span className="muted">缓存 {bake.done}/{bake.total}</span>
      </header>
      <Grid />
    </div>
  );
}
```

- [ ] **Step 7: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误输出

- [ ] **Step 8: 手动验收 —— 这是全计划最关键的一次验证**

```bash
npm run dev
```

用一个含 500+ 张照片的真实文件夹，在 `http://127.0.0.1:5173` 逐条确认：

1. 网格出图，缩略图方向正确（竖构图的照片不是躺着的）
2. **按住滚动条快速拖到底再拖回顶部**，页面不卡顿、不白屏；开发者工具 Network 面板里能看到大量 `(canceled)` 的 thumb 请求——这正是 abort 生效的证据
3. 停止滚动后，当前屏幕内的图在 1 秒内补齐
4. 连拍序列显示为卡牌堆并带 `×N` 角标；点角标展开成横向一排，再点收起
5. 开发者工具 Memory 面板：来回滚动 2 分钟后 JS 堆大小稳定，不持续增长
6. 顶栏「缓存 N/M」持续上涨；涨满后刷新页面，滚动全程无任何空白格

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "feat: 虚拟网格、缩略图瓦片与连拍卡牌堆"
```

---

## Task 15: 顶栏、侧栏、键盘交互与撤销提示

**Files:**
- Create: `web/src/components/TopBar.tsx`, `web/src/components/Sidebar.tsx`, `web/src/components/Toast.tsx`, `web/src/lib/useKeyboard.ts`, `web/src/lib/order.ts`
- Modify: `web/src/App.tsx`, `web/src/styles.css`
- Test: `web/src/lib/order.test.ts`

**Interfaces:**
- Consumes: Task 13 的 `useMarks` / `useView` / `derive`、Task 14 的 `Grid`
- Produces:
  - `order.ts`：`flatOrder(groups: Group[], expanded: Set<string>): string[]` — 当前视图下键盘遍历的线性顺序；未展开的连拍组只暴露组内第一张，展开后暴露全部
  - `useKeyboard(order: string[]): void` — 挂全局快捷键
  - `<TopBar />`、`<Sidebar />`、`<Toast />`

- [ ] **Step 1: 写失败的测试 `web/src/lib/order.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { flatOrder } from './order';
import type { Group } from './bursts';

const g = (key: string, ids: string[]): Group => ({ key, ids });

describe('flatOrder', () => {
  it('全是单张时按组顺序展开', () => {
    expect(flatOrder([g('a', ['a']), g('b', ['b'])], new Set())).toEqual(['a', 'b']);
  });

  it('未展开的连拍组只暴露第一张', () => {
    expect(flatOrder([g('a', ['a', 'a2', 'a3']), g('b', ['b'])], new Set())).toEqual(['a', 'b']);
  });

  it('展开的连拍组暴露全部', () => {
    expect(flatOrder([g('a', ['a', 'a2', 'a3'])], new Set(['a']))).toEqual(['a', 'a2', 'a3']);
  });

  it('展开与未展开混排时顺序正确', () => {
    const groups = [g('a', ['a', 'a2']), g('b', ['b']), g('c', ['c', 'c2', 'c3'])];
    expect(flatOrder(groups, new Set(['c']))).toEqual(['a', 'b', 'c', 'c2', 'c3']);
  });

  it('单张组即使被标记为展开也只出现一次', () => {
    expect(flatOrder([g('a', ['a'])], new Set(['a']))).toEqual(['a']);
  });

  it('空输入返回空数组', () => {
    expect(flatOrder([], new Set())).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run web/src/lib/order.test.ts`
Expected: FAIL — 无法解析 `./order`

- [ ] **Step 3: 实现 `web/src/lib/order.ts`**

```ts
import type { Group } from './bursts';

/**
 * 键盘遍历顺序必须和眼睛看到的一致：未展开的连拍组在网格里只占一格、
 * 只露出第一张，所以方向键也只应该停在第一张上。
 */
export function flatOrder(groups: Group[], expanded: Set<string>): string[] {
  const out: string[] = [];
  for (const group of groups) {
    if (group.ids.length > 1 && expanded.has(group.key)) out.push(...group.ids);
    else out.push(group.ids[0]);
  }
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run web/src/lib/order.test.ts`
Expected: PASS，6 个用例全绿

- [ ] **Step 5: 实现 `web/src/lib/useKeyboard.ts`**

```ts
import { useEffect } from 'react';
import { useMarks } from '../store/marks';
import { useView } from '../store/view';
import type { FilterTab, Mark } from '../types';

const TABS: FilterTab[] = ['all', 'pick', 'reject', 'none'];

export function useKeyboard(order: string[]) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const view = useView.getState();
      const marks = useMarks.getState();

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        marks.undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const targets = view.selection.size > 0
        ? [...view.selection]
        : view.cursor ? [view.cursor] : [];

      const setMark = (mark: Mark | null) => {
        if (targets.length === 0) return;
        e.preventDefault();
        marks.setMark(targets, mark);
        // 标记后自动前进一张，符合连续选片的手感
        const last = targets[targets.length - 1];
        const next = order[order.indexOf(last) + 1];
        if (next) view.setCursor(next);
      };

      const move = (delta: number) => {
        e.preventDefault();
        if (order.length === 0) return;
        const at = view.cursor ? order.indexOf(view.cursor) : -1;
        const next = order[Math.min(order.length - 1, Math.max(0, at + delta))];
        if (next) view.setCursor(next, { extend: e.shiftKey, order });
      };

      switch (e.key.toLowerCase()) {
        case 'p': case 'f': return setMark('pick');
        case 'x': return setMark('reject');
        case 'u': return setMark(null);
        case 'arrowright': return move(1);
        case 'arrowleft': return move(-1);
        case 'arrowdown': return move(Number(document.body.dataset.cols ?? 6));
        case 'arrowup': return move(-Number(document.body.dataset.cols ?? 6));
        case 'enter':
          if (view.cursor) { e.preventDefault(); view.openLightbox(view.cursor); }
          return;
        case 'escape':
          e.preventDefault();
          if (view.lightbox) view.closeLightbox();
          else if (view.expanded.size > 0) view.collapseAll();
          else view.clearSelection();
          return;
        case '1': case '2': case '3': case '4':
          e.preventDefault();
          view.setTab(TABS[Number(e.key) - 1]);
          return;
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [order]);
}
```

- [ ] **Step 6: 实现 `web/src/components/TopBar.tsx`**

```tsx
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { useView } from '../store/view';
import { filterAssets } from '../lib/derive';
import type { FilterTab } from '../types';

const TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pick', label: '收藏' },
  { key: 'reject', label: '排除' },
  { key: 'none', label: '未标记' },
];

export function TopBar({ onExport }: { onExport: () => void }) {
  const { root, assets, metas, bake, close } = useLibrary();
  const marks = useMarks((s) => s.marks);
  const { tab, setTab, threshold, setThreshold, dirFilter } = useView();

  const count = (key: FilterTab) => filterAssets(assets, marks, key, dirFilter).length;
  const baking = bake.total > 0 && bake.done < bake.total;

  return (
    <header className="topbar">
      <button onClick={() => void close()}>← 换文件夹</button>
      <code title={root ?? ''}>{root?.split('/').pop()}</code>

      <nav className="tabs">
        {TABS.map((t, i) => (
          <button key={t.key} className={tab === t.key ? 'tab tab-on' : 'tab'}
                  onClick={() => setTab(t.key)} title={`快捷键 ${i + 1}`}>
            {t.label} <b>{count(t.key)}</b>
          </button>
        ))}
      </nav>

      <label className="threshold" title="相邻两张间隔小于此值即归为一组连拍">
        连拍 {(threshold / 1000).toFixed(1)}s
        <input type="range" min={300} max={5000} step={100} value={threshold}
               onChange={(e) => setThreshold(Number(e.target.value))}
               onPointerUp={(e) => setThreshold(Number((e.target as HTMLInputElement).value), true)} />
      </label>

      <span className="muted">
        {metas.size < assets.length ? `读取元数据 ${metas.size}/${assets.length}` : ''}
        {baking ? ` 缓存 ${bake.done}/${bake.total}` : ''}
      </span>

      <button className="primary" onClick={onExport}>导出…</button>
    </header>
  );
}
```

- [ ] **Step 7: 实现 `web/src/components/Sidebar.tsx`**

```tsx
import { useMemo } from 'react';
import { useLibrary } from '../store/library';
import { useView } from '../store/view';
import { dirCounts } from '../lib/derive';

export function Sidebar() {
  const assets = useLibrary((s) => s.assets);
  const warnings = useLibrary((s) => s.warnings);
  const { dirFilter, setDirFilter } = useView();
  const dirs = useMemo(() => dirCounts(assets), [assets]);

  if (dirs.length <= 1 && warnings.length === 0) return null;

  return (
    <aside className="sidebar">
      <h2>文件夹</h2>
      <button className={dirFilter === null ? 'dir dir-on' : 'dir'} onClick={() => setDirFilter(null)}>
        全部 <b>{assets.length}</b>
      </button>
      {dirs.map(({ dir, count }) => (
        <button key={dir} className={dirFilter === dir ? 'dir dir-on' : 'dir'}
                onClick={() => setDirFilter(dir)} title={dir || '（根目录）'}>
          {dir || '（根目录）'} <b>{count}</b>
        </button>
      ))}

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

- [ ] **Step 8: 实现 `web/src/components/Toast.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useMarks } from '../store/marks';

/** 标记后给一条可撤销的提示；保存失败也从这里冒出来。 */
export function Toast() {
  const undoStack = useMarks((s) => s.undoStack);
  const undo = useMarks((s) => s.undo);
  const error = useMarks((s) => s.error);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (undoStack.length === 0) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 2600);
    return () => clearTimeout(timer);
  }, [undoStack.length]);

  if (error) return <div className="toast toast-error">{error}</div>;
  if (!visible) return null;

  const last = undoStack[undoStack.length - 1];
  return (
    <div className="toast">
      已更新 {last.length} 张
      <button className="ghost" onClick={undo}>撤销 (⌘Z)</button>
    </div>
  );
}
```

- [ ] **Step 9: 把三个组件接进 `App.tsx`，并把 order 传给键盘钩子**

Grid 需要把当前的 `groups` 暴露出来给键盘用。改法：把 groups 的推导提到 `App.tsx`，通过 props 传给 `Grid`。

在 `App.tsx` 里：

```tsx
import { useMemo, useState } from 'react';
import { filterAssets, toBurstItems } from './lib/derive';
import { groupBursts } from './lib/bursts';
import { flatOrder } from './lib/order';
import { useKeyboard } from './lib/useKeyboard';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { Toast } from './components/Toast';
// …保留 Task 14 已有的 import
```

在 `if (phase !== 'ready') return <FolderPicker />;` 之前加：

```tsx
  const marks = useMarks((s) => s.marks);
  const { tab, dirFilter, threshold, expanded } = useView();
  const [exportOpen, setExportOpen] = useState(false);

  const groups = useMemo(() => {
    const visible = filterAssets(assets, marks, tab, dirFilter);
    return groupBursts(toBurstItems(visible, metas), threshold);
  }, [assets, marks, tab, dirFilter, metas, threshold]);

  const order = useMemo(() => flatOrder(groups, expanded), [groups, expanded]);
  useKeyboard(order);
```

返回的 JSX 改为：

```tsx
  return (
    <div className="app">
      <TopBar onExport={() => setExportOpen(true)} />
      <div className="body">
        <Sidebar />
        <Grid groups={groups} />
      </div>
      <Toast />
    </div>
  );
```

同时把 `Grid.tsx` 改成接收 `groups` prop：删掉它内部的 `visibleAssets` / `groups` 两个 `useMemo` 和相关 import，改成 `export function Grid({ groups }: { groups: Group[] })`，并把空视图判断改成 `if (groups.length === 0)`。`byId` 仍从 `assets` 推导。另外在列数变化时写一份到 `document.body.dataset.cols`，供上下方向键使用：

```tsx
  useEffect(() => { document.body.dataset.cols = String(cols); }, [cols]);
```

- [ ] **Step 10: 追加样式到 `web/src/styles.css`**

```css
.body { flex: 1; display: flex; min-height: 0; }
.sidebar { width: 190px; flex: 0 0 auto; overflow: auto; padding: 12px;
  border-right: 1px solid var(--line); }
.sidebar h2 { font-size: 12px; color: var(--muted); margin: 0 0 8px; }
.dir { display: block; width: 100%; text-align: left; background: none;
  border-color: transparent; margin-bottom: 2px; font-size: 13px; }
.dir b { float: right; color: var(--muted); font-weight: 400; }
.dir-on { background: var(--bg-2); border-color: var(--accent); }
.warnings { margin-top: 16px; font-size: 12px; color: var(--muted); }
.warnings ul { padding-left: 16px; }

.tabs { display: flex; gap: 4px; }
.tab { padding: 5px 11px; }
.tab b { color: var(--muted); font-weight: 600; }
.tab-on { border-color: var(--accent); background: #202b3d; }
.tab-on b { color: var(--fg); }

.threshold { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
.threshold input { width: 110px; }

.topbar > code { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.topbar > .primary { margin-left: auto; }

.toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 12px; z-index: 50;
  background: #2b2b33; border: 1px solid var(--line); border-radius: 8px;
  padding: 9px 14px; font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,.5); }
.toast-error { border-color: var(--reject); color: var(--reject); }
```

- [ ] **Step 11: 类型检查与全量测试**

Run: `npx tsc --noEmit && npm test`
Expected: 均无错误

- [ ] **Step 12: 手动验收**

`npm run dev` 后确认：`P` 收藏后光标自动跳下一张；`X` 排除；`U` 取消；方向键在网格里移动且未展开的连拍组只停一次；`1`–`4` 切视图且计数正确；在「收藏」视图按 `X`，该张立刻消失并弹出可撤销 toast，按 `⌘Z` 复原；`Shift+方向键` 连选后按 `P` 批量收藏，`⌘Z` 一次性撤销全部；侧栏点子目录只显示该目录的照片。

- [ ] **Step 13: 提交**

```bash
git add -A
git commit -m "feat: 顶栏、侧栏、键盘交互与撤销"
```

---

## Task 16: 全屏大图与 1:1 放大

**Files:**
- Create: `web/src/components/Lightbox.tsx`
- Modify: `web/src/App.tsx`, `web/src/styles.css`
- Test: 手动验收

**Interfaces:**
- Consumes: Task 13 `useView` / `useMarks`、Task 15 `order`
- Produces: `<Lightbox order={order} byId={byId} />`

判断合焦必须看原始像素，所以 1:1 模式直接请求 `/api/original`，绕开缩略图管线。

- [ ] **Step 1: 实现 `web/src/components/Lightbox.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { useView } from '../store/view';
import { useMarks } from '../store/marks';
import { thumbUrl } from '../lib/thumbSource';
import type { Asset } from '../types';

interface Props {
  order: string[];
  byId: Map<string, Asset>;
}

export function Lightbox({ order, byId }: Props) {
  const id = useView((s) => s.lightbox);
  const closeLightbox = useView((s) => s.closeLightbox);
  const openLightbox = useView((s) => s.openLightbox);
  const mark = useMarks((s) => (id ? s.marks[id] : undefined));

  const [zoom, setZoom] = useState(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const index = id ? order.indexOf(id) : -1;
  const asset = id ? byId.get(id) : undefined;

  // 换图时归位
  useEffect(() => { setZoom(false); setPan({ x: 0, y: 0 }); }, [id]);

  // 预取前后各 3 张的 preview，翻页不等待
  useEffect(() => {
    if (index < 0) return;
    for (let d = -3; d <= 3; d++) {
      const neighbor = order[index + d];
      if (neighbor && neighbor !== id) new Image().src = thumbUrl(neighbor, 'preview');
    }
  }, [index, id]);

  useEffect(() => {
    if (!id) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === ' ') { e.preventDefault(); setZoom((z) => !z); }
      else if (e.key === 'ArrowRight' && order[index + 1]) { e.preventDefault(); openLightbox(order[index + 1]); }
      else if (e.key === 'ArrowLeft' && order[index - 1]) { e.preventDefault(); openLightbox(order[index - 1]); }
    }
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [id, index, order]);

  if (!id || !asset) return null;

  const src = zoom ? `/api/original?id=${encodeURIComponent(id)}` : thumbUrl(id, 'preview');

  return (
    <div className="lightbox" onClick={(e) => { if (e.target === e.currentTarget) closeLightbox(); }}>
      <div className={zoom ? 'lb-stage lb-zoom' : 'lb-stage'}
           onPointerDown={(e) => { if (zoom) dragRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }; }}
           onPointerMove={(e) => {
             if (zoom && dragRef.current) {
               setPan({ x: e.clientX - dragRef.current.x, y: e.clientY - dragRef.current.y });
             }
           }}
           onPointerUp={() => { dragRef.current = null; }}
           onClick={() => setZoom((z) => !z)}>
        <img src={src} alt={asset.stem} decoding="async" draggable={false}
             style={zoom ? { transform: `translate(${pan.x}px, ${pan.y}px)` } : undefined} />
      </div>

      <div className="lb-bar">
        <span>{asset.id}</span>
        <span className="muted">{index + 1} / {order.length}</span>
        {mark === 'pick' && <span className="badge badge-pick">收藏</span>}
        {mark === 'reject' && <span className="badge badge-reject">排除</span>}
        {asset.raws.length === 0 && <span className="badge badge-warn">无 RAW</span>}
        <span className="muted">
          {zoom ? '1:1 — 拖拽平移，空格退出' : '空格 1:1 · ←→ 翻页 · P 收藏 · X 排除 · Esc 退出'}
        </span>
        <button onClick={closeLightbox}>关闭</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 在 `App.tsx` 里挂上**

在 `<Toast />` 之前插入：

```tsx
      <Lightbox order={order} byId={byId} />
```

`byId` 在 `App.tsx` 里补一个 memo：

```tsx
  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
```

并把它作为 prop 传给 `Grid`，删掉 `Grid` 内部重复的 `byId` 推导。

- [ ] **Step 3: 追加样式**

```css
.lightbox { position: fixed; inset: 0; z-index: 100; background: #0b0b0eee;
  display: flex; flex-direction: column; }
.lb-stage { flex: 1; display: grid; place-items: center; overflow: hidden; cursor: zoom-in; }
.lb-stage img { max-width: 100%; max-height: 100%; object-fit: contain; }
.lb-zoom { cursor: grab; }
.lb-zoom img { max-width: none; max-height: none; object-fit: none; }
.lb-bar { display: flex; align-items: center; gap: 14px; padding: 10px 16px;
  border-top: 1px solid var(--line); background: var(--bg-2); font-size: 13px; }
.lb-bar .badge { position: static; }
.lb-bar > .muted:last-of-type { margin-left: auto; }
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误输出

- [ ] **Step 5: 手动验收**

选一张照片按 `Enter`：全屏显示；`←` `→` 翻页流畅（预取生效，几乎无等待）；`空格` 切 1:1，能看清眼睫毛是否合焦，拖拽可平移；1:1 状态下 Network 面板显示请求的是 `/api/original`；`P` / `X` 在大图里同样生效并即时更新角标；`Esc` 退出回到网格且光标停在刚才那张上。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat: 全屏大图与 1:1 放大"
```

---

## Task 17: 导出面板

**Files:**
- Create: `web/src/components/ExportPanel.tsx`
- Modify: `web/src/App.tsx`, `web/src/styles.css`
- Test: 手动验收

**Interfaces:**
- Consumes: Task 9 的导出接口、Task 13 `useMarks`、**Task 10 的 `<DirBrowser />`（复用，不要另写一份目录浏览逻辑）**
- Produces: `<ExportPanel open={boolean} onClose={() => void} />`

移动模式的确认输入是 UI 闸门，服务端的 `confirmCount` 校验才是真闸门（Task 9 已实现）。

- [ ] **Step 1: 实现 `web/src/components/ExportPanel.tsx`**

```tsx
import { useState } from 'react';
import { postJSON, openStream } from '../lib/api';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { DirBrowser } from './DirBrowser';

interface Summary {
  exported: number; skipped: number; renamed: number;
  missingRaw: string[]; errors: { id: string; message: string }[];
  canceled: boolean; destRoot: string;
}

export function ExportPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const assets = useLibrary((s) => s.assets);
  const marks = useMarks((s) => s.marks);

  const [here, setHere] = useState('');
  const [dest, setDest] = useState('');
  const [includeJpg, setIncludeJpg] = useState(false);
  const [jpgSubdir, setJpgSubdir] = useState(true);
  const [flatten, setFlatten] = useState(false);
  const [manifest, setManifest] = useState(true);
  const [mode, setMode] = useState<'copy' | 'move'>('copy');
  const [confirmText, setConfirmText] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const picked = assets.filter((a) => marks[a.id] === 'pick');
  const fileCount = picked.reduce(
    (n, a) => n + a.raws.length + (includeJpg && a.jpg ? 1 : 0), 0);
  const missingRawCount = picked.filter((a) => a.raws.length === 0).length;
  const moveBlocked = mode === 'move' && Number(confirmText) !== fileCount;

  const onLocationChange = (path: string) => {
    setHere(path);
    if (!dest) setDest(path);   // 首次进面板时给个合理默认值
  };

  const start = async () => {
    setErr(null); setSummary(null); setProgress({ done: 0, total: fileCount });
    try {
      const res = await postJSON<{ jobId: string; total: number }>('/api/export', {
        destRoot: dest, includeJpg, jpgSubdir: includeJpg && jpgSubdir ? 'JPG' : '',
        flatten, manifest, mode,
        ...(mode === 'move' ? { confirmCount: Number(confirmText) } : {}),
      });
      setJobId(res.jobId);
      const stop = openStream(`/api/export/${res.jobId}/stream`, (event) => {
        if (event.type === 'progress') setProgress({ done: event.done, total: event.total });
        else if (event.type === 'done') { setSummary(event.summary); setProgress(null); setJobId(null); stop(); }
        else if (event.type === 'error') { setErr(event.message); setProgress(null); setJobId(null); stop(); }
      });
    } catch (e) {
      setErr((e as Error).message);
      setProgress(null);
    }
  };

  if (!open) return null;

  return (
    <div className="modal" onClick={(e) => { if (e.target === e.currentTarget && !progress) onClose(); }}>
      <div className="modal-box">
        <h2>导出选中的 RAW</h2>

        <p className="muted">
          收藏 {picked.length} 张，共 {fileCount} 个文件
          {missingRawCount > 0 && (
            <strong className="warn"> · 其中 {missingRawCount} 张没有 RAW，会被跳过</strong>
          )}
        </p>

        <DirBrowser
          onLocationChange={onLocationChange}
          maxHeight={180}
          rowAction={(d) => (
            <button className="ghost" onClick={() => setDest(d.path)}>选这里</button>
          )}
        />
        <div className="picker-actions">
          <button onClick={() => here && setDest(here)} disabled={!here}>选当前目录</button>
        </div>

        <label className="row">导出到 <input value={dest} onChange={(e) => setDest(e.target.value)} /></label>

        <div className="opts">
          <label><input type="checkbox" checked={includeJpg}
                        onChange={(e) => setIncludeJpg(e.target.checked)} /> 同时复制 JPG</label>
          {includeJpg && (
            <label><input type="checkbox" checked={jpgSubdir}
                          onChange={(e) => setJpgSubdir(e.target.checked)} /> JPG 放进 JPG/ 子目录</label>
          )}
          <label><input type="checkbox" checked={flatten}
                        onChange={(e) => setFlatten(e.target.checked)} /> 平铺到单层目录（不保留子目录结构）</label>
          <label><input type="checkbox" checked={manifest}
                        onChange={(e) => setManifest(e.target.checked)} /> 生成 manifest.csv 与 rejected.txt</label>
          <label><input type="checkbox" checked={mode === 'move'}
                        onChange={(e) => { setMode(e.target.checked ? 'move' : 'copy'); setConfirmText(''); }} />
            <strong className="warn">移动（会从源文件夹删除原文件）</strong></label>
        </div>

        {mode === 'move' && (
          <label className="row confirm">
            移动会删除源文件。请输入待移动的文件数 <b>{fileCount}</b> 以确认：
            <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} inputMode="numeric" />
          </label>
        )}

        {progress && (
          <div className="progress">
            <div className="progress-bar" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
            <span>{progress.done} / {progress.total}</span>
            <button onClick={() => jobId && void postJSON(`/api/export/${jobId}/cancel`)}>取消</button>
          </div>
        )}

        {summary && (
          <div className="summary">
            <p>{summary.canceled ? '已取消。' : '导出完成。'}
              成功 {summary.exported} · 跳过 {summary.skipped} · 重命名 {summary.renamed}</p>
            {summary.missingRaw.length > 0 && (
              <p className="warn">{summary.missingRaw.length} 张收藏的照片没有 RAW，未导出：
                {summary.missingRaw.slice(0, 10).join('、')}
                {summary.missingRaw.length > 10 ? ' …' : ''}</p>
            )}
            {summary.errors.length > 0 && (
              <details>
                <summary className="error">{summary.errors.length} 个文件出错</summary>
                <ul>{summary.errors.map((e, i) => <li key={i}>{e.id}：{e.message}</li>)}</ul>
              </details>
            )}
            <code>{summary.destRoot}</code>
          </div>
        )}

        {err && <p className="error">{err}</p>}

        <div className="modal-actions">
          <button onClick={onClose} disabled={!!progress}>关闭</button>
          <button className="primary" onClick={() => void start()}
                  disabled={!dest || fileCount === 0 || !!progress || moveBlocked}>
            {mode === 'move' ? '移动' : '复制'} {fileCount} 个文件
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 在 `App.tsx` 里挂上**

在 `<Toast />` 之前插入：

```tsx
      <ExportPanel open={exportOpen} onClose={() => setExportOpen(false)} />
```

- [ ] **Step 3: 追加样式**

```css
.modal { position: fixed; inset: 0; z-index: 90; background: #000000aa;
  display: grid; place-items: center; }
.modal-box { width: min(680px, 92vw); max-height: 88vh; overflow: auto;
  background: var(--bg-2); border: 1px solid var(--line); border-radius: 12px; padding: 20px; }
.modal-box h2 { font-size: 17px; margin: 0 0 8px; }
.row { display: flex; align-items: center; gap: 10px; margin: 12px 0; font-size: 13px; }
.row input { flex: 1; background: var(--bg); color: var(--fg);
  border: 1px solid var(--line); border-radius: 6px; padding: 7px 10px; font: inherit; }
.confirm input { flex: 0 0 110px; }
.opts { display: flex; flex-direction: column; gap: 7px; margin: 12px 0; font-size: 13px; }
.warn { color: #e0a441; }
.progress { position: relative; display: flex; align-items: center; gap: 12px;
  margin: 14px 0; padding: 8px 12px; background: var(--bg); border-radius: 6px; font-size: 13px; }
.progress-bar { position: absolute; left: 0; top: 0; bottom: 0;
  background: #2a4468; border-radius: 6px; transition: width .15s; }
.progress > * { position: relative; }
.summary { margin: 14px 0; padding: 12px; background: var(--bg); border-radius: 8px; font-size: 13px; }
.summary p { margin: 0 0 6px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误输出

- [ ] **Step 5: 手动验收**

标记若干张收藏（含一张只有 JPG 没有 RAW 的），点「导出…」：
1. 面板显示收藏数、文件数，并高亮提示「N 张没有 RAW，会被跳过」
2. 目录浏览器与首页的选文件夹用的是同一个 `<DirBrowser>`（改动其一，两处同时生效）
3. 选一个空目录，复制模式导出 → 进度条走完 → 结果里 `missingRaw` 明确列出被跳过的那张
3. 目标目录里 RAW 按子目录结构落好，`manifest.csv` 用 Excel 打开中文不乱码
4. 再导出一次到同一目录 → 全部「跳过」
5. 勾「移动」→ 主按钮禁用；输入错误数字仍禁用；输入正确数字才可点；执行后源文件夹里对应 RAW 消失
6. 试图把目标设成源文件夹的子目录 → 报错拒绝

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat: 导出面板与进度"
```

---

## Task 18: 收尾、README 与真实素材验收

**Files:**
- Create: `README.md`
- Modify: `web/src/components/Grid.tsx`（滚动优先级重排）、`package.json`
- Test: 全量测试 + 真实文件夹端到端验收

- [ ] **Step 1: 让滚动真正驱动优先级重排**

Task 14 的优先级只在渲染时算一次。补上滚动停止后的显式重排，让排队中的请求跟着视口走。

在 `web/src/lib/thumbSource.ts` 末尾追加：

```ts
/** 滚动停下后调用：按到视口中心的距离重排还在排队的请求。 */
export function reprioritizeThumbs(score: (id: string) => number) {
  queue.reprioritize(score);
}
```

在 `Grid.tsx` 里，把上报烘焙优先级的那个 `useEffect` 扩展为同时重排前端队列：

```tsx
  useEffect(() => {
    if (items.length === 0) return;
    const rowOf = new Map<string, number>();
    for (const item of items) {
      const row = rows[item.index];
      const ids = row.kind === 'expanded' ? row.group.ids : row.groups.map((g) => g.ids[0]);
      for (const id of ids) rowOf.set(id, item.index);
    }
    const center = (items[0].index + items[items.length - 1].index) / 2;
    reprioritizeThumbs((id) => {
      const row = rowOf.get(id);
      return row === undefined ? 9999 : Math.abs(row - center);
    });

    const timer = setTimeout(() => {
      void postJSON('/api/library/prioritize', { ids: [...rowOf.keys()] }).catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [items.length && items[0].index, items.length && items[items.length - 1].index]);
```

- [ ] **Step 2: 写 `README.md`**

```markdown
# PhotoCull

摄影师选图程序。选定装有 RAW+JPG 配对照片的文件夹，快速浏览、收藏、排除，
最后把收藏照片的 RAW 单独复制到交付目录。

## 使用

    npm install
    npm start

浏览器会自动打开 http://127.0.0.1:5183。服务只监听本机。

开发模式（前端热更新）：

    npm run dev

然后访问 http://127.0.0.1:5173。

## 快捷键

| 键 | 动作 |
|---|---|
| `P` / `F` | 收藏 |
| `X` | 排除 |
| `U` | 取消标记 |
| `←` `→` `↑` `↓` | 移动光标（`Shift` 加选） |
| `Enter` | 全屏大图 |
| `Space` | 大图内 1:1 放大 |
| `Esc` | 退出大图 / 收起连拍组 |
| `1`–`4` | 全部 / 收藏 / 排除 / 未标记 |
| `⌘Z` / `Ctrl+Z` | 撤销 |

## 数据存放

选片进度与缩略图缓存都写在照片文件夹下的 `.photocull/`：

    <照片文件夹>/.photocull/
    ├── marks.json        标记与设置
    ├── marks.bak.json    上一次的备份
    └── thumbs/*.webp     缩略图缓存

文件夹拷到别的机器，选片进度跟着走。删掉 `.photocull/` 即完全重来。

## 连拍分组

相邻两张同时满足「拍摄时间差 ≤ 阈值」「同一机身」「时间不是从文件 mtime 推断的」
才归为一组。阈值用顶栏滑块实时调整（0.3–5 秒），分组在前端计算，不发请求。

## 导出

- 默认只复制标为收藏的照片的 RAW，保留子目录结构
- 可选同时复制 JPG、平铺到单层、生成 `manifest.csv` 与 `rejected.txt`
- 移动模式严格按「复制 → 校验大小 → 删除源文件」执行，且必须输入文件数确认
- 收藏但没有 RAW 的照片会在结果里单独列出，不会静默丢失

## 测试

    npm test
```

- [ ] **Step 3: 跑全量测试**

Run: `npm test`
Expected: PASS，服务端与前端纯逻辑测试全绿

- [ ] **Step 4: 类型检查与生产构建**

Run: `npx tsc --noEmit && npm run build`
Expected: 无 TS 错误；`server/public/` 下生成 index.html 与资源文件

- [ ] **Step 5: 生产模式端到端验收**

```bash
npm start
```

用一个**真实的、含 2000 张以上照片且分了子目录**的文件夹，逐条确认：

1. 打开后 1 秒内出现网格骨架，可立即滚动
2. 元数据计数在 10 秒内涨满；顶栏缓存计数持续增长
3. 拖动滚动条从顶到底再回顶，**全程不卡顿**；Network 面板里有大量 canceled 的 thumb 请求
4. 连续来回滚动 3 分钟，DevTools Memory 里 JS 堆稳定不持续增长
5. 连拍组显示为卡牌堆，拖动阈值滑块时分组实时重排且不发请求（Network 面板静默）
6. 用键盘从头到尾过一遍：`P`/`X` 手感连贯，光标自动前进
7. 切到「收藏」视图，按 `X` 二次排除，`⌘Z` 能撤销
8. `Enter` 进大图，`空格` 1:1 能判断合焦
9. 导出收藏的 RAW 到一个新目录，数量与「收藏」tab 的计数一致
10. 关掉服务重新 `npm start`，打开同一文件夹：标记全部还在，缩略图**瞬间**出图（磁盘缓存命中）

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat: 滚动优先级重排、README 与验收收尾"
```

---

## 附录：验收清单（对照 spec 逐条核对）

| spec 章节 | 要求 | 实现于 |
|---|---|---|
| §2 | 本机服务只绑 127.0.0.1 | Task 6 Step 8 |
| §3.1 | 递归遍历、跳过规则、深度上限、不跟随符号链接 | Task 2 |
| §3.3 | 资产 ID = 相对目录 + stem，跨目录不撞车 | Task 2 |
| §3.4 | 双向孤儿均可见可标记 | Task 2 / Task 14 角标 |
| §3.5 | 三阶段加载，阶段①后即可交互 | Task 6 session + Task 10 store |
| §3.6 | EXIF 字段与时间回退链 | Task 3 |
| §4.1 | 磁盘缓存 + ETag + immutable | Task 5 / Task 6 |
| §4.2 | sharp rotate + failOn none + 占位图 | Task 5 |
| §4.3 | 后台烘焙与让位 | Task 7 |
| §4.4 | 入队 / 优先级 / abort / LRU 四层 | Task 12 / Task 14 / Task 18 |
| §4.5 | 行级虚拟滚动 | Task 14 |
| §5.1 | 时间 + 机身 + 非 mtime 三条件 | Task 11 |
| §5.2 | 阈值前端实时重排 | Task 11 / Task 15 |
| §5.3 | 卡牌堆 + ×N + 点击展开 | Task 14 |
| §6.2 | 全部快捷键 | Task 15 |
| §6.3 | 四个筛选视图 + 目录侧栏 | Task 15 |
| §6.4 | 撤销栈 50 步，批量算一步 | Task 13 |
| §7 | marks.json 原子写 + bak 回退 | Task 4 |
| §8.2 | 五个导出选项 | Task 8 / Task 17 |
| §8.3 | 移动的复制→校验→删源顺序与数量确认 | Task 8 / Task 9 / Task 17 |
| §8.4 | 冲突跳过与重命名 | Task 8 |
| §8.5 | SSE 进度、可取消、missingRaw 高亮 | Task 9 / Task 17 |
| §8.6 | manifest.csv + rejected.txt | Task 8 |
| §9 | safepath + 只收资产 ID | Task 1 / Task 6 |
| §10 | 全部测试项 | Task 1–13 各自的测试 |
