import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../index.js';
import { closeAllSessions, browseRoots } from '../lib/session.js';
import { realpathDeep } from '../lib/safepath.js';

// F6：给 browseRoots() 的别名卷过滤逻辑做一次不依赖真实挂载状态的单元测试用的开关。
// active 平时是 false，下面两个 mock 直接透传给真实实现，对其它任何测试没有影响；
// 只有专门那一条测试会临时把它打开，模拟 "/Volumes 下有一个解析到系统根的别名卷" 这种场景，
// 用完立刻在 finally 里关掉。用 vi.hoisted 声明是因为 vi.mock 工厂会被提升到所有 import 之前，
// 只有这样声明的变量才能在工厂函数里安全引用。
const volumesFake = vi.hoisted(() => ({
  active: false,
  entries: /** @type {string[]} */ ([]),
  realpaths: /** @type {Map<string, string>} */ (new Map()),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  const readdir = async (dir, opts) => {
    if (volumesFake.active && dir === '/Volumes') return volumesFake.entries;
    return actual.readdir(dir, opts);
  };
  // node:fs/promises 的默认导出是一个独立于具名导出的对象（'default' in mod 且 mod.default !== mod），
  // session.js 用的是 `import fs from 'node:fs/promises'` 默认导入，走的是 mod.default.readdir 这条路径，
  // 只覆盖顶层具名导出的 readdir 对它没有任何效果——两边都要覆盖成同一个假实现。
  return {
    ...actual,
    readdir,
    default: { ...actual.default, readdir },
  };
});

vi.mock('../lib/safepath.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    realpathDeep: async (p) => {
      if (volumesFake.active && volumesFake.realpaths.has(p)) return volumesFake.realpaths.get(p);
      return actual.realpathDeep(p);
    },
  };
});

let server, base, tmp;
/** 当前会话 id。会话有身份之后，测试也必须像真实前端一样在每个请求上带着它。 */
let sid = '';

const api = (p, init = {}) => fetch(base + p, {
  ...init,
  headers: { ...(init.headers ?? {}), ...(sid ? { 'X-PhotoCull-Session': sid } : {}) },
});
/** 明确不带任何会话身份的裸请求，用来验证 requireSession 真的在拦。 */
const anon = (p, init) => fetch(base + p, init);
const json = async (p, init) => (await api(p, init)).json();
const openLib = async (root = tmp) => {
  const data = await json('/api/library/open', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root }),
  });
  if (data.sessionId) sid = data.sessionId;
  return data;
};
const closeAll = async () => { await closeAllSessions(); sid = ''; };

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
  await closeAll();
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
  // 回归钉子（F1）：macOS 上 /Volumes/<启动盘名> 是指向 "/" 的符号链接。
  // browseRoots() 如果把这类条目原样塞进允许列表，assertWithin 解析后会把
  // 文件系统根本身也当成"在边界内"——这条请求本身就会被放行。
  // 只要 browseRoots() 里再出现一个解析到 "/" 的根，这条测试就会失败。
  it('拒绝文件系统根路径本身（钉住 F1：不允许任何根解析为 "/"）', async () => {
    expect((await api('/api/fs/list?path=%2F')).status).toBe(403);
  });

  // F4：目标是文件而不是目录时，fs.readdir 抛 ENOTDIR，原始错误信息里带服务器绝对路径
  // （"scandir '/private/.../A.JPG'"），不能直接透传给客户端，也不该是 500。
  it('目标是文件而非目录时返回 400，且响应体不泄露服务器绝对路径', async () => {
    const filePath = path.join(tmp, 'A.JPG');
    const res = await api(`/api/fs/list?path=${encodeURIComponent(filePath)}`);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(JSON.stringify(data)).not.toContain(tmp);
  });

  // F4：目标目录不可读时，fs.readdir 抛 EACCES，同样不能把服务器路径带回响应体，也不该是 500。
  // chmod 000 在以 root 运行时不生效（root 绕过权限位），这种环境下跳过这条断言。
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  it.skipIf(isRoot)('目标目录不可读时返回 400，且响应体不泄露服务器绝对路径', async () => {
    const secret = path.join(tmp, 'secret-unreadable');
    await fs.mkdir(secret, { recursive: true });
    await fs.chmod(secret, 0o000);
    try {
      const res = await api(`/api/fs/list?path=${encodeURIComponent(secret)}`);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(JSON.stringify(data)).not.toContain(tmp);
    } finally {
      await fs.chmod(secret, 0o755); // 恢复权限，否则 afterAll 里的 recursive rm 可能删不掉它
    }
  });
});

