#!/usr/bin/env bash
#
# 在**服务器上**跑，把解开的包装成一个 systemd 服务。
#
#     tar -xzf photocull-linux-x64.tar.gz
#     sudo ./photocull-linux-x64/install.sh
#
# 幂等：重复跑等于升级，会保留已有的令牌和 ~/.photocull/ 数据。
#
set -euo pipefail

SERVICE_USER="${SERVICE_USER:-photocull}"
INSTALL_DIR="${INSTALL_DIR:-/opt/photocull}"
ENV_FILE="/etc/photocull.env"
UNIT="/etc/systemd/system/photocull.service"
SRC="$(cd "$(dirname "$0")" && pwd)"

[[ $EUID -eq 0 ]] || { echo "✗ 请用 sudo 跑" >&2; exit 1; }
command -v node >/dev/null || { echo "✗ 没装 node，先装 Node 22.12+" >&2; exit 1; }

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
# 硬下限是 vite 8 与 vitest 4 两方 engines 的交集：20.19+ / 22.12+ / 24+。
# 21.x 和 23.x 这两条奇数线不在任何一方声明的范围里。
ok=0
case "$NODE_MAJOR" in
  20) [[ $NODE_MINOR -ge 19 ]] && ok=1 ;;
  22) [[ $NODE_MINOR -ge 12 ]] && ok=1 ;;
  24|25|26) ok=1 ;;
esac
if [[ $ok -eq 0 ]]; then
  echo "✗ Node $(node -v) 不在支持范围内（需 20.19+ / 22.12+ / 24+，21.x 和 23.x 不行）" >&2
  exit 1
fi

echo "▶ 服务账号 $SERVICE_USER"
id -u "$SERVICE_USER" &>/dev/null || useradd -m -s /bin/bash "$SERVICE_USER"

echo "▶ 安装到 $INSTALL_DIR"
systemctl stop photocull 2>/dev/null || true
mkdir -p "$INSTALL_DIR"
# 用 rsync --delete 而不是 cp：升级时要把上一版多出来的文件清掉，
# 否则删掉的模块会以"孤儿文件"的形式一直留在服务器上。
if command -v rsync >/dev/null; then
  rsync -a --delete --exclude install.sh "$SRC"/ "$INSTALL_DIR"/
else
  rm -rf "$INSTALL_DIR"/{server,node_modules}
  cp -R "$SRC"/. "$INSTALL_DIR"/ && rm -f "$INSTALL_DIR/install.sh"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# 令牌只生成一次。重装/升级时保留原来的——重新生成的话，你手机上那枚
# 管理员 Cookie 会当场失效，还得再走一遍 /admin-login。
if [[ ! -f "$ENV_FILE" ]]; then
  echo "▶ 生成管理员令牌 → $ENV_FILE"
  install -m 600 -o root -g root /dev/null "$ENV_FILE"
  printf 'PHOTOCULL_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 32)" > "$ENV_FILE"
  NEW_TOKEN=1
else
  echo "▶ 沿用已有的 $ENV_FILE"
  NEW_TOKEN=0
fi
chmod 600 "$ENV_FILE"

echo "▶ 安装 systemd unit"
sed -e "s|@USER@|$SERVICE_USER|g" -e "s|@DIR@|$INSTALL_DIR|g" \
    "$SRC/photocull.service" > "$UNIT"
systemctl daemon-reload
systemctl enable photocull >/dev/null
systemctl start photocull

sleep 2
if ! systemctl is-active --quiet photocull; then
  echo
  echo "✗ 服务没起来。日志：" >&2
  journalctl -u photocull -n 30 --no-pager >&2
  exit 1
fi

# 端口会漂移：5183 被占就依次往后试到 5199。别假设它一定是 5183。
PORT=$(ss -lntp 2>/dev/null | grep -oP '127\.0\.0\.1:\K5(18[3-9]|19[0-9])' | head -1)
PORT="${PORT:-$(ss -lntp 2>/dev/null | grep -oP '0\.0\.0\.0:\K5(18[3-9]|19[0-9])' | head -1)}"

echo
echo "✓ 服务已启动"
echo "  实际端口：${PORT:-未探测到，用 'sudo ss -lntp | grep node' 自己看}"
echo "  日志：sudo journalctl -u photocull -f"
if [[ $NEW_TOKEN -eq 1 ]]; then
  echo
  echo "  管理员登录（这条 URL 等同于密码，用完就丢，别截图别贴聊天窗）："
  echo "      http://<服务器地址>:${PORT:-5183}/admin-login?token=$(grep -oP 'PHOTOCULL_ADMIN_TOKEN=\K.*' "$ENV_FILE")"
fi
echo
echo "  照片要放在 $(getent passwd "$SERVICE_USER" | cut -d: -f6) 下，或 /mnt、/media 下——"
echo "  其它路径在选择器里看不见（server/lib/session.js 的 browseRoots）。"
