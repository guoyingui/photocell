#!/usr/bin/env node
/**
 * 为 Tauri 打包准备本机运行时：
 *   1. vite 构建前端 → server/public/
 *   2. 按目标平台交叉安装 node_modules（sharp 的二进制按平台分发）
 *   3. 打成 src-tauri/resources/app.tar.gz
 *   4. 放入对应平台的 Node 可执行文件 → src-tauri/binaries/photocull-node-<triple>
 *
 * 目标 triple 优先读 Tauri 钩子注入的 TAURI_ENV_TARGET_TRIPLE，
 * 没有的话就用本机。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, cpSync, createWriteStream, existsSync,
  mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TAURI = path.join(ROOT, 'src-tauri');
const NODE_VERSION = process.env.PHOTOCULL_NODE_VERSION || '22.22.3';

const TARGETS = {
  'aarch64-apple-darwin': {
    os: 'darwin', cpu: 'arm64',
    nodeKind: 'tarball',
    nodeUrl: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    nodeMember: `node-v${NODE_VERSION}-darwin-arm64/bin/node`,
    binary: 'photocull-node-aarch64-apple-darwin',
  },
  'x86_64-apple-darwin': {
    os: 'darwin', cpu: 'x64',
    nodeKind: 'tarball',
    nodeUrl: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    nodeMember: `node-v${NODE_VERSION}-darwin-x64/bin/node`,
    binary: 'photocull-node-x86_64-apple-darwin',
  },
  'x86_64-pc-windows-msvc': {
    os: 'win32', cpu: 'x64',
    nodeKind: 'exe',
    nodeUrl: `https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`,
    binary: 'photocull-node-x86_64-pc-windows-msvc.exe',
  },
  'aarch64-pc-windows-msvc': {
    os: 'win32', cpu: 'arm64',
    nodeKind: 'exe',
    nodeUrl: `https://nodejs.org/dist/v${NODE_VERSION}/win-arm64/node.exe`,
    binary: 'photocull-node-aarch64-pc-windows-msvc.exe',
  },
};

function hostTriple() {
  const { platform, arch } = process;
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  throw new Error(`不支持的本机平台 ${platform}-${arch}`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} 退出码 ${r.status}`);
  }
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function removeTests(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) removeTests(p);
    else if (ent.name.endsWith('.test.js')) rmSync(p);
  }
}

function assertSharp(appDir, os, cpu) {
  const img = path.join(appDir, 'node_modules', '@img');
  const names = existsSync(img) ? readdirSync(img) : [];
  const needle = `${os}-${cpu}`;
  if (!names.some((n) => n.includes(needle))) {
    throw new Error(`sharp 的 ${needle} 二进制没装上，包是坏的：${names.join(', ') || '(空)'}`);
  }
  const foreign = names.filter((n) => n.startsWith('sharp') && !n.includes(needle));
  if (foreign.length) {
    throw new Error(`包里混进了其它平台的 sharp 二进制，中止：${foreign.join(', ')}`);
  }
}

async function download(url, dest) {
  console.log(`  下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${url} → ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function extractMember(tarball, member, dest) {
  const tmp = path.join(tmpdir(), `photocull-node-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  try {
    run('tar', ['-xzf', tarball, '-C', tmp, member]);
    const extracted = path.join(tmp, member);
    if (!existsSync(extracted)) throw new Error(`归档里没有 ${member}`);
    copyFileSync(extracted, dest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function hostMatches(target, triple) {
  return hostTriple() === triple && target.nodeKind !== 'exe';
}

async function stageNode(target, triple) {
  const binDir = path.join(TAURI, 'binaries');
  mkdirSync(binDir, { recursive: true });
  const dest = path.join(binDir, target.binary);

  if (hostMatches(target, triple) && existsSync(process.execPath)) {
    console.log(`▶ 使用本机 Node → ${dest}`);
    copyFileSync(process.execPath, dest);
    chmodSync(dest, 0o755);
    return;
  }

  const cache = path.join(TAURI, '.cache');
  mkdirSync(cache, { recursive: true });
  const downloadName = path.basename(new URL(target.nodeUrl).pathname);
  const cached = path.join(cache, downloadName);

  if (!existsSync(cached) || readFileSync(cached).length < 1_000_000) {
    await download(target.nodeUrl, cached);
  }

  if (target.nodeKind === 'exe') {
    copyFileSync(cached, dest);
  } else {
    extractMember(cached, target.nodeMember, dest);
    chmodSync(dest, 0o755);
  }
  if (!existsSync(dest)) throw new Error(`Node 二进制没写到 ${dest}`);
  console.log(`▶ Node → ${dest}`);
}

async function stageApp(target, triple) {
  if (process.env.SKIP_WEB_BUILD !== '1') {
    console.log('▶ 构建前端 → server/public/');
    run('npm', ['run', 'build']);
  }
  if (!existsSync(path.join(ROOT, 'server/public/index.html'))) {
    throw new Error('构建没产出 server/public/index.html，中止');
  }

  const lock = readFileSync(path.join(ROOT, 'package-lock.json'));
  const stamp = sha256(Buffer.concat([
    lock,
    Buffer.from(`${triple}\n${target.os}\n${target.cpu}\n`),
  ]));
  const cacheDir = path.join(TAURI, '.cache', `npm-${triple}`);
  const stampFile = path.join(cacheDir, '.stamp');
  const needCi = !existsSync(path.join(cacheDir, 'node_modules'))
    || !existsSync(stampFile)
    || readFileSync(stampFile, 'utf8').trim() !== stamp;

  if (needCi) {
    console.log(`▶ 交叉安装运行时依赖（${target.os}-${target.cpu}）`);
    rmSync(cacheDir, { recursive: true, force: true });
    mkdirSync(cacheDir, { recursive: true });
    copyFileSync(path.join(ROOT, 'package.json'), path.join(cacheDir, 'package.json'));
    copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(cacheDir, 'package-lock.json'));
    const npmArgs = [
      'ci', '--omit=dev',
      '--os', target.os, '--cpu', target.cpu,
      '--no-audit', '--no-fund',
    ];
    run('npm', npmArgs, { cwd: cacheDir });
    writeFileSync(stampFile, stamp);
  } else {
    console.log(`▶ 复用缓存的 node_modules（${triple}）`);
  }

  const stage = path.join(TAURI, '.cache', `stage-${triple}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  copyFileSync(path.join(ROOT, 'package.json'), path.join(stage, 'package.json'));
  cpSync(path.join(cacheDir, 'node_modules'), path.join(stage, 'node_modules'), { recursive: true });
  cpSync(path.join(ROOT, 'server'), path.join(stage, 'server'), { recursive: true });
  cpSync(path.join(ROOT, 'shared'), path.join(stage, 'shared'), { recursive: true });
  removeTests(path.join(stage, 'server'));
  assertSharp(stage, target.os, target.cpu);

  const tarPath = path.join(TAURI, 'resources', 'app.tar.gz');
  mkdirSync(path.dirname(tarPath), { recursive: true });
  console.log('▶ 打包 app.tar.gz');
  run('tar', ['-czf', tarPath, '-C', stage, '.']);
  console.log(`✓ ${tarPath}`);
}

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const target = TARGETS[triple];
if (!target) {
  throw new Error(`没有为 ${triple} 配置桌面运行时。支持：${Object.keys(TARGETS).join(', ')}`);
}

const sidecarOnly = process.argv.includes('--sidecar-only')
  || process.env.PHOTOCULL_SIDECAR_ONLY === '1';

console.log(`PhotoCull desktop stage  (${triple})`);
if (sidecarOnly) {
  await stageNode(target, triple);
} else {
  await stageApp(target, triple);
  await stageNode(target, triple);
}
console.log('✓ 桌面运行时已就绪');
