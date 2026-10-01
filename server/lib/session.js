import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pathWin32 from 'node:path/win32';
import { scanFolder } from './scan.js';
import { readAllMeta } from './meta.js';
import { createMarkStore, marksDir } from './store.js';
import { realpathDeep } from './safepath.js';
import { listDrives } from './drives.js';

/**
 * sessionId -> session。
 *
 * 以前这里是 `let current = null` 的单全局会话：谁最后打开文件夹，谁就是"那个"会话，
 * 而所有接口都只问"有没有会话"，从不问"是哪一个"。第二个标签页打开另一个文件夹之后，
 * 第一个标签页的标记会静默落进第二个文件夹的 marks.json（两台同型号机身拍出来的
 * IMG_0002 在两个文件夹里是同一个 id，连报错的机会都没有），缩略图也会串。
 */
const sessions = new Map();

/**
 * canonicalRoot -> sessionId。
 *
 * 同一个文件夹只会有一个会话：第二个标签页打开同一个文件夹时直接复用（不重扫、不重开
 * bake），两个标签页的标记写进同一个 markStore，不会互相覆盖。
 */
const byRoot = new Map();

/**
 * canonicalRoot -> Promise<session>，同 root 的"在途 open"去重。
 *
 * 没有这张表的话，两个并发的 POST /api/library/open 会各自扫描、各自建会话、各自
 * startBake；输的那一个会话再也没有人持有引用，aborted 永远是 false，它的 bake 会
 * 用满闸门宽度一直烤到天荒地老，跟赢的那个抢 sharp 闸门。
 */
const opening = new Map();

export function getSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  return sessions.get(sessionId) ?? null;
}

/**
 * 按文件夹查一个**已经开着**的会话，查不到返回 null。
 *
 * 只查表。绝不 realpath、绝不扫描、绝不开库——第一个调用方是
 * `GET /api/share/:token/info` 的 `assetCountHint`，那是一个**无身份**端点：
 * 让它为了回答"这个库有多少张照片"去碰一下磁盘，就等于把一个谁都能反复按的
 * 磁盘压力按钮挂在公网入口上。字段名本身就是 Hint——没开着就是不知道，
 * 不知道就返回 null。
 *
 * 键是 openSession 用过的规范路径（realpathDeep 的结果）。调用方手里的 root
 * 如果来自 share 记录，那本来就是建分享时 realpath 过的，直接查得到。
 */
export function getSessionByRoot(root) {
  if (typeof root !== 'string' || root === '') return null;
  const id = byRoot.get(root);
  if (id === undefined) return null;
  return sessions.get(id) ?? null;
}

/**
 * 全部活着的会话的快照（数组，不是活引用）。
 *
 * presence.js 要按 userId / shareId 找连接，而一个用户的连接只可能落在
 * "他那条分享指向的那个文件夹"的会话上。用快照而不是直接暴露 Map，
 * 是因为调用方会在遍历过程中摘除 listener，不该让它同时也能改会话表。
 */
export function listSessions() {
  return [...sessions.values()];
}

/** 文件夹不可写：这是一个用户必须去处理的阻断状态，不是一次可以重试的偶发失败。 */
export class FolderNotWritableError extends Error {
  constructor(cause) {
    super('这个文件夹不可写，选片进度和缩略图缓存都无法保存。请把照片复制到可写位置后再打开。');
    this.name = 'FolderNotWritableError';
    this.code = 'not-writable';
    this.status = 400;
    this.detail = cause?.message ?? String(cause);
    this.cause = cause;
  }
}

/** 路径不存在或不是目录。和"不可写"一样，是用户必须去处理的阻断状态。 */
export class NoSuchFolderError extends Error {
  constructor(root) {
    super('这个路径不存在，或者不是一个文件夹。请检查是否有拼写错误。');
    this.name = 'NoSuchFolderError';
    this.code = 'no-such-folder';
    this.status = 400;
    this.detail = root;
  }
}

