# deploy/

把 PhotoCull 打成一个自带依赖的包，扔到 Linux x64 服务器上跑起来。

完整的部署说明、安全要害和排错清单在 [`../docs/部署到-Linux.md`](../docs/部署到-Linux.md)。
这里只讲这几个文件怎么用。

| 文件 | 在哪跑 | 干什么 |
|---|---|---|
| `build-linux.sh` | 开发机 | 打包 → `deploy/dist/photocull-linux-x64.tar.gz` |
| `../scripts/build-desktop.sh` | macOS 开发机 | 打 macOS `.dmg` 和 Windows NSIS `.exe` 到 `deploy/dist/` |
| `install.sh` | 服务器 | 解开的包装成 systemd 服务；重复跑 = 升级 |
| `photocull.service` | — | systemd unit 模板（`@USER@` / `@DIR@` 由 install.sh 替换） |
| `nginx.conf.example` | — | 反向代理示例，**用之前先看里面的警告** |

## 一次完整的部署

```bash
# 开发机
./deploy/build-linux.sh
scp deploy/dist/photocull-linux-x64.tar.gz photocull@你的服务器:~/

# 服务器
tar -xzf ~/photocull-linux-x64.tar.gz
sudo ~/photocull-linux-x64/install.sh
```

`install.sh` 跑完会打印实际端口和一条管理员登录 URL。**那条 URL 等同于密码，用完就丢。**

## 升级

同样两步，`install.sh` 是幂等的：它会保留 `/etc/photocull.env` 里已有的令牌
（重新生成的话，你手机上那枚管理员 Cookie 会当场失效），也不动服务账号家目录下的
`~/.photocull/`（分享索引、用户表、审计日志）。

## 为什么包里带 node_modules

`sharp` 的二进制按平台分发。开发机上装出来的是 `darwin-arm64`，直接拷到 x64 Linux
上缩略图会在运行时炸。`build-linux.sh` 用 npm 的 `--os/--cpu/--libc` 交叉装一份
`linux-x64` 的，并且在打包前**校验**包里只有 linux 二进制、没有混进 darwin 的——
装错平台会当场中止，不会等到服务器上才发现。

代价是包有 11 MB 左右，好处是服务器上不需要联网装依赖。

ARM 服务器：`ARCH=arm64 ./deploy/build-linux.sh`
Alpine 之类的 musl 系统：`LIBC=musl ./deploy/build-linux.sh`

## 三条最容易踩的

1. **照片必须放在服务账号的家目录、`/mnt` 或 `/media` 下。** 其它路径在选择器里
   根本看不见（`server/lib/session.js` 的 `browseRoots()` 只放行这三类根，
   `/tmp` 仅在测试环境放行）。
2. **端口会漂移。** 5183 被占就依次往后试到 5199。装完用 `sudo ss -lntp | grep node`
   确认真实端口再去配 nginx。
3. **同机反向代理不配 `--admin-token` = 每个访客都是管理员。** unit 模板里已经带上了，
   别删。理由见 `nginx.conf.example` 顶部和 `server/lib/actor.js`。
