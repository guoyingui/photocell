#!/usr/bin/env bash
#
# 在开发机（macOS / Linux 都行）上打出一个可以直接扔到 Linux x64 服务器上的包。
#
#     ./deploy/build-linux.sh
#     → deploy/dist/photocull-linux-x64.tar.gz
#
# 包里是自带 node_modules 的，服务器上不需要联网装依赖。这一点是刻意的：
# sharp 的二进制按平台分发，本机装出来的是 darwin-arm64，直接拷到 x64 Linux 上
# 缩略图会在运行时炸。所以这里用 npm 的 --os/--cpu/--libc 交叉装一份 linux-x64 的。
#
set -euo pipefail

ARCH="${ARCH:-x64}"
LIBC="${LIBC:-glibc}"          # Alpine 之类的 musl 系统：LIBC=musl ./deploy/build-linux.sh
NAME="photocull-linux-${ARCH}"

cd "$(dirname "$0")/.."
ROOT="$PWD"
DIST="$ROOT/deploy/dist"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

if [[ ! -f package.json || ! -d server ]]; then
  echo "✗ 不在仓库根目录，找不到 package.json / server/" >&2
  exit 1
fi

echo "▶ 1/4 构建前端 → server/public/"
npm run build

if [[ ! -f server/public/index.html ]]; then
  echo "✗ 构建没产出 server/public/index.html，中止" >&2
  exit 1
fi

echo "▶ 2/4 交叉安装运行时依赖（linux-${ARCH}/${LIBC}）"
APP="$STAGE/$NAME"
mkdir -p "$APP"
cp package.json package-lock.json "$APP/"
(cd "$APP" && npm ci --omit=dev --os=linux --cpu="$ARCH" --libc="$LIBC" --no-audit --no-fund)

# 装错平台的话这里就该拦住，别等到服务器上才发现
if ! ls "$APP/node_modules/@img/" | grep -q "sharp-linux-${ARCH}"; then
  echo "✗ sharp 的 linux-${ARCH} 二进制没装上，包是坏的：" >&2
  ls "$APP/node_modules/@img/" >&2
  exit 1
fi
if ls "$APP/node_modules/@img/" | grep -q darwin; then
  echo "✗ 包里混进了 darwin 二进制，中止" >&2
  exit 1
fi

echo "▶ 3/4 组装"
# server/ 整个进包，但把测试摘出去——它们要 devDependencies，服务器上跑不了也用不上
cp -R server "$APP/server"
cp -R shared "$APP/shared"
find "$APP/server" -name '*.test.js' -delete
cp deploy/photocull.service deploy/install.sh deploy/nginx.conf.example "$APP/"
chmod +x "$APP/install.sh"
[[ -f README.md ]] && cp README.md "$APP/"
if [[ -f "docs/部署到-Linux.md" ]]; then
  mkdir -p "$APP/docs" && cp "docs/部署到-Linux.md" "$APP/docs/"
fi

# package.json 必须进包：没有它 "type": "module" 就没了，整个服务端起不来
[[ -f "$APP/package.json" ]] || { echo "✗ package.json 丢了" >&2; exit 1; }

{
  git rev-parse --short HEAD 2>/dev/null || echo unknown
  date -u +'%Y-%m-%dT%H:%M:%SZ'
} > "$APP/BUILD_REV"

echo "▶ 4/4 打包"
mkdir -p "$DIST"
tar -czf "$DIST/$NAME.tar.gz" -C "$STAGE" "$NAME"

SIZE=$(du -h "$DIST/$NAME.tar.gz" | cut -f1)
echo
echo "✓ $DIST/$NAME.tar.gz  ($SIZE)"
echo
echo "下一步，把它传上去："
echo "    scp $DIST/$NAME.tar.gz photocull@你的服务器:~/"
echo "    ssh photocull@你的服务器 'tar -xzf ~/$NAME.tar.gz && sudo ~/$NAME/install.sh'"