/**
 * 开库的第一道判断：这个路径必须是一个**已经存在的目录**。
 *
 * 顺序至关重要，必须排在 assertWritable 前面。assertWritable 里的
 * `fs.mkdir(<root>/.photocull, { recursive: true })` 会把整条缺失的路径一起建出来——
 * 于是「在选择器里粘贴路径时打错一个字」的后果，从"报错"变成了
 * "磁盘上凭空多出一棵目录树，界面上是一个零解释的空网格"。
 * 修复前 scanFolder 至少还会返回 warnings: ["无法读取目录 .：ENOENT"]，
 * 加了写探测之后连那条警告都没有了。
 */
async function assertIsExistingDir(root) {
  let st;
  try {
    st = await fs.stat(root);
  } catch {
    throw new NoSuchFolderError(root);
  }
  if (!st.isDirectory()) throw new NoSuchFolderError(root);
}

/**
 * 扫描之前先做一次真实的写探测：建 .photocull/，写一个探针文件，再删掉。
 *
 * 触发场景全是真实的：SD 卡的写保护开关、只读的 SMB/NFS 挂载、磁盘写满、目录属于
 * 别的用户。这些情况下标记一条都存不下来、缩略图一张都烤不出来，而旧实现会一路
 * 返回 200，让摄影师标记三个小时之后才在关闭时撞上一个没法补救的 500。
 */