// F6：F1 的回归测试（"拒绝文件系统根路径本身"）依赖这台机器真的有一个解析到 "/" 的挂载别名——
// 在没有这种别名的机器（比如 Linux、或者没有 /Volumes/<启动盘> 这种命名的 Mac）上，
// 旧的、有问题的 browseRoots() 实现同样会让那条测试通过，起不到钉住回归的作用。
// 这里直接对 browseRoots() 做单元测试，把 fs.readdir('/Volumes') 和 realpath 解析都换成假实现，
// 不依赖真实的挂载状态，就能确定性地验证"别名卷会被丢弃、真实卷会被保留"这条逻辑本身。
//
// 断言的对象很关键：不能只检查返回值里有没有字面量 "/"。历史上真实的 bug 是把
// /Volumes/Macintosh HD 这个原始的、没解析过的字符串直接塞进列表——那个字符串本身并不
// 等于 "/"，只有 assertWithin 后续拿它去 realpath 解析之后才会变成 "/"。所以这里断言的是
// assertWithin 实际依赖的那条安全属性："每一个返回的根，解析之后都不能是文件系统根"，
// 而不是某个实现细节（"返回值字面量里没有 '/'"）。前者能抓住真实的历史 bug，后者抓不住。
describe('browseRoots 单元测试（钉住 F1 的过滤逻辑，不依赖真实挂载状态）', () => {
  it('每一个返回的根，解析后都不能是文件系统根 "/"；真实挂载卷仍然被保留', async () => {
    volumesFake.active = true;
    volumesFake.entries = ['Macintosh HD', 'External SSD'];
    volumesFake.realpaths = new Map([
      ['/Volumes/Macintosh HD', '/'],                    // 别名卷：解析到系统根
      ['/Volumes/External SSD', '/Volumes/External SSD'], // 真实挂载卷
    ]);
    try {
      const roots = await browseRoots();
      for (const root of roots) {
        const resolved = await realpathDeep(root);
        expect(resolved).not.toBe('/');
      }
      // 顺便确认真实挂载卷没有被一并误伤——不是把 /Volumes 下所有条目都丢了。
      expect(roots).toContain('/Volumes/External SSD');
    } finally {
      volumesFake.active = false;
      volumesFake.entries = [];
      volumesFake.realpaths = new Map();
    }
  });
});

describe('库的打开与关闭', () => {
  it('未打开库时接口返回 409', async () => {
    await closeAll();
    expect((await api('/api/library/assets')).status).toBe(409);
  });

  it('打开文件夹返回会话与资产数', async () => {
    const data = await openLib();
    expect(data.root).toBe(tmp);
    // I7：开库不再等扫描，所以响应发出的那一刻资产数还不知道（phase: 'scanning'）。
    // 资产数改由 /assets 回答——requireSession 会等扫描落定，不会回一份空表。
    expect(data.phase).toBe('scanning');
    expect((await json('/api/library/assets')).assets).toHaveLength(2);
  });

  it('资产表按 id 排序且跨目录不撞车', async () => {
    const data = await json('/api/library/assets');
    expect(data.assets.map((a) => a.id)).toEqual(['A', 'cam-a/B']);
  });
});

