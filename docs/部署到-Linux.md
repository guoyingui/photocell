# 把 PhotoCull 部署到 Linux 服务器

PhotoCull 原本是一个**桌面单机程序**：默认只监听 `127.0.0.1`，靠「请求来自回环地址」
来判定你是摄影师本人，启动时还会自动弹一个浏览器。把它搬到一台没有显示器、
要从外面访问的 Linux 机器上，这三条假设**每一条都会出问题**。

这份手册按「会踩到的顺序」排列。**第 0 节是硬阻断，不处理的话服务根本起不来**，
请不要跳过。

---

## 0. 一个必须先处理的硬阻断：无头机器上进程会自杀

`server/index.js` 的启动收尾是这一句（约第 402 行）：

```js
await open(url);
```

它在 ESM 顶层 `await`，**没有 `catch`**。而 `open` 这个包在失败时是会 reject 的
（`node_modules/open/index.js` 里 `reject(new Error(\`Exited with code ${exitCode}\`))`）。
服务器上没有桌面环境、没有 `$DISPLAY`、没有浏览器，`xdg-open` 必然非零退出。

顶层 await 的 rejection 会直接终结模块求值，**Node 以退出码 1 结束进程**。实测：

```
[1] 服务已监听，横幅在这里打印
Error: Exited with code 3
---- 退出码: 1 ----
```

注意崩溃发生在 `listen` **之后**：日志里会看到完整的启动横幅，端口甚至短暂可连，
然后进程就没了。配上 systemd 的 `Restart=always` 就是一个每几秒重启一次的崩溃循环，
而横幅每次都打印得好好的 —— 这是最容易把人骗进死胡同的一种失败。

### 为什么不能靠「在 PATH 里放个假的 xdg-open」绕过

`open` 在 Linux 上优先用**自己包里那份** `node_modules/open/xdg-open`（绝对路径调用），
只有当它不存在或不可执行时才回退到系统的 `xdg-open`。所以往 `PATH` 里塞一个假的
拦不住它。硬要绕，得先 `chmod -x node_modules/open/xdg-open` 再放假的 —— 而
`npm install` 会把它还原，等于埋了个定时炸弹。

### 推荐做法：改一行代码

```js
await open(url).catch(() => {});
```

自动弹浏览器本来就是桌面场景的便利功能，服务器上它失败是**正常**的，
不该让整个服务陪葬。改完之后无头启动就一切正常。

> 这一行还没有进仓库。部署前请先在你的分支上改掉，或者让我改。

---

## 1. 先决条件

**Node：22.12+ 最省事**（仓库在 v22.22 上开发）。硬下限是 vite 8 与 vitest 4 两方
`engines` 的交集：`20.19+`、`22.12+` 或 `24+`。**21.x 和 23.x 这两条奇数线不在任何一方
声明的范围里**，别用。`package.json` 自己没有 `engines` 字段，npm 不会拦你，
装得上不等于跑得动。