async function assertWritable(root) {
  const dir = marksDir(root);
  const probe = path.join(dir, `.write-probe-${process.pid}-${crypto.randomUUID()}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    const handle = await fs.open(probe, 'w');
    try {
      await handle.writeFile('photocull write probe', 'utf8');
    } finally {
      await handle.close();
    }
    await fs.rm(probe, { force: true });
  } catch (err) {
    // 探针可能已经建出来了但删除那一步才失败，尽力清干净，清不掉也不影响判定。
    try { await fs.rm(probe, { force: true }); } catch { /* 本来就写不进去 */ }
    throw new FolderNotWritableError(err);
  }
}

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
    // 用 path.win32 做段对齐比较：safepath.js 的 isWithin 在 POSIX 系统上
    // 处理 Windows 路径字符串时 backslash 被当普通字符，path.relative 结果失效。
    // path.win32 在任何 OS 上都能正确处理 Windows 路径语义。
    if (drives.some((d) => {
      const rel = pathWin32.relative(pathWin32.resolve(d), pathWin32.resolve(home));
      return rel === '' || (!rel.startsWith('..' + pathWin32.sep) && rel !== '..' && !pathWin32.isAbsolute(rel));
    })) return drives;
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

/**
 * session.listeners 存的是 `{ send, end, actor }`。
 *
 * - `send`：光有它关不掉底层连接，所以还要——
 * - `end`：一个能调用 res.end() 的钩子，closeSession() 和 presence.js 的踢人/撤销
 *   才有办法真正终止还开着的 SSE 连接。只发事件不断开不叫踢人：客户端完全可以
 *   忽略事件继续用。
 * - `actor`：这条连接背后是谁（`{kind:'admin'}` / `{kind:'user',user,share}`）。
 *   **在线名单就是由这个集合直接派生的**（见 presence.js），不做心跳：连接建立即上线，
 *   `req.on('close')` 即下线。少一套超时判定，少一类幽灵在线。
 *   非 HTTP 来源的 listener（测试里的假订阅者）可以没有 actor，派生名单时跳过。
 */
export function emit(session, event) {
  for (const listener of session.listeners) {
    try { listener.send(event); } catch { /* 订阅者已断开 */ }
  }
}

/**
 * 给每条连接单独算一帧再发。回调返回 `null` / `undefined` 表示这条连接不发。
 *
 * `emit` 的语义是「同一帧发给所有人」。在 showPeerMarks 之前那一直成立，
 * 现在不成立了：同一次写入对不同的访客意味着不同的东西，而**「有没有这一帧」
 * 本身就是要被隐藏的信息之一**——把值换成她该看到的那个、照发不误，泄露的
 * 是时机：她那一格在别人操作的瞬间重渲染一次，等于告诉她「刚才有人动了这张」。
 *
 * 构造回调里抛错只跳过这一条连接：一条连接的 actor 形状坏掉不该让**其余所有人**
 * 都收不到这一帧。发送失败照 emit 的规矩静默吞掉（对端已经断了）。
 */
export function emitPerListener(session, build) {
  for (const listener of session.listeners) {
    let event;
    try {
      event = build(listener);
    } catch (err) {
      console.error('[emit] 为某条连接构造事件失败，跳过它', err);
      continue;
    }
    if (event === null || event === undefined) continue;
    try { listener.send(event); } catch { /* 订阅者已断开 */ }
  }
}

function unregister(session) {
  sessions.delete(session.id);
  if (byRoot.get(session.root) === session.id) byRoot.delete(session.root);
}

/**
 * 关闭指定会话。找不到（已经关过 / id 不对）返回 false，不算错误。
 *
 * 顺序是有讲究的：必须等 markStore.close() 真正把标记落盘之后，才从注册表里摘掉
 * 这个会话。旧实现是先 `current = null` 再 close()，close() 一抛错（只读文件夹、
 * 磁盘写满）会话就已经没了，摄影师连一次重试的机会都没有，看到的只有一个 500。
 *
 * 但 close() 失败也不能把会话永远留在表里——那样"换文件夹"会永远卡住。所以失败时
 * 照样摘掉（finally），把错误原样往上抛，由路由转成 500 + 明确文案。
 */
export async function closeSession(sessionId) {
  const session = getSession(sessionId);
  if (!session) return false;

  session.aborted = true;
  const { stopBake } = await import('./bake.js');
  await stopBake(session);
  // 主动结束每一条还开着的 SSE 连接——否则客户端的连接看起来还活着，
  // 实际上再也收不到任何消息，只能靠自己的超时或用户手动刷新才能发现。
  for (const listener of session.listeners) {
    try { listener.end(); } catch { /* 连接已经断了，end() 失败也无所谓 */ }
  }
  session.listeners.clear();

  try {
    await session.markStore.close();
  } finally {
    unregister(session);
  }
  return true;
}

/**
 * 进程退出（SIGINT/SIGTERM）时的兜底：尽力关掉每一个会话。
 * 单个会话关闭失败不应该妨碍其它会话落盘，所以这里只收集错误并打日志，不往外抛。
 */
export async function closeAllSessions() {
  const results = await Promise.allSettled([...sessions.keys()].map((id) => closeSession(id)));
  const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
  for (const err of errors) console.error('[session] 关闭会话失败', err);
  return errors;
}

/**
 * 扫描出错时能安全广播出去的一句话。
 *
 * **绝不能把原始 err.message 发上流。** fs 的错误消息长这样：
 * `ENOSPC: no space left on device, scandir '/Users/她/婚礼/RAW'` —— 里面是
 * 摄影师磁盘上的绝对路径，而这条 SSE 流对 viewer 也是开放的（Task 7）。
 * errno 码本身（EACCES/EIO/…）不含路径，留着它对排查有用，所以只放行
 * 形如 ALL_CAPS 的短码，别的一律丢掉。原始错误只进服务端日志。
 */
const SAFE_ERRNO = /^[A-Z][A-Z0-9_]{1,31}$/;
export function scanErrorMessage(err) {
  const code = err?.code;
  return typeof code === 'string' && SAFE_ERRNO.test(code)
    ? `扫描文件夹时出错（${code}），请重试`
    : '扫描文件夹时出错，请重试';
}

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

/**
 * 扫描 + 扫描之后才做得了的那些事（元数据、烘焙）。**永不 reject**。
 *
 * 永不 reject 是刻意的：这个 promise 会挂在 session.ready 上被任意多个（或者零个）
 * 调用方 await，一个没人接住的 rejection 在 Node 里是要让整个进程崩掉的。
 * 出错的事实记在 session.scan.error 里，由 openSession() 这类等待方去抛。
 */
async function runScan(session) {
  const { root } = session;
  try {
    const { assets, warnings, skippedFiles } = await scanFolder(root, {
      // onBatch 的契约是**累计**计数（不是增量），逐字照用，不在这里做加法。
      onBatch(found) {
        if (session.aborted) return;
        session.scan.found = found;
        emit(session, { type: 'scan', found, done: false });
      },
    });
    // 扫描期间库被关掉了（换文件夹 / 进程退出）：这个会话已经不在注册表里，
    // 往它身上填资产、给它排烤箱任务都只是在给一个死会话干活。
    if (session.aborted) return;

    session.assets = assets;
    session.warnings = warnings;
    session.skippedFiles = skippedFiles;
    session.byId = new Map(assets.map((a) => [a.id, a]));
    session.bake.total = assets.filter((a) => a.jpg).length;
    session.scan.done = true;
    emit(session, { type: 'scan', found: session.scan.found, done: true });

    // 元数据后台读，不阻塞任何东西
    await startPostScan(session);
  } catch (err) {
    console.error('[scan] 扫描失败', err);
    session.scan.error = err;
    if (session.aborted) return;
    session.aborted = true;
    // 先把理由发出去，再断连接——顺序反了客户端就只看到一条无缘无故断掉的流。
    emit(session, { type: 'scan', found: session.scan.found, done: false, error: scanErrorMessage(err) });
    for (const listener of session.listeners) {
      try { listener.end(); } catch { /* 对端已经断了 */ }
    }
    session.listeners.clear();
    unregister(session);
    // 一张标记都还没来得及产生，这次 close 只是把 markStore 的定时器收干净。
    try { await session.markStore.close(); } catch (e) { console.error('[scan] 清理会话失败', e); }
  }
}

async function createSession(root) {
  // 存在性必须在写探测之前：写探测会 mkdir -p，能把一个打错的路径凭空建出来。
  await assertIsExistingDir(root);
  // 写探测必须在**返回之前**完成，而不只是在扫描之前：它和存在性检查一样是
  // "这个库能不能成立"的前置判断，异步化的后果是用户先看到进度条跑起来，
  // 再被告知这个文件夹根本存不下任何东西。
  await assertWritable(root);
  // markStore 也在返回之前建好：它只读一个小 JSON，和扫描时长无关，
  // 而 settings / marksRecovered 是开库响应里就要给出去的。
  const markStore = await createMarkStore(root);

  const session = {
    id: crypto.randomUUID(),
    root, markStore,
    // 扫描还没跑，先给空壳。资产表在 runScan 里**整体替换**。
    assets: [], warnings: [], skippedFiles: 0,
    byId: new Map(),
    metas: new Map(),
    metaDone: false,
    bake: { done: 0, total: 0, running: false },
    /**
     * 扫描进度。found 是**累计**的文件计数（不是资产数、不是增量），
     * 与 scan.js 的 onBatch 契约一致；error 存的是原始错误对象，
     * 只给等待方（openSession）用，广播出去的永远是脱敏后的那句话。
     */
    scan: { found: 0, done: false, error: null },
    aborted: false,
    /** 正在进行的重扫。并发调用合并到同一个 promise 上。 */
    rescan: null,
    listeners: new Set(),
  };
  // 注册必须排在扫描前面：客户端一拿到 sessionId 就要用它连 SSE，
  // 而进度事件正是从那条流上来的。
  sessions.set(session.id, session);
  byRoot.set(root, session.id);
  session.ready = runScan(session);

  return session;
}

/**
 * 开库，**不等扫描**：路径校验、写探测、markStore 都做完，扫描在后台跑。
 *
 * 返回的会话已经在注册表里，`session.scan` 是当前进度，`session.ready` 在扫描
 * 落定（成功或失败）时 resolve。这是 `POST /api/library/open` 用的那一个：
 * 读卡器上 3000 对照片要扫几十秒，阻塞到扫完再回应的话，界面上只有一个静止的
 * "正在扫描…"，跟卡死无法区分。
 */
export async function beginSession(root) {
  // byRoot / opening 两张表都以真实路径为键：同一个文件夹通过软链接、大小写不同的
  // 挂载名字进来时必须命中同一个会话，否则"一个文件夹一个会话"这条不变量就是假的。
  const canonicalRoot = await realpathDeep(root);

  const alive = sessions.get(byRoot.get(canonicalRoot));
  if (alive) return alive;

  const inflight = opening.get(canonicalRoot);
  if (inflight) return inflight;

  const promise = createSession(canonicalRoot).finally(() => {
    opening.delete(canonicalRoot);
  });
  opening.set(canonicalRoot, promise);
  return promise;
}

/**
 * 开库并**等到扫描结束**。语义与改造之前完全一致，既有调用方（访客 join/resume、
 * 测试）都靠这一条：它们要的是 `session.assets`，拿到一份还没扫完的空表比等一会
 * 更糟——那是一个零解释的空网格。
 */
export async function openSession(root) {
  const session = await beginSession(root);
  await session.ready;
  // 扫描失败的会话已经被清理掉了，这里必须把错误抛出去，
  // 而不是返回一个永远为空、看起来却很正常的库。
  if (session.scan.error) throw session.scan.error;
  return session;
}

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
    // 旧值兜底：onBatch 一次都不触发时（空文件夹，见 scan.js 收尾 flush 的
    // `sinceBatch > 0` 条件）found 必须留在原地，而不是被谁悄悄清成 0。
    // 真正要紧的是它只在下面的成功分支才写回 session.scan——扫描失败时
    // session.scan 一个字段都不能动，跟"保留旧资产表"这条约束保持一致。
    let found = session.scan.found;
    try {
      // 根目录本身没了（移动硬盘拔了、网络盘掉了、文件夹被挪走）是刷新最常见的
      // 失败方式，而 walk() 会把根目录的 readdir 失败吞成一条 warning 正常返回——
      // 不先在这里拦一道，这种情况会被当成"照片全被删了"，资产表整个换成空的，
      // 还以成功的姿态返回。开库路径（createSession）一直用这个断言守着，刷新
      // 没有理由比它松。
      await assertIsExistingDir(session.root);
      const { assets, warnings, skippedFiles } = await scanFolder(session.root, {
        onBatch(n) {
          if (session.aborted) return;
          found = n;
          // 复用 scan 事件：前端已经有一条渲染扫描进度的路径，
          // 再造一个只在刷新时用的进度事件等于让那段代码有两个来源。
          emit(session, { type: 'scan', found: n, done: false });
        },
      });
      if (session.aborted) return { removed: 0, added: 0 };

      const after = new Set(assets.map((a) => a.id));
      let removed = 0;
      for (const id of before) if (!after.has(id)) removed++;
      let added = 0;
      for (const id of after) if (!before.has(id)) added++;

      // 旧的烘焙队列是照着旧资产表建的，而 startBake 的幂等守卫（bake.js 的
      // WeakMap）一旦建立就不会自己消失——不先停掉它，下面 startPostScan 里那次
      // startBake 会直接 return，新照片一张都进不了队列，session.bake 也会永久
      // 停在这次重置后的 {done:0, running:false} 上。停在这个位置还有一层意思：
      // 必须赶在替换 session.bake 之前，否则还没跑完的旧循环会把 done++ 写到
      // 新对象上，两次烘焙的进度混在一起。**不能挪到 try 块开头**——扫描失败时
      // 旧资产表要原样保留，那它的烘焙也该原样保留，不能被我们先斩了。
      const { stopBake } = await import('./bake.js');
      await stopBake(session);

      session.assets = assets;
      session.warnings = warnings;
      session.skippedFiles = skippedFiles;
      session.byId = new Map(assets.map((a) => [a.id, a]));
      session.bake = { done: 0, total: assets.filter((a) => a.jpg).length, running: false };
      session.metaDone = false;
      // metas 刻意**不清空**：已经读出来的 EXIF 不会因为重扫而失效，
      // 清掉只会让三千张照片的元数据白读一遍。消失资产的条目留着无害。
      session.scan = { found, done: true, error: null };

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