describe('GET /api/thumb', () => {
  // 回归钉子（F2）：缩略图缓存文件放在 <root>/.photocull/thumbs/ 下（点号目录）。
  // res.sendFile 默认 dotfiles:'ignore'，路径里只要有一段以 "." 开头就无条件 404，
  // 不管文件是否存在——这条测试必须真正读到非空的 webp 字节，
  // 不能只靠 If-None-Match 分支侥幸通过（那个分支根本不会走到 sendFile）。
  it('返回 webp 并带强缓存头与 ETag（缓存未命中也要能真正读到文件内容）', async () => {
    const res = await api('/api/thumb?id=A&tier=grid');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/webp');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('etag')).toBeTruthy();
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);
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

  // F3：一批标记里如果有一个值非法（既不是 'pick'/'reject' 也不是 null），
  // 之前的实现会在 setMark() 里半路抛出未捕获异常（500），但前面已经处理过的条目已经生效——
  // 客户端看到 500 会以为整条请求都没生效，实际上部分数据已经落地，状态不一致。
  // 现在要求：值校验和 id 校验一样，必须在动手写入之前全部做完，一个不合法就整体拒绝（400），不写入任何一条。
  it('标记值非法时整体拒绝（400）且不产生部分生效（钉住 F3）', async () => {
    const before = await json('/api/library/marks');
    const res = await api('/api/library/marks', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marks: { A: 'pick', 'cam-a/B': 'bogus-value' } }),
    });
    expect(res.status).toBe(400);
    const after = await json('/api/library/marks');
    expect(after.marks).toEqual(before.marks);
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

  // F5：之前 closeSession() 只清空了 listeners 这个 Set，从没调用过任何东西去真正终止
  // 底层的 HTTP 响应——SSE 连接会一直"看起来还活着"，实际上再也不会收到任何消息。
  // 这条测试确认库关闭之后，已经建立的连接会被服务端主动 res.end()，
  // 客户端的 reader 应该能读到流结束（done: true），而不是永远挂着等下一条消息。
  it('库关闭后，已经建立的 SSE 连接应该被服务端主动结束（钉住 F5）', async () => {
    await openLib(); // 确保有一个打开的库可以建立连接
    // 等元数据后台任务跑完，这样建立 SSE 连接之后不会再有它自己产生的 meta/metaDone 帧
    // 混进来干扰下面"是不是流结束了"这个判断。
    for (let i = 0; i < 50; i++) {
      const meta = await json('/api/library/meta');
      if (meta.done) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const ctrl = new AbortController();
    const res = await api('/api/library/stream', { signal: ctrl.signal });
    const reader = res.body.getReader();
    await reader.read(); // 读掉首帧快照（此时元数据已经跑完，之后不会再有新帧）

    await api('/api/library/close', { method: 'POST' });

    // **读到流结束为止，不是"下一次 read() 就该是结束"。**
    // 这条流在快照之后还会有别的帧（addListener 会紧接着广播一帧 presence），
    // 而这些 res.write() 落进几个 TCP 分块完全由内核决定：合并成一块时
    // 第一次 read() 就把它们全读走了，分开时第二次 read() 拿到的是那一帧
    // 数据而不是流结束。断言的对象是"服务端最终把连接关掉了"，
    // 不是"关掉之前一共发过几帧"——所以这里必须循环。
    // 上限只挡"服务端一直往这条流里灌帧却从不关闭"这一种坏法；
    // 它一帧不发也不关的话 read() 会一直挂着，由 vitest 的超时判红——
    // 两种都是红，只是形态不同。正常路径读到 done 立刻退出，不会跑满。
    let done = false;
    for (let i = 0; i < 50 && !done; i++) {
      ({ done } = await reader.read());
    }
    expect(done).toBe(true);
    ctrl.abort();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C2：会话身份。以前所有接口都只问"有没有会话"，从不问"是哪一个"——第二个标签页
// 打开另一个文件夹之后，第一个标签页的标记会落进第二个文件夹的 marks.json，缩略图
// 也会串，两边都不报错。
// ─────────────────────────────────────────────────────────────────────────────
describe('会话身份（C2）', () => {
  /** 需要会话的路由全集。/thumb 和 /original 以前没有校验，是 C2 最直接的成因。 */
  const GUARDED = [
    ['GET', '/api/library/assets'],
    ['GET', '/api/library/meta'],
    ['GET', '/api/library/stream'],
    ['POST', '/api/library/prioritize'],
    ['POST', '/api/library/close'],
    ['GET', '/api/library/marks'],
    ['PUT', '/api/library/marks'],
    ['PUT', '/api/library/settings'],
    ['GET', '/api/thumb?id=A'],
    ['GET', '/api/original?id=A'],
    ['POST', '/api/export'],
  ];

  it('不带会话 id 的请求一律 409 session-gone', async () => {
    await openLib();   // 确实有一个活着的会话——被拦是因为没表明身份，不是因为没库
    for (const [method, p] of GUARDED) {
      const res = await anon(p, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
      expect(res.status, `${method} ${p} 应该 409`).toBe(409);
      expect((await res.json()).error, `${method} ${p} 的 error 码`).toBe('session-gone');
    }
  });

  it('带一个已经失效的会话 id 同样是 409 session-gone', async () => {
    const stale = (await openLib()).sessionId;
    await api('/api/library/close', { method: 'POST' });
    const res = await anon('/api/library/assets', { headers: { 'X-PhotoCull-Session': stale } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('session-gone');
    expect(body.message).toContain('重新打开');
    sid = '';
  });

  it('?sid= 查询参数与请求头等价（<img src> 和 EventSource 设不了请求头）', async () => {
    const { sessionId } = await openLib();
    const thumb = await anon(`/api/thumb?id=A&tier=grid&sid=${encodeURIComponent(sessionId)}`);
    expect(thumb.status).toBe(200);
    const original = await anon(`/api/original?id=A&sid=${encodeURIComponent(sessionId)}`);
    expect(original.status).toBe(200);

    const ctrl = new AbortController();
    const stream = await anon(`/api/library/stream?sid=${encodeURIComponent(sessionId)}`,
      { signal: ctrl.signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    ctrl.abort();
  });

  it('两个标签页各开一个文件夹时，标记和缩略图都不会串到对方去', async () => {
    // 两台同型号机身拍出来的 IMG_0002 在两个文件夹里就是同一个 id——这是常态。
    const other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'routes-other-')));
    try {
      await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 30, b: 30 } } })
        .jpeg().toFile(path.join(other, 'A.JPG'));
      await fs.writeFile(path.join(other, 'A.CR3'), 'other raw');

      const tabA = (await openLib(tmp)).sessionId;
      const tabB = (await openLib(other)).sessionId;
      expect(tabA).not.toBe(tabB);

      const mark = (session, value) => anon('/api/library/marks', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'X-PhotoCull-Session': session },
        body: JSON.stringify({ marks: { A: value } }),
      });
      expect((await mark(tabA, 'pick')).status).toBe(200);
      expect((await mark(tabB, 'reject')).status).toBe(200);

      const marksOf = async (session) => (await (await anon('/api/library/marks',
        { headers: { 'X-PhotoCull-Session': session } })).json()).marks;
      // tmp 这个库在前面的用例里已经被标过别的资产，所以只断言 A 这一个 id 的归属；
      // 关键是两边的 A 各是各的值，而不是后写的那次把先写的那次覆盖掉。
      expect((await marksOf(tabA)).A).toBe('pick');
      const marksB = await marksOf(tabB);
      expect(marksB.A).toBe('reject');
      // 另一个文件夹里压根没有 cam-a/B 这个资产，它要是出现在这里，
      // 就说明两个标签页共用了同一个 markStore。
      expect(marksB).not.toHaveProperty('cam-a/B');

      // 同一个 id 的缩略图必须来自各自的文件夹：两张图的底色差别极大，
      // 字节完全相同就说明服务端把另一个文件夹的照片当成了这一个的。
      const bytes = async (session) => Buffer.from(await (await anon(
        `/api/thumb?id=A&tier=grid&sid=${encodeURIComponent(session)}`)).arrayBuffer());
      const [bytesA, bytesB] = [await bytes(tabA), await bytes(tabB)];
      expect(bytesA.length).toBeGreaterThan(0);
      expect(bytesB.length).toBeGreaterThan(0);
      expect(bytesA.equals(bytesB)).toBe(false);
    } finally {
      await closeAll();
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it('open 返回的 sessionId 稳定：同一个文件夹再开一次还是同一个会话', async () => {
    const first = (await openLib()).sessionId;
    const second = (await openLib()).sessionId;
    expect(second).toBe(first);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C1：不可写文件夹。旧实现全程回 200，摄影师标记三小时之后才在关闭时撞上一个
// 没法补救的 500，而磁盘上一个字节都没有。
// ─────────────────────────────────────────────────────────────────────────────
describe('不可写文件夹（C1）', () => {
  const isRootUser = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(isRootUser)('打开只读文件夹返回 400 not-writable，而不是 200', async () => {
    const ro = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'routes-ro-')));
    await fs.writeFile(path.join(ro, 'A.CR3'), 'raw');
    await fs.chmod(ro, 0o555);
    try {
      const res = await anon('/api/library/open', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: ro }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('not-writable');
      expect(body.message).toContain('不可写');
      expect(body.detail).toBeTruthy();
    } finally {
      await fs.chmod(ro, 0o755);
      await fs.rm(ro, { recursive: true, force: true });
    }
  });

  it.skipIf(isRootUser)('后台落盘失败时，PUT /marks 必须 500 persist-failed，不能回 {ok:true}', async () => {
    const vol = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'routes-vol-')));
    await fs.writeFile(path.join(vol, 'A.CR3'), 'raw');
    try {
      await openLib(vol);
      // 打开之后才变成不可写：拔卡、网络盘掉线、磁盘写满都是这个形状。
      await fs.chmod(path.join(vol, '.photocull'), 0o555);

      const put = () => api('/api/library/marks', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ marks: { A: 'pick' } }),
      });

      // 第一次 PUT 只是把防抖定时器排上，落盘失败发生在响应之后。等超过防抖窗口
      // （500ms）让它真的触发并失败——注意不能在这个窗口里反复 PUT，每一次 setMark
      // 都会重置定时器，那样写入永远不会发生，测的就成了别的东西。
      expect((await put()).status).toBe(200);
      await new Promise((r) => setTimeout(r, 1500));

      // 这一次必须把上一次的失败如实报出来。错误是粘住的（takeError 之前不会消失），
      // 所以这里不需要抢时机。
      const res = await put();
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('persist-failed');
      expect(body.message).toContain('标记未能写入磁盘');
    } finally {
      await fs.chmod(path.join(vol, '.photocull'), 0o755).catch(() => {});
      await closeAll();
      await fs.rm(vol, { recursive: true, force: true });
    }
  });

  it.skipIf(isRootUser)('关闭时落盘失败返回 500 并说人话，而不是一句裸 errno', async () => {
    const vol = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'routes-closefail-')));
    await fs.writeFile(path.join(vol, 'A.CR3'), 'raw');
    try {
      await openLib(vol);
      await api('/api/library/marks', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ marks: { A: 'pick' } }),
      });
      await fs.chmod(path.join(vol, '.photocull'), 0o555);

      const res = await api('/api/library/close', { method: 'POST' });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe('close-failed');
      expect(body.error).toContain('未能把标记写入磁盘');

      // 会话确实被摘掉了——否则"换文件夹"会永远卡住。
      expect((await api('/api/library/assets')).status).toBe(409);
    } finally {
      await fs.chmod(path.join(vol, '.photocull'), 0o755).catch(() => {});
      await closeAll();
      await fs.rm(vol, { recursive: true, force: true });
    }
  });
});
