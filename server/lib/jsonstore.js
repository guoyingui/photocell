import fs from 'node:fs/promises';
import crypto from 'node:crypto';

// 通用原子 JSON 读写。与 server/lib/store.js 里 marks.json 的做法保持一致
// （临时文件 -> fsync -> rename，写前把现有文件轮转成 .bak），
// 但不共享代码：store.js 服务的是 marks.json 这一份特定形状的数据，
// 这里要给 shares.json / users.json / 未来任何"整份读、整份写"的存储复用。
export async function readJson(file, fallback) {
  for (const candidate of [file, `${file}.bak`]) {
    try {
      return JSON.parse(await fs.readFile(candidate, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') continue;   // 没有就试下一个
      // 存在但解析失败：不 return、不 throw，自然落到下一轮循环去试 .bak。
      // 这正是 .bak 存在的理由——主文件写坏了不该让整份数据消失。
    }
  }
  return fallback;
}

export async function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const body = JSON.stringify(data, null, 2);
  const handle = await fs.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();          // rename 之前必须落盘，否则崩溃后可能读到长度正确
                                   // 但内容全零的文件——这是文件系统的已知行为，不是偏执。
  } finally {
    await handle.close();
  }
  // 轮转：现有文件变成 .bak。第一次写时没有现有文件，忽略 ENOENT。
  try {
    await fs.rename(file, `${file}.bak`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await fs.rename(tmp, file);
}

// 按文件路径的进程内互斥。
//
// writeJson 的原子性只管单次落盘——rename 是原子的，不会让人读到半截文件。
// 它管不住 shares.js / users.js 里"读 JSON -> 改内存对象 -> 写回"这类跨多个
// await 的复合操作：两个并发调用可能都在对方写回之前读到同一份旧数据、都通过
// 各自的校验（比如昵称唯一性）、再各自写回——后写的整份文件覆盖先写的，先写
// 那条记录就从磁盘上消失了。withFileLock 把整个"读-改-写"包起来，保证同一个
// file 的调用严格排队，不同 file 的调用互不阻塞。
//
// 实现是一条按 file 路径的 promise 链：每次调用把自己接在链尾，等前一个调用
// 结束后才执行 fn。链里存的"尾巴"必须是一个永不 reject 的 promise——如果直接
// 存 fn() 的结果，一旦某次 fn 抛错，这条 reject 的 promise 会让后面所有等在
// 它上面的 .then 都跳过 fulfilled 分支、拿不到"轮到我了"的信号，等于把这个
// file 的锁永久卡死。只进程内有效，够用：本项目是单进程服务端，不需要跨进程锁。
const fileLocks = new Map();

export function withFileLock(file, fn) {
  const prior = fileLocks.get(file) ?? Promise.resolve();
  const result = prior.then(fn);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  fileLocks.set(file, settled);
  return result;
}
