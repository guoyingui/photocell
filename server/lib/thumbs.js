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

// 两个互相不知道对方存在的并发旋钮，配不对会让下面这条 p-limit 闸门形同虚设。
// 这两个都是必需的——单独去掉任意一个都实测会让尾延迟明显变差，两个都得留着：
//
// 1. Node 自己的 libuv 线程池（UV_THREADPOOL_SIZE，默认 4）——sharp 的每次
//    resize/encode 调用（.toFile()/.toBuffer()）都是作为*一个任务*丢进这个池子
//    执行的。闸门放行到 11 个并发（12 核机器，闸门宽度 = 核数-1）时，如果线程池
//    还是默认的 4，其余 7 个并发请求在闸门"已经放行"之后还要在 libuv 内部再排
//    一次队。
// 2. libvips 自己的内部线程池（sharp.concurrency()，默认约等于核数）——同一次
//    resize 操作内部，libvips 还可能再摊开多个线程处理不同图块，跟第 1 点的线程
//    池是两套彼此不知情的并发控制，摞在一起会超订。
//
// 实测数据（都是"从已上线配置改动一个旋钮"，不是从两个都没修的原始基线改，
// 这点很重要——之前一版的测量方法是从原始基线量的，而当时线程池还是瓶颈，
// 于是 sharp.concurrency(1) 的贡献被完全盖住了，误得出"钉成 1 没用"的结论）：
//   · 已上线配置（线程池=核数-1 且 concurrency(1)），12 核机器：
//     11 并发尾延迟约 190–210ms，33 并发约 560–620ms。
//   · 只去掉 sharp.concurrency(1)（线程池仍是核数-1）——另一台机器上独立测量：
//     11 并发尾延迟 338ms → 733–736ms，33 并发 993ms → 2312–2385ms，
//     相当于把线程池那部分的收益也吃掉了大半，两个旋钮都是关键，缺一不可。
//     （在本机 Apple M2 Max 上这个差距小得多，同样的对比只涨了几十毫秒——
//     内存带宽越高的机器，这层内部线程超订的代价越不明显；不能因为在某一台
//     机器上量不出来，就当它在所有机器/sharp·libvips 版本组合上都不重要。）
//   · 只去掉线程池调整（concurrency(1) 仍然生效，线程池是默认的 4）——
//     退回到接近完全没修的基线：11 并发尾延迟约 455–480ms，
//     33 并发约 1420–1430ms。
// 结论：两个旋钮都留着，谁都别删。以后如果有人想删掉其中一行去"简化"，请先
// 重新跑一遍并发基准（1/11/33 并发下的单请求延迟，从"两个都保留"的配置出发，
// 每次只改一个旋钮去对比，不要从原始基线对比），确认没有把这个问题引入回来：
// 见 .superpowers/sdd/2026-07-26-photocull/task-7-report.md「Fix round 1 · F3」
// 「Fix round 2 · F3a」的测量方法和数据。
//
// 线程池宽度的下限是 4 而不是 1（终审分诊项 a）：这个池子是全局的，除了 sharp 还
// 服务 walk 的每文件 stat、exifr 读取和 export 的 copyFile。取 max(1, 核数-1) 时，
// 一台 2 核机器会把它缩到 1，比 Node 自己的默认值 4 还小，反而挤占 scan/meta/export。
// 下面的 p-limit 闸门宽度是另一回事（它只管 sharp 的并发），仍然是 max(1, 核数-1)。
//
// 这一行 UV_THREADPOOL_SIZE 赋值是 server/lib/thumbs.js 直接被 import 时的兜底
// （比如 bake.test.js / thumbs.test.js 这类不经过 server/index.js 的场景）。
// 真正权威、更早生效的赋值在 server/bootstrap-threadpool.js，作为
// server/index.js 的第一个静态 import——两条路径都要覆盖到，见该文件的注释和
// report「Fix round 2 · F3b」。
process.env.UV_THREADPOOL_SIZE = String(Math.max(4, os.cpus().length - 1));
sharp.concurrency(1);

// 闸门：不限制的话 sharp 会打满所有核，服务本身失去响应
const limit = pLimit(Math.max(1, os.cpus().length - 1));
// 同 key 的并发请求合流，避免重复生成。
// key 必须带上 root：cacheKey 只由(相对路径, mtime, size, 档位)算出来，两个不同的
// 文件夹里放着同名、同大小、同 mtime 的 JPG（同一张卡导两次就是这样）会算出同一个
// key——不带 root 的话，第二个文件夹的请求会拿到第一个文件夹的生成结果，返回的
// file 路径指向别人的缓存目录。
const inflight = new Map();
// 分隔符写成显式的 \u0000 转义（源码里是 6 个 ASCII 字符，不是字面控制字符）：
// 它不可能出现在文件系统路径里，也不可能出现在 16 位十六进制的 key 里，
// 两段拼起来因此不会被内容伪造出边界。
const inflightKey = (root, key) => `${root}\u0000${key}`;

export function cacheKey(relPath, mtimeMs, size, tier) {
  // JSON.stringify 而非空格拼接：拼接会让字段边界可被输入内容伪造，
  // 例如 ('a/b c', 'd', 0, 't') 与 ('a/b', 'c d', 0, 't') 会碰撞。
  return crypto.createHash('sha1')
    .update(JSON.stringify([relPath, mtimeMs, size, tier]))
    .digest('hex').slice(0, 16);
}

const KEY_RE = /^[0-9a-f]{16}$/;

export function thumbPath(root, key) {
  // key 会被拼进文件系统路径；校验格式，防止调用方传入穿越路径当作 key。
  if (!KEY_RE.test(key)) throw new Error(`非法缩略图 key：${key}`);
  return path.join(marksDir(root), 'thumbs', `${key}.webp`);
}

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

  const flightKey = inflightKey(root, key);
  if (inflight.has(flightKey)) return inflight.get(flightKey);

  const srcAbs = path.join(root, ...rel.split('/'));
  const job = limit(() => generate(srcAbs, dest, tier))
    .then(() => ({ file: dest, key, placeholder: false }))
    .catch((err) => {
      console.warn(`[thumb] 生成失败 ${rel}: ${err.message}`);
      return { file: null, key, placeholder: true };
    })
    .finally(() => inflight.delete(flightKey));

  inflight.set(flightKey, job);
  return job;
}
