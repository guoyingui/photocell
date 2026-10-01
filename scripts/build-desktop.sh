#!/usr/bin/env bash
#
# 打桌面安装包。在仓库根目录跑：
#
#     ./scripts/build-desktop.sh          # 本机 macOS + 交叉编译 Windows
#     ./scripts/build-desktop.sh mac      # 只打 macOS .dmg
#     ./scripts/build-desktop.sh win      # 只打 Windows NSIS（本机是 Mac 时走 cargo-xwin）
#
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
DIST="$ROOT/deploy/dist"
mkdir -p "$DIST"

# rustup 装在 ~/.cargo，非交互 shell 里 PATH 常常没有它
if [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
# cargo-xwin 交叉编译 Windows 时要用到 clang-cl
if [[ -d /opt/homebrew/opt/llvm/bin ]]; then
  export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
fi

if ! command -v cargo >/dev/null; then
  echo "✗ 找不到 cargo。先装 Rust：https://rustup.rs/" >&2
  exit 1
fi

copy_glob() {
  local glob="$1"
  shopt -s nullglob
  local files=( $glob )
  shopt -u nullglob
  if [[ ${#files[@]} -eq 0 ]]; then
    echo "✗ 没有找到 $glob" >&2
    return 1
  fi
  cp -R -v "${files[@]}" "$DIST/"
}

build_mac() {
  echo "════════ macOS ════════"
  npx tauri build --bundles dmg,app
  copy_glob "src-tauri/target/release/bundle/dmg/*.dmg"
  copy_glob "src-tauri/target/release/bundle/macos/*.app" || true
}

build_win() {
  echo "════════ Windows (NSIS) ════════"
  if [[ "$(uname -s)" == "Darwin" || "$(uname -s)" == "Linux" ]]; then
    if ! command -v cargo-xwin >/dev/null; then
      echo "▶ 安装 cargo-xwin"
      cargo install --locked cargo-xwin
    fi
    rustup target add x86_64-pc-windows-msvc
    if ! command -v makensis >/dev/null; then
      if command -v brew >/dev/null; then
        echo "▶ 安装 nsis"
        brew install nsis
      else
        echo "✗ 交叉编译 Windows 安装包需要 nsis（makensis）" >&2
        exit 1
      fi
    fi
    npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
    copy_glob "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe"
  else
    npx tauri build --bundles nsis
    copy_glob "src-tauri/target/release/bundle/nsis/*.exe"
  fi
}

TARGET="${1:-all}"
case "$TARGET" in
  mac) build_mac ;;
  win) build_win ;;
  all)
    build_mac
    build_win
    ;;
  *)
    echo "用法: $0 [mac|win|all]" >&2
    exit 2
    ;;
esac

echo
echo "✓ 安装包在 $DIST/"
ls -lh "$DIST" | sed -n '1,20p'