Debian / Ubuntu 上装 Node 22：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
```

`sharp` 会拉平台相关的预编译二进制，不需要你自己装 libvips。

建一个专用账号跑它（**不要用 root**，理由见第 3 节）：

```bash
sudo useradd -m -s /bin/bash photocull
```

---

## 2. 取代码、装依赖

**不要把开发机上的 `node_modules/` 打包传上去。** `sharp` 的二进制是按平台分发的，
本仓库当前这台 Mac 上装出来的是：

```
node_modules/@img/sharp-darwin-arm64
node_modules/@img/sharp-libvips-darwin-arm64
```

传到 x64 的 Linux 上，缩略图会在运行时炸。必须在**目标机器上**装，或者用交叉安装：

```bash
sudo -u photocull -i
git clone <你的仓库地址> ~/photocull && cd ~/photocull
npm ci                      # 目标机器上直接装，最稳
```

如果确实要在 Mac 上打包再传（就像之前 `deploy/photocull-linux-x64.tar.gz` 那样），
`sharp` 必须显式指定目标平台：

```bash
npm install --os=linux --cpu=x64 --libc=glibc sharp
```

Alpine 之类的 musl 系统把 `--libc=glibc` 换成 `--libc=musl`。

**部署路径建议全用 ASCII。** 本仓库目录名是中文（「选图程序」），历史上因此踩过一个
`import.meta.url` 与 `process.argv[1]` 永不相等、导致 `node server/index.js`
**静默退出 0、不监听不报错**的坑（`server/index.js` 第 384 行附近有完整记录）。
现在已经用 `pathToFileURL` 修好了，但路径里带非 ASCII 依然是没必要的风险面。

---

## 3. 照片放哪：这条限制很容易踩

服务端**不允许浏览任意路径**。`browseRoots()`（`server/lib/session.js:149`）在 Linux 上
只放行三类根：

| 根 | 说明 |
|---|---|
| `$HOME` | 跑服务那个账号的家目录 |
| `/media/*` | 挂载点 |
| `/mnt/*` | 挂载点 |

`/tmp` **只在 `NODE_ENV=test` 下放行**，生产环境刻意排除 —— Linux 上 `/tmp` 是本机
所有账号共享的。

所以把照片放在 `/srv/photos`、`/data/photos`、`/opt/...` 这类地方，**在选择器里根本看不见**。
放在下面任一处：

```bash
/home/photocull/照片/2026-05-林先生婚礼/     # $HOME 下
/mnt/photos/2026-05-林先生婚礼/              # 挂载点下
```

这条限制也是为什么**别用 root 跑**：root 的 `$HOME` 是 `/root`，等于把服务的可浏览
范围挂在一个本不该被 web 进程翻的目录上。

---

## 4. 构建

```bash
cd ~/photocull
npm run build     # vite build → 产物进 server/public/
```

`server/index.js` 只负责把 `server/public/` 里**已经构建好的**东西发出去，它不会自己编。
**每次更新代码都要重跑一次 `npm run build`。**

`npm start` 是 `npm run build && node server/index.js` 两步合一 —— 在 systemd 里
**不要**用它（每次重启都重新构建一遍，慢且没必要），拆开：构建在部署时做一次，
服务只跑 `node server/index.js`。

---

## 5. 选一种启动形态

这一步决定了后面所有的安全配置，先想清楚。

### 形态 A：只给自己用，走 SSH 隧道（最安全，推荐）

服务保持默认 —— 只监听 `127.0.0.1`，谁也连不上。你从自己电脑上打隧道：

```bash
ssh -N -L 5183:127.0.0.1:5183 photocull@你的服务器
```

然后在本地浏览器开 `http://127.0.0.1:5183`。对服务端来说请求就是回环，
**你自动就是管理员**，不需要任何令牌。启动参数：什么都不加。

### 形态 B：要把选片链接发给客户

必须 `--share`（这会把监听地址换成 `0.0.0.0`），**并且必须同时配 `--admin-token`**：

```bash
node server/index.js --share --admin-token=<一串长随机字符串>
```

生成令牌：

```bash
openssl rand -hex 32
```

配上 `--admin-token` 之后，**回环本身不再算管理员**（这是替代，不是叠加）。
你自己也要走一次登录入口：

```
http://<服务器地址>:5183/admin-login?token=<你的令牌>
```

校验通过后服务端种一枚 `HttpOnly; SameSite=Lax` 的 Cookie 再 302 跳回首页，
**令牌不会留在地址栏里**。Cookie 不设过期，浏览器关掉就没了；进程重启换新令牌，
旧 Cookie 自然失效。

**这条 URL 等同于管理员密码。** 别截图、别贴聊天窗、别存书签。它走 HTTP 明文，
同网段可以抓包，也可能进反向代理的访问日志。

---

## 6. systemd 服务

`/etc/systemd/system/photocull.service`：

```ini
[Unit]
Description=PhotoCull 选片服务
After=network.target

[Service]
Type=simple
User=photocull
WorkingDirectory=/home/photocull/photocull
ExecStart=/usr/bin/node server/index.js --share
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

令牌**不要写进这个文件**（`/etc/systemd/system/` 默认全局可读）。用一个 `0600`
的环境文件：

```bash
sudo install -m 600 -o root -g root /dev/null /etc/photocull.env
echo "PHOTOCULL_ADMIN_TOKEN=$(openssl rand -hex 32)" | sudo tee /etc/photocull.env >/dev/null
```

然后在 unit 里：

```ini
EnvironmentFile=/etc/photocull.env
ExecStart=/bin/sh -c '/usr/bin/node server/index.js --share --admin-token="$PHOTOCULL_ADMIN_TOKEN"'
```

> 用 `/bin/sh -c` 是因为 systemd 的 `ExecStart` 不做变量展开。
> 代价是令牌会短暂出现在该进程的命令行里（`ps` 可见）—— 单租户机器上可以接受，
> 多人共用的机器请改用形态 A。

启用：

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now photocull
sudo journalctl -u photocull -f
```

### 端口会漂移，这点要留神

服务监听 **5183**，被占用就**依次往后试到 5199**，全占满才报错退出。
在 systemd 下这会咬人：某个残留进程还占着 5183 时，新实例静悄悄绑到 5184，
而你的 nginx 还指着 5183。启动后确认一下实际端口：

```bash
sudo ss -lntp | grep node
```

日志横幅里也写了真实端口，以它为准。

---

## 7. 反向代理：这一节是整篇最要紧的

**同机反代 + 不配 `--admin-token` = 每一个访客都是管理员。**

原因：nginx 反代 `localhost` 时，转发过去的每一个请求源地址都是 `127.0.0.1`，
而 PhotoCull 的默认规则是「回环即管理员」。攻击面不是抽象的 —— 管理员能浏览
你的整块硬盘、能触发导出、能在移动模式下删你的 RAW。

现有两条防护（`server/lib/actor.js`）：

1. 配了 `--admin-token` 之后，**回环本身不再算管理员**，只有带对令牌的才算。
2. 请求带任何转发头（`X-Forwarded-For` / `X-Real-IP` / `Forwarded`）时，一律不给回环管理员身份。
   nginx / Caddy / Traefik 的默认配置都会加这些头。

但第 2 条**靠的是代理的自觉**。一个被显式配成不加任何转发头的同机代理，转发进来的
请求跟你本机点开的没有任何区别，两条防护都看不出来。

**所以：要用反向代理，`--admin-token` 是必须项，不是可选项。**
（代理在**另一台**机器上时方向正好相反 —— 所有请求都不是回环，管理员判定整个失效，
同样必须靠 `--admin-token` 才管得了。）

```nginx
server {
    listen 443 ssl;
    server_name pick.example.com;

    ssl_certificate     /etc/letsencrypt/live/pick.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pick.example.com/privkey.pem;

    # 原图和导出包都可能很大
    client_max_body_size 0;
    proxy_read_timeout 3600s;

    location / {
        proxy_pass http://127.0.0.1:5183;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE：实时进度和别人的标记全走这条流，缓冲一开就全卡住
        proxy_buffering off;
        proxy_cache off;
    }
}
```

`proxy_buffering off` 不是可选优化 —— 扫描进度、烘焙进度、其他人的选片标记
全靠 SSE 推送，开着缓冲整条流会被攒住。

**上了 nginx 就务必配 HTTPS。** 分享链接令牌和管理员令牌都在 URL 里传一次，
明文 HTTP 等于把它们摊开在链路上。

---

## 8. 数据在哪、备份什么

两处，都要备：

**选片结果** —— 跟着照片走，在每个照片文件夹里的 `marks.json`。
把照片文件夹备走就带上了。

**协同数据** —— 在服务账号的家目录：

```
~/.photocull/
├── shares.json                 全部分享的索引（含链接令牌）
└── shares/<shareId>/
    ├── users.json              这条分享下的用户（含用户令牌）
    ├── events.jsonl            审计日志，只追加
    └── events.1.jsonl          轮转出来的旧日志，最多留 3 代
```

这个目录和它下面的内容**权限是 `0700`**（mkdir 之后还会再 chmod 一次，免得被 umask 削掉）——
`shares.json` 和 `users.json` 里的令牌等价于密码。**备份时注意别把权限放宽**，
也别把它们塞进跟着交付物一起发出去的包里。

日志单文件超 16 MB 轮转，保留 3 代。

---

## 9. 升级

```bash
sudo systemctl stop photocull
sudo -u photocull -i
cd ~/photocull && git pull
npm ci && npm run build
exit
sudo systemctl start photocull
```

`npm ci` 之后**如果你之前改过第 0 节那一行，记得确认它还在**（`git pull` 会带上
你的提交，但如果当初是直接改的工作区没提交，就没了）。

---

## 10. 起不来时按这个顺序查

| 症状 | 多半是 |
|---|---|
| 横幅打印完进程就退出，退出码 1 | 第 0 节的 `open()`。日志里找 `Exited with code` |
| `node server/index.js` 静默退出 0，什么都不打印 | 路径里有非 ASCII（见第 2 节末尾） |
| 端口连不上，但服务在跑 | 没加 `--share`，还绑在 `127.0.0.1` |
| nginx 502 | 端口漂移了，`ss -lntp` 看真实端口 |
| 进度条不动、别人的标记不出现 | nginx 没关 `proxy_buffering` |
| 选择器里找不到照片文件夹 | 不在 `$HOME` / `/media` / `/mnt` 下（第 3 节） |
| 缩略图全炸 | `node_modules` 是从别的平台拷来的，`sharp` 二进制不对 |
| 客户能看到管理员功能 | 同机反代没配 `--admin-token`（第 7 节） |

日志：

```bash
sudo journalctl -u photocull -n 200 --no-pager
```
