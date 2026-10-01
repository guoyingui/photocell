# PhotoCull 协同选片实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让摄影师把当前选片会话生成一条分享链接，客户凭昵称免密进入、多人实时协同标记，
每个账户的操作全程留痕，管理员可按链接和用户做权限与生命周期管理。

**Architecture:** 在既有的"按 root 唯一的库会话 + SSE 事件总线"之上加一层身份与授权：
本地回环请求是管理员，远端凭分享令牌下发的用户令牌是访客。分享/用户/审计日志存在
服务端级的 `~/.photocull/`，不进照片文件夹。实时同步复用现有 SSE（服务端→客户端）
加普通 HTTP 写请求（客户端→服务端），不引入 WebSocket。

**Tech Stack:** Node 22 ESM + Express 5、Vite 6 + React 19 + TypeScript + zustand、
vitest（本计划新增 jsdom + @testing-library/react）。无新增运行时依赖，
令牌用 `node:crypto`，Cookie 手写解析/设置（不引入 cookie-parser）。

**规格：** `docs/superpowers/specs/2026-07-27-collaborative-culling-design.md`。
规格与本计划冲突时以规格为准，并向人类伙伴报告。

---

## 关于本计划的写法（实现者请先读这一段）

上一阶段的计划为 18 个任务全部手写了完整的参考实现。结果是 **18 个模块里有 16 个
的参考实现带着真实缺陷**（只有 `meta` 和 `bursts` 两个纯函数模块一次过），
全部由审查环节抓出来。结论很清楚：计划作者没运行过的代码，并不比实现者写完就跑测试的代码更可信；
而实现者会**照抄**参考实现，于是缺陷直接进仓库。

所以本计划**刻意不再逐行给出实现**。它给的是：

- **精确的接口**（函数名、参数、返回值形状、错误码字面量）——这些必须逐字照用，
  因为别的任务按它们编码，对不上就是接缝 bug。
- **精确的取值**（令牌长度、HTTP 状态码、Cookie 属性、错误码字符串、文案）。
- **必须先变红的测试**——多数情况下测试代码是给全的，因为"测什么"比"怎么实现"更难对齐，
  而这个项目反复栽在"测试通过但测的是别的东西"上。
- **字面代码只出现在形式本身就是要求的地方**：安全判定式、原子写的顺序、
  正则、以及若干条解释"为什么不能换个写法"的注释。

其余部分由你实现。**你被期望自己写实现并自己证伪，而不是转写。**
如果你觉得某处的说明含糊到无法实现，停下来报 `NEEDS_CONTEXT`——
不要猜，也不要"顺手补全"。本项目有过一次因为静默补全残缺说明而引入真实 bug 的记录。

---

## Global Constraints

以下每一条都隐含在每个任务的需求里。

**安全（与规格 §9 一一对应，任何便利性设计一律让路）**

- **默认只监听 `127.0.0.1`。** 只有显式 `npm start -- --share` 才绑定 `0.0.0.0`。
- **管理员判定只看 TCP 源地址，绝不读 `X-Forwarded-For`。**
  判定式固定为：`ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'`。
- **访客永远不能导出。** `/api/export*` 硬编码仅管理员，不是可配置开关。
- **访客永远不能访问 `/api/fs/*`、`/api/library/open`、`/api/library/close`、
  `/api/library/prioritize`、`/api/library/settings`、`/api/admin/*`。**
- **默认拒绝**：解析不出 actor 的请求一律 401，白名单**四项**：
  静态资源、`GET /api/share/:token/info`、`POST /api/share/:token/join`、
  `POST /api/share/:token/resume`。

  > `resume` 是协调者在 Task 6 之后补进来的，原文只列了三项。
  > Task 6 的实现者如实报告了这个冲突而没有擅自加第四项，是对的：
  > 令牌**有效**的回访者本来就被 `resolveActor` 解析成 `user`、根本走不到默认拒绝；
  > 白名单只对令牌**失效**的回访者起作用。而那正是必须让请求进到处理函数的情形——
  > 只有处理函数才会回 401 `need-join` 并**清掉那枚死 Cookie**。
  > 挡在外面的话浏览器会一直带着那枚死 Cookie 重试，用户卡在一个没有出口的循环里。
  > 安全代价为零：无身份访问 `resume` 只会读一下 Cookie 然后 401，不泄露任何东西，
  > 且同样受限流约束。
  >
  > 后来又补了**第五项**：`GET /admin-login`（`--admin-token` 的浏览器登录入口，
  > 见上面那条例外）。理由同构——走这条路的人正是**还没有管理员身份**的那个浏览器，
  > 挡在默认拒绝外面等于这条入口不存在。它自己的失败一律 404 且三种失败逐字节一致，
  > 不泄露开关有没有开。
  >
  > 老实记一笔：这一项今天是**冗余**的，`defaultDeny` 里"非 `/api` 一律放行"那条
  > 已经放行了它，把这一项删掉不会有任何测试变红。写进白名单是因为"哪些路径无身份
  > 可达"这个问题应该在那张表里有答案——"非 `/api` 一律放行"哪天被收紧时，
  > 一个进不去的登录入口不会响亮地失败，只会表现成摄影师突然打不开自己的界面。
- **令牌绝不出现在审计日志、错误响应或终端输出里**，**除了启动横幅里那条一次性的
  管理员登录 URL**（`http://<地址>:<端口>/admin-login?token=…`）。日志只记 `shareId` / `userId`。

  > 这条例外是协调者在安全修复评审之后追加的，理由是**不开这个例外，
  > `--admin-token` 就是一个任何浏览器都用不了的开关**：浏览器没有办法给导航请求
  > 加自定义请求头，`X-PhotoCull-Admin` 对地址栏、链接、二维码一概挂不上；
  > 而"配了 `--admin-token` 就只认令牌"那条否决同时把回环也关掉了，
  > 于是摄影师连自己本机的界面都是满屏 403，规格 §9.3 写的"从其他电脑管理"更无从谈起。
  > 令牌是摄影师自己敲进命令行的，回显那一条**可用的入口**给他是有新用处的——
  > 这正是原来那条禁令成立的前提（"回显给他没有任何新用处"）在这里不成立的地方。
  >
  > 例外的边界写死在用例里（`server/index.test.js`）：断言的不是"令牌不出现"，
  > 而是**令牌每一次出现都紧跟在 `/admin-login?token=` 后面**。横幅里除这条 URL
  > 之外的每一个字、审计日志、错误响应，仍然一律不含令牌。横幅本身也必须写明
  > 这条 URL 等同于管理员密码、用完就丢。
- **无效链接一律 404，且文案与"不存在"完全一致**（不区分过期/撤销/不存在）。
- 令牌 = `crypto.randomBytes(32)` 的 base64url（43 字符）。
- 所有写请求必须带 `X-PhotoCull-Session` 头（CSRF 第二道防线）；
  用户 Cookie 为 `HttpOnly; SameSite=Lax; Path=/`。
- `~/.photocull/` 及其内容创建时权限 `0700`。

**兼容**

- `marks.json` 的 `marks` 字段结构 **不变**（`Record<id, 'pick'|'reject'>`）。
  归属信息放在平行的 `marksMeta` 表；旧文件没有该字段时按空表处理，不报错。
- 现有单机流程（不开分享时）行为不得改变：不需要 Cookie、不需要昵称、
  所有既有快捷键和面板照旧。

**工程**

- Express 5 的通配路由语法是 `/*splat`，**不是** `'*'`。
- `server/bootstrap-threadpool.js` 必须保持是 `server/index.js` 的**第一个静态 import**
  （ESM 先求值全部 import 再执行本模块顶层代码，抄到 index.js 顶部反而更晚）。
- TypeScript 开着 `noUnusedLocals`。
- 前端不引入路由库；三条路径读 `location.pathname` 判定。
- 原子写一律沿用既有 `store.js` 的 临时文件 → fsync → rename，失败回退 `.bak`。
- **`shares.json` / `users.json` 的每一次「读 → 改 → 写」必须整体串行化**
  （`jsonstore.js` 提供按文件路径的进程内互斥，调用方把整个读改写包进去）。
  只让 `writeJson` 原子是不够的：两个访客同时点同一条链接建号时，
  两边都读到同一份 users.json、都通过昵称唯一性检查、都写回——
  后写的覆盖先写的，**一个用户记录凭空消失**，那个人手里的令牌解析不出用户，
  下一次请求就被弹回昵称表单。昵称相同时更糟：唯一性检查形同虚设。
  「摄影师把链接发给一对新人，两个人同时点开」正是这条路径的典型触发方式。
- **不要在 `web/` 目录里跑 `vite build`**（会产出游离的 `web/dist/`）。
  构建产物目标是 `server/public/`，在仓库根执行。
- **每条修复/功能都要有一个你亲眼见过它失败的测试。** 写完先破坏实现确认变红，
  再改回来确认变绿。没见过红的测试不是证据——本项目有过一个测试在被测机制
  被整个注释掉之后仍然全绿的记录。

**不做**

- 不做实时光标/选区同步。
- 不做按用户分层的标记（协同 = 一起做出一份结果）。
- 不内置公网暴露、隧道或 TLS。
- 不做密码登录、不做邮箱验证、不做找回。

---

## File Structure

### 新增 —— 服务端

| 文件 | 职责 |
|---|---|
| `server/lib/appdir.js` | `~/.photocull/` 的定位与 0700 创建；测试可覆盖根目录 |
| `server/lib/jsonstore.js` | 通用原子 JSON 读写（临时文件→fsync→rename + `.bak` 回退） |
| `server/lib/tokens.js` | 令牌生成、`redactTokens()`（写日志前的最后一道闸） |
| `server/lib/shares.js` | 分享 CRUD、过期判定、token→share 反查索引 |
| `server/lib/users.js` | 按分享的用户表、昵称归一化与唯一性、角色、禁用 |
| `server/lib/audit.js` | 追加写 JSONL、轮转、查询过滤、CSV 导出 |
| `server/lib/actor.js` | 从请求解析 actor（admin / user / 无），纯函数 + 存储查询 |
| `server/lib/presence.js` | 由 SSE 监听者集合派生在线名单 |
| `server/lib/cookies.js` | 极小的 Cookie 解析与 Set-Cookie 构造 |
| `server/middleware/auth.js` | `resolveActor` / `requireAdmin` / `requirePerm` / 默认拒绝 |
| `server/middleware/ratelimit.js` | 按 IP 的失败计数闸门（join 用） |
| `server/routes/share.js` | `/api/share/:token/{info,join,resume}`、`/api/share/leave` |
| `server/routes/admin.js` | `/api/admin/shares…`、用户管理、审计日志与 CSV |
| `server/lib/netaddr.js` | 局域网地址探测（分享面板用） |

### 新增 —— 前端

| 文件 | 职责 |
|---|---|
| `web/src/routes.tsx` | 三入口分发：`/`、`/s/<token>`、`/admin` |
| `web/src/store/session.ts` | 当前 actor、角色、所属分享、在线名单 |
| `web/src/lib/realtime.ts` | SSE 事件路由 + 断线重连后的全量补拉 |
| `web/src/guest/JoinGate.tsx` | 昵称建号 / 回访恢复 / 各类拒绝文案 |
| `web/src/guest/GuestApp.tsx` | 访客选片界面（复用 Grid/Lightbox，去掉三块） |
| `web/src/components/PresenceBar.tsx` | 在线成员条 |
| `web/src/components/SharePanel.tsx` | 本地界面的分享管理 |
| `web/src/components/Blocker.tsx` | 阻断层（链接失效 / 被踢 / 会话结束） |
| `web/src/admin/AdminApp.tsx` | 管理后台外壳 |
| `web/src/admin/ShareList.tsx` | 分享列表与新建 |
| `web/src/admin/UserList.tsx` | 用户列表、角色切换、禁用/删除 |
| `web/src/admin/EventLog.tsx` | 审计日志表、过滤、CSV 下载 |
| `web/src/lib/avatar.ts` | 由 userId 稳定派生颜色与首字 |

### 修改

| 文件 | 改动 |
|---|---|
| `server/index.js` | 挂载新路由、默认拒绝中间件、SPA 兜底、`--share` 绑定 |
| `server/lib/session.js` | 分享钉住会话；listener 带 actor 供在线名单派生 |
| `server/lib/store.js` | `marksMeta` 平行表 |
| `server/lib/scan.js` 调用方 | 接上 `onBatch` → SSE `scan` 事件（I7） |
| `server/routes/{library,marks,image,export,fs}.js` | 接入权限中间件；标记写入广播与留痕 |
| `web/src/main.tsx` | 改为渲染 `routes.tsx` |
| `web/src/App.tsx` | 分享入口、在线成员条、扫描进度 |
| `web/src/store/marks.ts` | 远端广播合并（带未落地写的丢弃规则） |
| `web/src/lib/useKeyboard.ts` | `viewer` 角色短路 |
| `web/src/lib/api.ts` | SSE 重连回调；管理令牌头 |
| `vitest.config.js` | jsdom 环境、收 `.test.tsx` |
| `package.json` | jsdom / @testing-library 开发依赖；`--share` 说明 |
| `README.md` | 分享用法、安全告警、验收清单 |

---

## 任务总览

| # | 任务 | 依赖 | 交付物 |
|---|---|---|---|
| 1 | 组件测试环境 | — | jsdom 可用，补齐上一波 3 条无测试的修复 |
| 2 | 应用目录与原子 JSON 存储 | — | `appdir` / `jsonstore` / `tokens` |
| 3 | 分享存储 | 2 | `shares.js` + 过期与撤销语义 |
| 4 | 用户存储 | 2 | `users.js` + 昵称唯一性 |
| 5 | 审计日志 | 2 | `audit.js` + 令牌脱敏保证 + 轮转 |
| 6 | 身份与授权中间件 | 3,4 | `actor` / `auth` / `cookies` / `ratelimit` |
| 7 | 权限矩阵接线 | 6 | 既有路由全部收紧 + 全枚举矩阵测试 |
| 8 | 分享接入接口 | 6 | `/api/share/*` |
| 9 | 管理接口 | 5,6 | `/api/admin/*` |
| 10 | 标记归属与广播 | 7 | `marksMeta` + SSE `marks` + 留痕 |
| 11 | 在线状态 | 7 | SSE `presence` / `role` / `kicked` / `share-ended` |
| 12 | 扫描增量推送（I7） | 7 | 非阻塞开库 + SSE `scan` |
| 13 | 网络暴露与启动 | 7 | `--share`、LAN 探测、SPA 兜底、启动告警 |
| 14 | 前端路由与会话 store | 1 | `routes.tsx` / `store/session.ts` |
| 15 | 访客接入界面 | 8,14 | `JoinGate` + 各类拒绝文案 |
| 16 | 访客选片界面与只读门禁 | 15 | `GuestApp` + `useKeyboard` 短路 |
| 17 | 实时合并与阻断层 | 10,11,16 | `realtime.ts` / `PresenceBar` / `Blocker` |
| 18 | 分享面板 | 13,14 | `SharePanel` |
| 19 | 管理后台 | 9,14 | `AdminApp` 三栏 |
| 20 | 归属显示与扫描进度 | 10,12,17 | 色块角标 + 扫描进度条 |
| 21 | 文档与验收清单 | 全部 | README + 两份人工验收清单 |

**并行说明（给协调者）：** 2–5 文件互不相交，可并行。6 必须等 3、4。
7–13 都改 `server/` 的既有文件，串行。14–20 里 15/16/17 触碰同一批前端文件，串行；
18、19 文件独立，可与 15–17 并行。

---

## Task 1: 组件测试环境

**为什么排第一：** 访客的只读权限是一条**安全属性**。`P` / `X` 是键盘操作，
没有按钮可隐藏，所以"服务端 403"和"客户端 `useKeyboard` 里短路"两道防线都必须有测试。
当前 `vitest.config.js` 是 `environment: 'node'`、仓库没有 jsdom、
`include` 只收 `web/src/**/*.test.ts`（`.test.tsx` 连收都不会被收），
第二道防线根本没法测。

**Files:**
- Modify: `vitest.config.js`
- Modify: `package.json`
- Test: `web/src/components/ExportPanel.test.tsx`（新建）
- Test: `web/src/App.test.tsx`（新建）

**Interfaces:**
- Produces: 任何 `web/src/**/*.test.tsx` 都在 jsdom 环境下运行；
  `server/**/*.test.js` 仍在 node 环境下运行（**不能**让服务端测试跑进 jsdom）。

- [ ] **Step 1: 装开发依赖**

```bash
npm i -D jsdom@^26 @testing-library/react@^16 @testing-library/dom@^10 @testing-library/user-event@^14
```

- [ ] **Step 2: 改 vitest 配置**

关键点：服务端测试必须留在 node 环境。用 `environmentMatchGlobs` 按路径分派，
并把 `.test.tsx` 加进 `include`。

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.js', 'web/src/**/*.test.ts', 'web/src/**/*.test.tsx'],
    // 默认仍是 node：服务端测试要用真实 fs / net，跑进 jsdom 会出各种怪问题。
    // 只有前端的 .test.tsx 需要 DOM。
    environment: 'node',
    environmentMatchGlobs: [['web/src/**/*.test.tsx', 'jsdom']],
    testTimeout: 20000,
  },
});
```

- [ ] **Step 3: 写第一个会失败的组件测试（I16 —— move 确认框不得印出答案）**

`web/src/components/ExportPanel.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ExportPanel } from './ExportPanel';

// 规格 §8.3：move 确认是删除不可再生 RAW 之前唯一的人工闸门。
// 如果把要求输入的数字直接印在输入框旁边，它就退化成一次抄写练习。
describe('move 确认闸门', () => {
  it('确认对话框里不得出现待输入的那个数字', async () => {
    render(<ExportPanel open mode="move" fileCount={30} /* 其余 props 见组件签名 */ />);
    const dialog = await screen.findByRole('dialog', { name: /确认移动/ });
    expect(dialog.textContent).not.toMatch(/\b30\b/);
  });
});
```

> **给实现者：** `ExportPanel` 当前的 props 签名以源码为准。
> 如果它不接受这里写的这组 props、或者没有 `role="dialog"`，
> **不要改测试去迁就实现，也不要停下**——按最小改动给对话框加上可访问名
> （`role="dialog"` + `aria-label`），这是测试可达性的必要条件，不是过度设计。

- [ ] **Step 4: 跑它，确认因为"数字印在里面"而失败**

```bash
npx vitest run web/src/components/ExportPanel.test.tsx
```
预期：FAIL，`dialog.textContent` 里能匹配到 `30`。

- [ ] **Step 5: 改实现——数字挪出对话框**

把 `请输入待移动的文件数 <b>{fileCount}</b> 以确认` 改成不含数字的提示，
数字只在对话框**外面**的按钮上出现（`移动 30 个文件`）。
服务端的二次核对是真正的安全属性，这里只是人的减速带，别让它退化成装饰。

- [ ] **Step 6: 跑测试确认通过，再把改动回滚一次确认重新变红**

```bash
npx vitest run web/src/components/ExportPanel.test.tsx
```

- [ ] **Step 7: 补 ExportPanel 重开复位（分诊 k）**

```tsx
it('换过文件夹之后重开面板，不得闪现上一次的导出结果', async () => {
  const { rerender } = render(<ExportPanel open={false} /* … */ />);
  // 先制造一个 summary，再关闭、换 root、重开
  // 断言：重开后屏幕上没有上一次的 "已导出 N" 文案
});
```

- [ ] **Step 8: 补 move 进行中的 beforeunload 拦截（分诊 b 前端半边）**

断言：move 任务在跑时 `window.dispatchEvent(new Event('beforeunload'))`
会被 `preventDefault`；任务结束后不再拦截。

- [ ] **Step 9: 跑全量确认没有把服务端测试拖进 jsdom**

```bash
npx vitest run
```
预期：全绿，且服务端测试文件数与用例数**不减少**。

- [ ] **Step 10: 提交**

```bash
git add vitest.config.js package.json package-lock.json web/src/components/ExportPanel.tsx web/src/components/ExportPanel.test.tsx web/src/App.test.tsx
git commit -m "test: 引入 jsdom 组件测试环境，补齐上一波三条无测试的修复"
```

---

## Task 2: 应用目录与原子 JSON 存储

**Files:**
- Create: `server/lib/appdir.js`
- Create: `server/lib/jsonstore.js`
- Create: `server/lib/tokens.js`
- Test: `server/lib/jsonstore.test.js`、`server/lib/tokens.test.js`

**Interfaces:**
- Produces:
  - `appRoot(): string` —— `~/.photocull`，可被 `PHOTOCULL_HOME` 覆盖（测试用）
  - `ensureAppDir(sub?: string): Promise<string>` —— 递归创建，模式 `0o700`，返回绝对路径
  - `readJson(file, fallback): Promise<any>` —— 主文件坏了自动回退 `.bak`
  - `writeJson(file, data): Promise<void>` —— 临时文件 → fsync → rename，写前先把现有文件轮转成 `.bak`
  - `newToken(): string` —— 43 字符 base64url
  - `newId(prefix): string` —— 如 `sh_9f3a…` / `u_2c7b…`
  - `redactTokens(obj, tokens): any` —— 深拷贝并把任何等于给定令牌的字符串替换成 `'[redacted]'`

- [ ] **Step 1: 写 appdir 与 jsonstore 的失败测试**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJson } from './jsonstore.js';

let dir;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-json-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

it('写入是原子的：过程中不存在半截的目标文件', async () => {
  const file = path.join(dir, 'x.json');
  await writeJson(file, { a: 1 });
  // 目录里除了目标文件和 .bak，不得残留任何 .tmp
  const left = (await fs.readdir(dir)).filter((n) => n.includes('.tmp'));
  expect(left).toEqual([]);
});

it('主文件损坏时回退 .bak', async () => {
  const file = path.join(dir, 'x.json');
  await writeJson(file, { v: 1 });
  await writeJson(file, { v: 2 });          // v1 轮转进 .bak
  await fs.writeFile(file, '{ 这不是 JSON', 'utf8');
  expect(await readJson(file, null)).toEqual({ v: 1 });
});

it('主文件和 .bak 都坏时返回 fallback，而不是抛错', async () => {
  const file = path.join(dir, 'x.json');
  await fs.writeFile(file, 'x', 'utf8');
  await fs.writeFile(`${file}.bak`, 'y', 'utf8');
  expect(await readJson(file, { empty: true })).toEqual({ empty: true });
});

it('目录以 0700 创建', async () => {
  const p = await ensureAppDir('shares/sh_test');
  const st = await fs.stat(p);
  expect(st.mode & 0o777).toBe(0o700);   // 令牌等价于密码，别让同机其它账号读到
});

// ⚠️ 上面那条用例**不足以**守住 chmod —— 实现时已实测确认。
// umask 022 下 mkdir(mode: 0o700) 本来就得到 0700（没有 group/other 位可剥），
// 所以把 chmod 整行删掉，上面那条照样绿。必须再加下面这条：
it('重复调用会把已存在目录的权限收紧回 0700', async () => {
  const p = await ensureAppDir('shares/sh_test');
  await fs.chmod(p, 0o755);              // 模拟被别的东西放宽过
  await ensureAppDir('shares/sh_test');
  expect((await fs.stat(p)).mode & 0o777).toBe(0o700);
});
```

- [ ] **Step 2: 跑，确认全部因为模块不存在而失败**

- [ ] **Step 3: 实现 `appdir.js`**

```js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 测试用 PHOTOCULL_HOME 覆盖，避免把用例数据写进开发者真实的 ~/.photocull。
export function appRoot() {
  return process.env.PHOTOCULL_HOME || path.join(os.homedir(), '.photocull');
}

/**
 * 0o700 不是洁癖：这个目录里的分享令牌和用户令牌等价于密码，
 * 同一台机器上的其它账号不该读得到。
 * mkdir 的 mode 会被 umask 削减，所以创建后再 chmod 一次。
 */
export async function ensureAppDir(sub = '') {
  const dir = sub ? path.join(appRoot(), sub) : appRoot();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  return dir;
}
```

- [ ] **Step 4: 实现 `jsonstore.js`**

沿用 `server/lib/store.js` 已验证过的写法（临时文件 → `fsync` → `rename`）。
要点：`rename` 之前必须 `fsync` 文件句柄，否则崩溃后可能得到一个长度正确但内容为零的文件。

```js
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

export async function readJson(file, fallback) {
  for (const candidate of [file, `${file}.bak`]) {
    try {
      return JSON.parse(await fs.readFile(candidate, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') continue;   // 没有就试下一个
      // 存在但解析失败：继续退到 .bak。这正是 .bak 存在的理由。
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
    await handle.sync();          // rename 之前必须落盘
  } finally {
    await handle.close();
  }
  // 轮转：现有文件变成 .bak。第一次写时没有现有文件，忽略 ENOENT。
  try { await fs.rename(file, `${file}.bak`); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await fs.rename(tmp, file);
}
```

- [ ] **Step 5: 实现 `tokens.js`**

```js
import crypto from 'node:crypto';

/** 32 字节随机 → 43 字符 base64url。可猜性等同于一个 256 位密钥。 */
export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('base64url')}`;
}

/**
 * 写审计日志之前的最后一道闸。
 *
 * 令牌一旦进了 events.jsonl 就等于把密码写进了一个会被导出成 CSV、
 * 会被管理员在屏幕上打开、会被截图的地方。这个函数不追求聪明，
 * 只做一件事：深走一遍对象，把任何**等于**已知令牌的字符串替换掉。
 */
export function redactTokens(value, tokens) {
  const set = new Set([...tokens].filter((t) => typeof t === 'string' && t.length > 0));
  const walk = (v) => {
    if (typeof v === 'string') return set.has(v) ? '[redacted]' : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value);
}
```

- [ ] **Step 6: 跑测试确认全绿**

```bash
npx vitest run server/lib/jsonstore.test.js server/lib/tokens.test.js
```

- [ ] **Step 7: 突变验证**

把 `handle.sync()` 删掉、把 `readJson` 的 `.bak` 回退删掉、把 `chmod` 删掉，
各跑一次确认对应用例变红，然后全部还原。**没见过红的测试不是证据。**

- [ ] **Step 8: 提交**

```bash
git add server/lib/appdir.js server/lib/jsonstore.js server/lib/tokens.js server/lib/jsonstore.test.js server/lib/tokens.test.js
git commit -m "feat: 应用目录与原子 JSON 存储（0700 权限、.bak 回退、令牌脱敏）"
```

---

## Task 3: 分享存储

**Files:**
- Create: `server/lib/shares.js`
- Test: `server/lib/shares.test.js`

**Interfaces（逐字照用）:**

```js
// 分享记录形状（写进 ~/.photocull/shares.json 的 shares 映射）
// { id, token, root, label, createdAt, expiresAt|null, revoked,
//   allowUserCreation, defaultRole, maxUsers|null }

createShare({ root, label, expiresAt, defaultRole, allowUserCreation, maxUsers })
  -> Promise<Share>                   // root 必须已 realpath；token 由本模块生成
getShareById(id)          -> Promise<Share|null>
resolveToken(token)       -> Promise<Share|null>    // 只做查找，不判活
listShares()              -> Promise<Share[]>       // 按 createdAt 倒序
updateShare(id, patch)    -> Promise<Share>         // 只允许改 label/expiresAt/
                                                    // defaultRole/allowUserCreation/maxUsers
revokeShare(id)           -> Promise<Share>         // 软删：revoked = true，记录保留
shareStatus(share, now)   -> 'active'|'expired'|'revoked'|'missing'   // 纯函数
```

**关键语义：**

- `resolveToken` 与 `shareStatus` **必须分开**。调用方先解析、再判活，
  这样审计日志才能记下真实原因（`expired` / `revoked`），
  而 HTTP 响应统一成 404。把两者合并就没法既不泄露又留痕。
- `revokeShare` 是软删。用户表和审计日志**必须保留**——
  「谁在什么时候进来过」是撤销之后才更需要的信息。
- `token` 由本模块生成，**永不接受外部传入**（防止调用方传入可预测值）。
- `updateShare` 的 patch 白名单要硬编码；`root` 和 `token` 不可改
  （改 root 等于把一条已经发出去的链接指向另一个文件夹）。

- [ ] **Step 1: 写失败测试**

```js
// 时间必须可注入 —— 过期语义靠真实时钟测就只能 sleep，或者永远测不到边界。
it('恰好到期的瞬间算过期', async () => {
  const s = await createShare({ root: '/tmp/x', expiresAt: 1000 });
  expect(shareStatus(s, 999)).toBe('active');
  expect(shareStatus(s, 1000)).toBe('expired');   // 边界：>= 即过期
  expect(shareStatus(s, 1001)).toBe('expired');
});

it('expiresAt 为 null 表示永不过期', async () => {
  const s = await createShare({ root: '/tmp/x', expiresAt: null });
  expect(shareStatus(s, Number.MAX_SAFE_INTEGER)).toBe('active');
});

it('撤销压过未过期', async () => { /* revoked=true 且 expiresAt 在未来 -> revoked */ });

// ⚠️ 上面那条**检测不到优先级对调** —— 实现时已实测确认：
// 分享还没过期时，先判 revoked 还是先判 expired 结果都是 'revoked'。
// 必须再加下面这条（两个条件同时成立，才分得出先后）：
it('撤销压过已过期：两者都成立时结果仍是 revoked', async () => {
  const s = await createShare({ root: '/tmp/a', expiresAt: 1000 });
  await revokeShare(s.id);
  expect(shareStatus(await getShareById(s.id), 5000)).toBe('revoked');
});

it('两条分享的 token 不相同，且长度为 43', async () => { /* ... */ });

it('updateShare 不能改 root 或 token', async () => {
  const s = await createShare({ root: '/tmp/a' });
  const after = await updateShare(s.id, { root: '/tmp/b', token: 'x', label: '新标签' });
  expect(after.root).toBe('/tmp/a');     // 改 root = 把已发出的链接指向别的文件夹
  expect(after.token).toBe(s.token);
  expect(after.label).toBe('新标签');
});

it('撤销之后 resolveToken 仍能查到（判活是调用方的事）', async () => {
  const s = await createShare({ root: '/tmp/a' });
  await revokeShare(s.id);
  const found = await resolveToken(s.token);
  expect(found?.id).toBe(s.id);
  expect(shareStatus(found, Date.now())).toBe('revoked');
});

it('持久化：重新加载后分享仍在', async () => { /* 清模块内缓存后重读 */ });
```

- [ ] **Step 2: 跑测试，确认全红**
- [ ] **Step 3: 实现**（用 Task 2 的 `readJson`/`writeJson`/`newToken`/`newId`，
      存储路径 `path.join(appRoot(), 'shares.json')`，形状 `{ version: 1, shares: {} }`）
- [ ] **Step 4: 跑测试确认全绿**
- [ ] **Step 5: 突变验证**——把过期边界从 `>=` 改成 `>`、把 patch 白名单去掉、
      把 `revoked` 的优先级调到过期之后，各跑一次确认对应用例变红，然后还原
- [ ] **Step 6: 提交**

---

## Task 4: 用户存储

**Files:**
- Create: `server/lib/users.js`
- Test: `server/lib/users.test.js`

**Interfaces（逐字照用）:**

```js
// 用户记录：{ id, shareId, nickname, nicknameKey, token, role, createdAt, lastSeenAt, disabled }

normalizeNickname(raw) -> { ok: true, nickname, key } | { ok: false, reason }
  // reason 取值 'empty' | 'too-long' | 'bad-chars'

createUser(shareId, nickname, role) -> Promise<User>
  // 昵称已被占用时抛 NicknameTakenError（带 code = 'nickname-taken'）
findUserByToken(token)              -> Promise<User|null>
findUserByNicknameKey(shareId, key) -> Promise<User|null>
listUsers(shareId)                  -> Promise<User[]>
updateUser(shareId, userId, patch)  -> Promise<User>   // 白名单：role / disabled
deleteUser(shareId, userId)         -> Promise<void>   // 令牌立即失效
touchUser(shareId, userId)          -> Promise<void>   // 更新 lastSeenAt
countUsers(shareId)                 -> Promise<number>
```

**昵称归一化规则（逐字照用）：**

1. 去首尾空白，把内部连续空白折叠成单个半角空格
2. 拒绝任何控制字符，判定式固定为 `/[\u0000-\u001F\u007F]/`，不通过则 `reason = 'bad-chars'`

   > **必须写成转义序列。** 这份计划的这一段前两稿都因为直接键入裸控制字符
   > 被工具拦下。同样的错误在上一阶段真的进过仓库一次：一个字面 NUL 混进
   > `thumbs.js`，代码照常工作、测试照常通过，但 `git diff` 把整个文件当成二进制、
   > `grep` 搜不到内容，是突变测试「没变红」才追出来的。
   > 更早还有一次混进计划文件，导致 `grep` 静默失败、任务说明被截断，
   > 实现者只能自己补全，补出了一个真实的目录名大小写折叠缺陷。
   > 裸控制字符在源码里是隐形的——**永远用转义写**。

3. 空 -> `empty`；按**码点**计长度 > 24 -> `too-long`
   （用 `[...s].length`，**不是** `s.length`——emoji 和不少汉字是代理对，
   用 `.length` 会把一个字符算成两个）
4. `key = nickname.normalize('NFKC').toLowerCase()`

**为什么唯一性判定要用 NFKC + 小写：** 半角 `Amy` 与全角 `Ａｍｙ`、
`amy` 与 `AMY` 在屏幕上是两个人还是一个人，人眼分不清。
审计日志的全部价值在于「这条操作是谁做的」，两个显示上难以区分的昵称
会直接毁掉这个价值。所以**冲突就拒绝，不自动加后缀**。

- [ ] **Step 1: 写失败测试**

```js
it.each([
  ['  小林  ', '小林'],
  ['小  林', '小 林'],          // 内部连续空白折叠
])('归一化 %s -> %s', (raw, want) => {
  expect(normalizeNickname(raw)).toMatchObject({ ok: true, nickname: want });
});

it.each([
  ['', 'empty'],
  ['   ', 'empty'],
  ['a'.repeat(25), 'too-long'],
  ['ab\tcd', 'bad-chars'],   // 制表符
  ['ab\u0007cd', 'bad-chars'],   // 响铃
  ['ab\u007Fcd', 'bad-chars'],   // DEL
])('拒绝 %j，原因 %s', (raw, reason) => {
  expect(normalizeNickname(raw)).toMatchObject({ ok: false, reason });
});

it('24 个 emoji 是允许的（按码点计长度，不是按 UTF-16 单元）', () => {
  // 这个 emoji 的 .length 是 2；用 s.length 判断的实现会在第 12 个就误判 too-long
  const e = '\u{1F600}';
  expect(normalizeNickname(e.repeat(24)).ok).toBe(true);
  expect(normalizeNickname(e.repeat(25))).toMatchObject({ ok: false, reason: 'too-long' });
});

it.each([
  ['Amy', 'ａｍｙ'],                // 全角 vs 半角
  ['Amy', 'AMY'],                  // 大小写
  ['小林', ' 小林 '],               // 空白
])('%j 与 %j 视为同一个昵称', async (a, b) => {
  await createUser(shareId, a, 'editor');
  await expect(createUser(shareId, b, 'editor')).rejects.toMatchObject({ code: 'nickname-taken' });
});

it('不同分享之间昵称互不冲突', async () => { /* 同名在另一个 shareId 下可建 */ });

it('删除用户后其令牌立即失效', async () => {
  const u = await createUser(shareId, '小林', 'editor');
  await deleteUser(shareId, u.id);
  expect(await findUserByToken(u.token)).toBeNull();
});

it('禁用用户仍可被令牌查到（判活交给调用方），但 disabled 为 true', async () => { /* ... */ });

it('updateUser 只能改 role 和 disabled', async () => {
  const u = await createUser(shareId, '小林', 'viewer');
  const after = await updateUser(shareId, u.id, { role: 'editor', token: 'hack', nickname: '别人' });
  expect(after.role).toBe('editor');
  expect(after.token).toBe(u.token);
  expect(after.nickname).toBe('小林');
});
```

- [ ] **Step 2-6:** 同 Task 3 的节奏（红 -> 实现 -> 绿 -> 突变验证 -> 提交）。
      突变点至少包括：把长度判定换成 `s.length`、去掉 NFKC、去掉 `toLowerCase`、
      去掉 patch 白名单、把控制字符正则改成只拦 NUL。

> 存储路径 `~/.photocull/shares/<shareId>/users.json`，形状 `{ version: 1, users: {} }`。
> `findUserByToken` 需要跨全部分享查找——实现上维护一张内存索引，
> 第一次查询时惰性加载全部分享的用户表。

---

## Task 5: 审计日志

**Files:** Create `server/lib/audit.js`；Test `server/lib/audit.test.js`

**Interfaces（逐字照用）:**

```js
logEvent(shareId, event, tokens) -> Promise<void>
  // event: { ts?, actor, nickname?, action, ...payload }
  // ts 缺省用 Date.now()；actor 为 userId 或字面量 'admin'
  // tokens: 需要脱敏的令牌数组（该分享的 share.token + 其下全部 user.token）
readEvents(shareId, { limit, before, actor, action }) -> Promise<Event[]>   // 时间倒序
eventsToCsv(events) -> string        // 复用 server/lib/csv.js 的转义
ACTIONS                              // 冻结的动作名集合，见规格 3.4 节
```

**必须成立的性质：**

- **追加写，从不改写。**
- **令牌绝不落盘。** `logEvent` 写之前对整个 event 过一遍 `redactTokens`。
- **轮转**：单文件超过 16 MB 改名为 `events.1.jsonl`，最多 3 代，第 4 代丢弃。
  阈值必须可注入，否则测不了。
- **坏行不能毒死整个日志。** `readEvents` 逐行解析，失败的行跳过并计数，不抛错——
  一条被截断的行不该让管理员再也打不开日志。

- [ ] **Step 1: 写失败测试**

```js
it('令牌绝不会出现在日志文件里', async () => {
  const token = newToken();
  // 故意把令牌塞进多个位置：顶层、嵌套对象、数组
  await logEvent(shareId, {
    actor: 'admin', action: 'share.create',
    token, nested: { t: token }, list: ['x', token],
  }, [token]);
  const raw = await fs.readFile(eventsPath(shareId), 'utf8');
  expect(raw).not.toContain(token);        // 子串搜索，不是字段检查
  expect(raw).toContain('[redacted]');
});

it('一行坏 JSON 不影响其它行被读出来', async () => {
  await logEvent(shareId, { actor: 'admin', action: 'user.join' }, []);
  await fs.appendFile(eventsPath(shareId), '{被截断的半行' + String.fromCharCode(10), 'utf8');
  await logEvent(shareId, { actor: 'admin', action: 'mark.set' }, []);
  const events = await readEvents(shareId, {});
  expect(events.map((e) => e.action)).toEqual(['mark.set', 'user.join']);   // 倒序
});

it('并发写入不交错、不丢行', async () => {
  await Promise.all(Array.from({ length: 200 }, (_, i) =>
    logEvent(shareId, { actor: 'admin', action: 'mark.set', assetId: 'a' + i }, [])));
  const events = await readEvents(shareId, { limit: 1000 });
  expect(events).toHaveLength(200);
  expect(new Set(events.map((e) => e.assetId)).size).toBe(200);
});

it('超过阈值时轮转，且不丢行', async () => { /* 用可注入的小阈值 */ });
it('只保留 3 代', async () => { /* 连续轮转 5 次，断言 events.4.jsonl 不存在 */ });
it('按 actor 和 action 过滤', async () => { /* ... */ });
it('CSV 里含逗号/引号/换行的字段被正确转义', async () => { /* 复用 csv.js 的断言风格 */ });
```

- [ ] **Step 2-6:** 红 -> 实现 -> 绿 -> 突变验证 -> 提交。
      突变点必须包括：**去掉 `redactTokens` 调用**（第一条用例必须立刻变红）、
      把逐行解析改成整体 `JSON.parse`、把轮转代数改成无上限。

---

## Task 6: 身份与授权中间件

> **这是整个阶段的安全核心。** 它决定一个拿到分享链接的人能碰到什么。
> 实现要保守：不确定的一律拒绝。

**Files:** Create `server/lib/cookies.js`、`server/lib/actor.js`、
`server/middleware/auth.js`、`server/middleware/ratelimit.js`；
Test 各自同名 `.test.js`

**Interfaces（逐字照用）:**

```js
// cookies.js
parseCookies(header) -> Record<string,string>        // 无 header 返回 {}
serializeCookie(name, value, opts) -> string         // opts: { httpOnly, sameSite, path, maxAge }

// actor.js
isLoopback(req) -> boolean
resolveActor(req) -> Promise<Actor>
// Actor 形状之一： { kind:'admin' } | { kind:'user', user, share } | { kind:'none' }

// auth.js（Express 中间件）
attachActor      // 把 resolveActor 的结果挂到 req.actor，永不拒绝
requireAdmin     // 非 admin -> 403 { error:'admin-only', message:'这个操作只能在本机进行' }
requirePerm(p)   // p 取 'read' 或 'write'
defaultDeny      // 白名单之外且 req.actor.kind === 'none' -> 401 { error:'no-actor' }

// ratelimit.js
createRateLimiter({ windowMs, max }) -> { hit(key) -> boolean, reset() }
```

**回环判定（逐字照用，不得改写）：**

```js
export function isLoopback(req) {
  const ip = req.socket.remoteAddress;
  // 只看 TCP 源地址。**绝不读 X-Forwarded-For** —— 那是客户端可以随便写的请求头，
  // 读它等于把管理员权限开放给任何知道加一行 header 的人。
  // 代价是：放在反向代理后面时所有请求都不是回环，管理员判定会失效。
  // 这是刻意的取舍，文档里必须写明此时要用 --admin-token。
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
```

**`resolveActor` 的判定顺序（顺序本身是要求）：**

1. `--admin-token` 已配置且请求头 `X-PhotoCull-Admin` 与之**定长比较**相等 -> `admin`
   （`crypto.timingSafeEqual`；长度不等直接判否）
2. `isLoopback(req)` -> `admin`
3. Cookie 里有用户令牌 -> `findUserByToken`；查到、`disabled === false`、
   且其 share 的 `shareStatus === 'active'` -> `user`
4. 其余 -> `none`

**`requirePerm` 的判定：**

| actor | `'read'` | `'write'` |
|---|---|---|
| `admin` | 放行 | 放行 |
| `user` role=`editor` | 放行 | 放行 |
| `user` role=`viewer` | 放行 | **403** `{ error:'read-only', message:'你当前是只读权限' }` |
| `none` | **401** `{ error:'no-actor' }` | **401** |

**另外：`user` 只能访问自己那条分享指向的会话。**
`requirePerm` 放行之前必须校验请求携带的 `sessionId` 对应的会话满足
`session.root === actor.share.root`，不等则 403
`{ error:'wrong-library', message:'这条链接不对应当前打开的文件夹' }`。
少了这一条，一个访客就能用另一条链接的 sessionId 去读别的文件夹。

- [ ] **Step 1: 写失败测试（先写最要紧的几条）**

```js
it('X-Forwarded-For 不能把远端请求伪装成管理员', async () => {
  const req = fakeReq({ ip: '192.168.1.50', headers: { 'x-forwarded-for': '127.0.0.1' } });
  expect(isLoopback(req)).toBe(false);
  expect((await resolveActor(req)).kind).toBe('none');
});

it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('回环地址 %s 是管理员', async (ip) => {
  expect((await resolveActor(fakeReq({ ip }))).kind).toBe('admin');
});

it('被禁用的用户解析为 none', async () => { /* ... */ });
it('分享过期后其用户解析为 none', async () => { /* ... */ });
it('分享被撤销后其用户解析为 none', async () => { /* ... */ });
it('伪造的用户令牌解析为 none', async () => { /* ... */ });
it('viewer 的写请求 403 read-only，读请求放行', async () => { /* ... */ });

it('访客不能用别条链接的 sessionId 读别的文件夹', async () => {
  // A 的分享指向 rootA，B 的分享指向 rootB
  // 用 A 的 Cookie + rootB 的 sessionId 请求 -> 403 wrong-library
});

it('admin-token 比较是定长的，长度不等时不通过', async () => { /* ... */ });
```

- [ ] **Step 2-4:** 红 -> 实现四个模块 -> 绿
- [ ] **Step 5: 突变验证（不可省略）**——逐个破坏后确认对应用例变红再还原：
      把 `isLoopback` 改成读 `x-forwarded-for`；去掉 `disabled` 检查；
      去掉 `shareStatus` 检查；把 viewer 的写判定改成放行；去掉 `wrong-library` 校验
- [ ] **Step 6: 提交**

---

## Task 7: 权限矩阵接线

**Files:** Modify `server/index.js`、`server/routes/{fs,library,marks,image,export}.js`；
Test `server/routes/permissions.test.js`（新建，全枚举）

**这个任务的交付物就是那张矩阵测试。** 它是安全边界唯一可执行的表达。

- [ ] **Step 1: 先写矩阵测试（此时必然大面积失败）**

```js
// 四种身份 x 每一个端点，全枚举。
const ENDPOINTS = [
  // [method, path, admin, editor, viewer, none]
  ['GET',  '/api/fs/roots',           200, 403, 403, 401],
  ['GET',  '/api/fs/list',            200, 403, 403, 401],
  ['POST', '/api/fs/mkdir',           200, 403, 403, 401],
  ['POST', '/api/library/open',       200, 403, 403, 401],
  ['POST', '/api/library/close',      200, 403, 403, 401],
  ['POST', '/api/library/prioritize', 200, 403, 403, 401],
  ['PUT',  '/api/library/settings',   200, 403, 403, 401],
  ['GET',  '/api/library/assets',     200, 200, 200, 401],
  ['GET',  '/api/library/meta',       200, 200, 200, 401],
  ['GET',  '/api/library/marks',      200, 200, 200, 401],
  ['PUT',  '/api/library/marks',      200, 200, 403, 401],
  ['GET',  '/api/thumb',              200, 200, 200, 401],
  ['GET',  '/api/original',           200, 200, 200, 401],
  ['POST', '/api/export',             200, 403, 403, 401],
  ['GET',  '/api/admin/shares',       200, 403, 403, 401],
  // ...管理端点逐条列全
];

it.each(ENDPOINTS)('%s %s -> admin=%i editor=%i viewer=%i none=%i', async () => { /* ... */ });

it('每一个 /api 路由都出现在矩阵里', () => {
  // 从 Express 路由栈枚举实际注册的路径，与 ENDPOINTS 求差集，断言为空。
  // 以后有人加了新端点却忘了写权限，这里立刻红。
  expect(uncovered).toEqual([]);
});
```

> 最后那条「每个路由都被覆盖」是整张表里最有价值的一条——
> 它把「别忘了」从人的纪律变成机器的检查。

- [ ] **Step 2:** 挂 `attachActor` -> 白名单 -> `defaultDeny`，逐路由加 `requireAdmin` / `requirePerm`
- [ ] **Step 3:** 跑矩阵测试至全绿
- [ ] **Step 4:** 确认既有测试没被打破（`npx vitest run server/`）
- [ ] **Step 5:** 突变验证——随机摘掉 3 个 `requireAdmin`，确认对应行变红
- [ ] **Step 6:** 提交

---

## Task 8: 分享接入接口

**Files:** Create `server/routes/share.js`；**Modify `server/middleware/auth.js`**；
Test `server/routes/share.test.js`

> **交付物里包含白名单第四项。** Task 6 按计划字面只实现了白名单的前两项，
> Task 7 也没有认领它（`auth.js` 不在它的范围里）——两个实现者都如实报告了、
> 都没有越界，是对的。现在归你：把 `POST /api/share/:token/resume` 加进
> `middleware/auth.js` 的 `WHITELIST`，并更新那句「白名单只有三项」的注释。
> 不加的话，令牌已失效的回访者会被 `defaultDeny` 拦成 401 `no-actor`，
> 拿不到 401 `need-join`，**那枚死 Cookie 永远清不掉**，浏览器会一直带着它重试。

**端点与响应（逐字照用）：**

```
GET  /api/share/:token/info    -> 200 { label, assetCountHint, allowUserCreation,
                                        requiresNickname, expiresAt }
                                  无效一律 404 { error:'invalid-link',
                                                 message:'链接不存在或已失效' }
POST /api/share/:token/join    body { nickname }
     -> 200 { sessionId, user:{id,nickname,role}, share:{label}, ...openResult }
        并下发 Set-Cookie: pc_user=<token>; HttpOnly; SameSite=Lax; Path=/
     -> 404 invalid-link      链接过期/撤销/不存在（三者文案完全一致）
     -> 409 nickname-taken    { message:'这个昵称已经有人在用了，换一个吧' }
     -> 400 bad-nickname      { message: 按 reason 给具体文案 }
     -> 403 creation-off      { message:'这条链接已停止接纳新成员' }
     -> 403 full              { message:'参与人数已达上限' }
     -> 429 rate-limited      { message:'尝试过于频繁，请稍后再试' }
POST /api/share/:token/resume  无体，凭 Cookie
     -> 200 同 join；令牌无效/用户被禁用则清 Cookie 并返回 401 { error:'need-join' }
POST /api/share/leave          -> 200，清 Cookie，记 session.disconnect
```

**必须成立的性质：**

- **三种无效原因的 HTTP 响应逐字节一致**（状态码、body、header）。
  真实原因只写进审计日志。测试要断言三者的响应体**全等**。
- **限流按 IP**：60 秒窗口内 20 次失败的 join -> 429。成功的 join 不计数。
- `join` 成功后要 `openSession(share.root)`（复用已有会话）。
- 每条路径都要 `logEvent`：`user.join` / `user.resume` / `user.denied`（带 reason）。

- [ ] **Step 1: 写失败测试**

```js
it('过期、撤销、不存在三种情况的响应逐字节一致', async () => {
  const a = await get('/api/share/' + expiredToken + '/info');
  const b = await get('/api/share/' + revokedToken + '/info');
  const c = await get('/api/share/' + newToken() + '/info');
  expect(a.status).toBe(404);
  expect(b.body).toEqual(a.body);
  expect(c.body).toEqual(a.body);   // 不得泄露有效 token 的存在性
});

it('但审计日志里记下了真实原因', async () => {
  await get('/api/share/' + expiredToken + '/info');
  const events = await readEvents(expiredShareId, {});
  expect(events[0]).toMatchObject({ action: 'user.denied', reason: 'expired' });
});

it('info 不泄露任何令牌或路径', async () => {
  const res = await get('/api/share/' + token + '/info');
  const text = JSON.stringify(res.body);
  expect(text).not.toContain(shareToken);
  expect(text).not.toContain(root);        // 客户不该知道照片在摄影师磁盘的哪里
});

it('join 下发的 Cookie 是 HttpOnly + SameSite=Lax', async () => { /* 断言 set-cookie 串 */ });
it('allowUserCreation=false 时新昵称 403', async () => { /* ... */ });

// ⚠️ 本条原文写的是「已存在的昵称仍可进」—— 那是一个**身份顶替漏洞**：
// 任何拿到链接的人打出「新娘小林」就继承了她的全部记录和操作历史，昵称等于凭据。
// 正确顺序是**先查重 409、再看开关 403**（规格 §5.2 的昵称唯一是无条件的）。
// 代价：丢了 Cookie 又赶上开关关闭的老客户没有回来的路——
// 这由管理员删除其用户记录来解（Task 19 有这个操作），不能靠昵称放行。
it('allowUserCreation=false 时，打出已存在的昵称仍然是 409 而不是放行', async () => {
  await createUser(shareId, '新娘小林', 'editor');
  await updateShare(shareId, { allowUserCreation: false });
  const res = await post(`/api/share/${token}/join`, { nickname: '新娘小林' });
  expect(res.status).toBe(409);          // 不是 200
});
it('maxUsers 满了返回 403 full', async () => { /* ... */ });
it('20 次失败后第 21 次 429，成功的 join 不计入', async () => { /* ... */ });
it('resume 在用户被禁用后清 Cookie 并返回 401 need-join', async () => { /* ... */ });
```

- [ ] **Step 2-6:** 红 -> 实现 -> 绿 -> 突变验证（把三种拒绝改成不同文案、
      去掉限流、把 root 加进 info 响应）-> 提交

---

## Task 9: 管理接口

**Files:** Create `server/routes/admin.js`；Test `server/routes/admin.test.js`

端点见规格 6.1 节。全部 `requireAdmin`。

**必须成立的性质：**

- **任何返回用户列表的响应都不得含 `token` 字段。** 测试用子串搜索断言。
- 改角色、禁用、删除都要 `logEvent`，并触发 SSE 推送（Task 11 接线）。
- `DELETE /api/admin/shares/:id` 是软删（`revoked = true`），
  用户表和审计日志保留。
- 建分享时 `root` 取自当前会话或显式传入，**必须经过 `assertWithin` + `realpathDeep`**——
  否则管理员接口就成了一条绕过路径边界的通道。

- [ ] **Step 1: 写失败测试**

```js
it('用户列表响应里不含任何令牌', async () => {
  const u = await createUser(shareId, '小林', 'editor');
  const res = await get('/api/admin/shares/' + shareId + '/users');
  expect(JSON.stringify(res.body)).not.toContain(u.token);
});

it('建分享时 root 越界被拒', async () => {
  const res = await post('/api/admin/shares', { root: '/etc' });
  expect(res.status).toBe(403);
});

it('撤销后用户表和日志仍在', async () => { /* ... */ });
it('审计日志 CSV 的转义正确且不含令牌', async () => { /* ... */ });
```

- [ ] **Step 2-6:** 红 -> 实现 -> 绿 -> 突变验证 -> 提交

---

## Task 10: 标记归属与广播

**Files:** Modify `server/lib/store.js`、`server/routes/marks.js`；
Test `server/lib/store.test.js`（扩充）、`server/routes/marks.test.js`

**存储形状（兼容性是硬要求）：**

```jsonc
{ "version": 1,
  "marks":     { "cam-a/IMG_0421": "pick" },
  "marksMeta": { "cam-a/IMG_0421": { "by": "u_2c7b", "at": 1785000123456 } } }
```

`marks` 的形状**一个字节都不能变**——导出链路、`derive.ts`、
既有的乐观回滚全都按现在的读法工作。`marksMeta` 缺失时按空表处理。

**广播（SSE 事件，逐字照用）：**

```jsonc
{ "type":"marks", "origin":"u_2c7b", "seq":417,
  "changes": { "cam-a/IMG_0421": { "mark":"pick", "by":"u_2c7b", "at":1785000123456 } } }
```

`origin` 是发起者的 actor id（管理员为 `'admin'`）。清除标记时 `mark` 为 `null`。

- [ ] **Step 1: 写失败测试**

```js
it('读旧格式（没有 marksMeta）不报错，归属为空', async () => { /* ... */ });
it('marks 字段的形状与升级前逐字节一致', async () => {
  // 写入后读原始 JSON，断言 marks 仍是 Record<id, 'pick'|'reject'>
});
it('写标记会广播给该会话的所有监听者，且带 origin', async () => { /* ... */ });
it('每次写标记产生且仅产生一条 mark.set 审计记录', async () => { /* ... */ });
it('批量写产生一条 mark.bulk，assetIds 超过 200 时只记数量', async () => { /* ... */ });
it('viewer 的写被拒时不产生任何审计记录也不广播', async () => { /* ... */ });
```

- [ ] **Step 2-6:** 红 -> 实现 -> 绿 -> 突变验证 -> 提交

---

## Task 11: 在线状态与生命周期事件

**Files:** Create `server/lib/presence.js`；Modify `server/lib/session.js`、
`server/routes/library.js`；Test `server/lib/presence.test.js`

**在线状态 = SSE 连接本身，不做心跳。** 连接建立即上线，`req.on('close')` 即下线。
少一套超时判定，少一类幽灵在线。

实现要点：`session.listeners` 现在存 `{ send, end }`，改为 `{ send, end, actor }`，
在线名单由这个集合直接派生（同一用户多标签页去重，按 userId）。

**SSE 事件（逐字照用）：**

```jsonc
{"type":"presence","users":[{"id":"u_2c7b","nickname":"新娘小林","role":"editor"}]}
{"type":"role","userId":"u_2c7b","role":"viewer"}
{"type":"kicked","reason":"disabled"}
{"type":"share-ended","reason":"revoked"}
```

- [ ] **Step 1: 写失败测试**

```js
it('连接建立即上线，断开即下线', async () => { /* ... */ });
it('同一用户两个标签页在名单里只出现一次', async () => { /* ... */ });
it('管理员改角色后，该用户的连接立即收到 role 事件', async () => { /* ... */ });
it('禁用用户后，其连接收到 kicked 并被服务端主动断开', async () => {
  // 断开是必须的：只发事件不断开，客户端可以忽略事件继续用
});
it('撤销分享后，该分享的全部访客收到 share-ended 并被断开，管理员连接不受影响', async () => { /* ... */ });
it('presence 名单里不含令牌', async () => { /* ... */ });
```

- [ ] **Step 2-6:** 红 -> 实现 -> 绿 -> 突变验证（把「断开连接」去掉，
      确认对应用例变红）-> 提交

---

## Task 12: 扫描增量推送（终审 I7）

**Files:** Modify `server/lib/session.js`、`server/routes/library.js`；
Test `server/lib/session.test.js`（扩充）

**背景：** `scan.js` 的 `onBatch` 增量机制在上一阶段实现并经**两轮修复**验证
（含一个独立复现的突变测试），但**生产代码从来没有传过 `onBatch`**。
于是 `POST /api/library/open` 会一直阻塞到整个递归遍历加每文件一次 `stat` 结束。
终审把这条列为真机第一风险：读卡器上 3000 对照片要几十秒，
界面只有一个静止的「正在扫描…」，跟卡死无法区分。

**改法：**

- `POST /api/library/open` **立即返回** `{ sessionId, root, phase: 'scanning' }`
- 扫描进度经 SSE：`{"type":"scan","found":1500,"done":false}`
- 完成时 `{"type":"scan","done":true}`，客户端再拉 `/api/library/assets`
- 扫描失败时 `{"type":"scan","error":"..."}`，客户端退回选择器
- **写探测（`assertWritable`）仍必须在返回之前同步完成**——
  它是开库能否成立的前置判断，不能异步化，否则用户会先看到进度条再被告知文件夹不可写

- [ ] **Step 1: 写失败测试**

```js
it('open 在扫描完成之前就返回', async () => {
  // 用一个能人为拖慢的 scanFolder 桩，断言 open 的响应在扫描 promise 之前 resolve
});
it('扫描进度经 SSE 推送，累计计数单调不减', async () => { /* ... */ });
it('扫描失败时推 scan.error，会话被清理掉', async () => { /* ... */ });
it('文件夹不可写时，open 直接 400，不产生任何 scan 事件', async () => {
  // 顺序很重要：先判可写，再开始扫描
});
```

- [ ] **Step 2-6:** 红 -> 实现 -> 绿 -> 突变验证 -> 提交

---

## Task 13: 网络暴露与启动

**Files:** Modify `server/index.js`；Create `server/lib/netaddr.js`；
Test `server/lib/netaddr.test.js`、`server/index.test.js`

- 默认 `127.0.0.1`；`--share` 才 `0.0.0.0`
- `--admin-token=<串>`（可选）
- `GET /api/admin/netaddr` -> 可用的局域网地址列表（多网卡时不猜，交给人选）
- SPA 兜底：`app.get('/*splat', ...)` 返回 `index.html`
  （Express 5 的通配语法是 `/*splat`，**不是** `'*'`）
- 启动时打印醒目告警：**局域网内任何人只要拿到链接就能看这些照片**

- [ ] **Step 1: 写失败测试**

```js
it('不带 --share 时只监听回环', async () => { /* 断言 server.address().address */ });
it('带 --share 时监听 0.0.0.0，且启动输出里包含安全告警', async () => { /* ... */ });
it('SPA 兜底不吞掉 /api 路径', async () => {
  // /api/不存在的路径 必须是 404 JSON，不能返回 index.html
});
it('netaddr 不返回回环地址和 IPv6 链路本地地址', async () => { /* ... */ });
```

- [ ] **Step 2-6:** 红 -> 实现 -> 绿 -> 突变验证 -> 提交

---

## Task 14: 前端路由与会话 store

**Files:** Create `web/src/routes.tsx`、`web/src/store/session.ts`、`web/src/lib/avatar.ts`；
Modify `web/src/main.tsx`；Test 各自 `.test.tsx` / `.test.ts`

```ts
// store/session.ts
interface SessionState {
  kind: 'admin' | 'user' | 'none';
  user: { id: string; nickname: string; role: 'viewer' | 'editor' } | null;
  share: { label: string } | null;
  online: Array<{ id: string; nickname: string; role: string }>;
  canWrite(): boolean;          // admin 或 role === 'editor'
}
```

- [ ] **Step 1: 写失败测试**

```js
it.each([
  ['/',            'local'],
  ['/s/abc123',    'guest'],
  ['/admin',       'admin'],
  ['/s/',          'notfound'],     // 缺 token
  ['/unknown',     'notfound'],
])('%s -> %s', (path, want) => { expect(routeFor(path)).toBe(want); });

it('token 从路径里原样取出，不做解码猜测', () => {
  expect(tokenFor('/s/a-b_c')).toBe('a-b_c');    // base64url 含 - 和 _
});

it('avatar 颜色由 userId 稳定派生：同 id 永远同色', () => { /* ... */ });
it('canWrite: viewer 为 false，editor 与 admin 为 true', () => { /* ... */ });
```

- [ ] **Step 2-6:** 红 -> 实现 -> 绿 -> 突变验证 -> 提交

---

## Task 15: 访客接入界面

**Files:** Create `web/src/guest/JoinGate.tsx`、`web/src/components/Blocker.tsx`；
Test `web/src/guest/JoinGate.test.tsx`

覆盖规格 10 节的每一种拒绝文案。

- [ ] **Step 1: 写失败测试**

```tsx
it('链接无效时整页阻断，且不显示昵称表单', async () => { /* ... */ });
it('昵称被占用时内联报错，且保留已输入内容', async () => {
  // 把用户输入清空是很伤的——他刚想好一个名字
});
it.each([
  ['creation-off', '已停止接纳新成员'],
  ['full',         '人数已达上限'],
  ['rate-limited', '尝试过于频繁'],
])('%s 显示 %s', async (code, text) => { /* ... */ });
it('带有效 Cookie 时跳过昵称表单直接进入', async () => { /* resume 成功 */ });
it('提交中禁用按钮，避免重复建号', async () => { /* ... */ });
```

- [ ] **Step 2-6:** 红 -> 实现 -> 绿 -> 突变验证 -> 提交

---

## Task 16: 访客选片界面与只读门禁

**Files:** Create `web/src/guest/GuestApp.tsx`；Modify `web/src/lib/useKeyboard.ts`；
Test `web/src/guest/GuestApp.test.tsx`、`web/src/lib/useKeyboard.test.ts`

复用 `Grid` / `StackCell` / `Thumb` / `Lightbox` / `Sidebar` **原封不动**。
去掉：文件夹选择器、导出面板、库级设置。

**只读门禁是安全属性，必须在 `useKeyboard` 里短路**——
`P` / `X` 是键盘操作，没有按钮可隐藏。

- [ ] **Step 1: 写失败测试（这是本任务的核心）**

```ts
it.each(['p', 'x', 'u'])('viewer 按 %s 不产生任何标记写请求', async (key) => {
  setSession({ kind: 'user', user: { role: 'viewer' } });
  fireKey(key);
  expect(fetchSpy).not.toHaveBeenCalled();     // 不是「按钮被隐藏」，是根本没发请求
});

it('editor 按 P 会发出写请求', async () => { /* 对照组：证明上一条不是因为整个键盘都坏了 */ });

it('访客界面不渲染导出入口和文件夹选择器', async () => { /* ... */ });
it('访客界面不渲染连拍阈值滑杆（库级设置仅管理员）', async () => { /* ... */ });
```

> 第二条对照组是必须的。只断言「viewer 按键没反应」的测试，
> 在键盘监听整个坏掉时也会通过——那是一个通过了但不携带信息的测试，
> 本项目已经栽过好几次。

- [ ] **Step 2-6:** 红 -> 实现 -> 绿 -> 突变验证（去掉短路，确认第一条变红）-> 提交

---

## Task 17: 实时合并与阻断层

**Files:** Create `web/src/lib/realtime.ts`、`web/src/components/PresenceBar.tsx`；
Modify `web/src/store/marks.ts`、`web/src/lib/api.ts`；
Test `web/src/lib/realtime.test.ts`、`web/src/store/marks.test.ts`（扩充）

**三条必须成立的规则：**

1. `origin === 自己` 的广播**忽略**（自己已经乐观更新过了）。
2. **本地对某 id 还有未落地的写请求时，丢弃该 id 的远端广播**，
   等自己的写请求返回后以服务端响应为准。否则会出现
   「我按了 P，别人的旧值把界面刷回去，我的写又成功了」的闪烁。
   现有的序号归属机制（`marks.ts` 的 pending 表）正是为此准备的，复用它。
3. **SSE 重连成功后必须全量拉一次 marks。** SSE 只推增量，
   断开期间别人改的标记不会补发；不补拉就会长期不一致。
   `api.ts` 的 `openStream` 目前只转发 `onerror`，需要补一个 `onopen` 回调。

- [ ] **Step 1: 写失败测试**

```ts
it('忽略自己发出的回声', () => { /* origin === 自己的 userId */ });

it('本地有未落地写时，丢弃该 id 的远端广播', () => {
  // 1. 本地乐观置为 pick（写请求未返回）
  // 2. 收到远端广播说它是 reject
  // 3. 断言界面仍是 pick
  // 4. 本地写请求返回 pick -> 仍是 pick
});

it('未落地写只保护它自己那个 id，别的 id 的广播照常应用', () => {
  // 这条防的是「一刀切丢弃整批广播」的错误实现
});

it('SSE 重连后会全量补拉 marks', () => {
  // 断开 -> 期间远端改了 -> 重连 -> 断言发起了 GET /api/library/marks 且状态收敛
});

it('收到 kicked 后显示阻断层，且不再发出任何请求', () => { /* ... */ });
it('收到 share-ended 后显示的文案与 kicked 不同', () => { /* ... */ });
```

- [ ] **Step 2-6:** 红 -> 实现 -> 绿 -> 突变验证 -> 提交

---

## Task 18: 分享面板

**Files:** Create `web/src/components/SharePanel.tsx`；Modify `web/src/components/TopBar.tsx`；
Test `web/src/components/SharePanel.test.tsx`

- 当前库的分享列表（标签、有效期、在线人数、复制链接）
- 新建：标签、有效期预设（24 小时 / 7 天 / 30 天 / 永不）、默认角色、是否允许新成员
- 链接显示为完整 URL；多网卡时列出候选地址让人选，**不猜**
- **必须显著提示：这个链接就是密码，拿到的人都能进**

- [ ] **Step 1: 写失败测试**

```tsx
it('面板里出现「链接即密码」的风险提示', async () => { /* ... */ });
it('未开启 --share 时提示需要重启并给出命令，而不是给一个连不上的 localhost 链接', async () => {
  // 给客户发一条 http://127.0.0.1:5173/s/xxx 的链接是纯粹的挫败
});
it('多网卡时列出全部候选地址，不自动选一个', async () => { /* ... */ });
it('有效期预设换算正确（24 小时 = now + 86400000）', async () => { /* ... */ });
```

- [ ] **Step 2-6:** 红 -> 实现 -> 绿 -> 突变验证 -> 提交

---

## Task 19: 管理后台

**Files:** Create `web/src/admin/{AdminApp,ShareList,UserList,EventLog}.tsx`；
Test `web/src/admin/AdminApp.test.tsx`

三栏：分享列表 -> 该分享的用户 -> 操作日志。
用户行内切换 只读 / 可操作，即时生效。日志支持按 actor 与 action 过滤、倒序、导出 CSV。

- [ ] **Step 1: 写失败测试**

```tsx
it('角色切换后立即发出 PATCH，并乐观更新', async () => { /* ... */ });
it('删除用户前有二次确认（令牌立即失效不可撤销）', async () => { /* ... */ });
it('撤销分享前有二次确认，并说明在线访客会被断开', async () => { /* ... */ });
it('日志表分页不丢行，过滤条件叠加正确', async () => { /* ... */ });
it('界面上任何位置都不显示令牌', async () => { /* 渲染后全文搜索 */ });
```

- [ ] **Step 2-6:** 红 -> 实现 -> 绿 -> 突变验证 -> 提交

---

## Task 20: 归属显示与扫描进度

**Files:** Modify `web/src/components/{Thumb,Grid}.tsx`、`web/src/App.tsx`；
Test 相应 `.test.tsx`

- 缩略图角标显示最后修改者的色块（数据来自 `marksMeta`），悬停出昵称与时间
- 扫描进度条（Task 12 的 SSE `scan` 事件）

- [ ] **Step 1: 写失败测试**

```tsx
it('marksMeta 缺失时不显示角标，也不报错', async () => { /* 旧文件夹 */ });
it('同一 userId 的色块颜色在整个界面里一致', async () => { /* ... */ });
it('扫描阶段显示累计数量，完成后进度条消失', async () => { /* ... */ });
it('扫描失败时退回选择器并显示原因', async () => { /* ... */ });
```

- [ ] **Step 2-6:** 红 -> 实现 -> 绿 -> 突变验证 -> 提交

---

## Task 21: 文档与验收清单

**Files:** Modify `README.md`；Create `docs/acceptance-collaborative.md`

README 必须写清楚：

- `--share` 的用法与**局域网可见性告警**
- 默认 HTTP 明文：同网段可被抓包，照片和 Cookie 都在内（规格 9.2 节）
- **链接即密码**，转发给谁谁就能进；有效期 / 撤销 / 人数上限 / 关闭新成员 四个闸门
- 反向代理后面回环判定失效，必须用 `--admin-token`
- 访客永远不能导出，这是硬编码
- `~/.photocull/` 存了什么、为什么是 0700

**并且必须保留上一阶段那条诚实声明并扩写：**

> 本程序**从未对着真实照片库运行过**，协同功能也**从未在两台真实设备之间跑过**。
> 自动化测试证明的是权限矩阵与冲突收敛逻辑，不是三千张真实 RAW 在读卡器上的表现，
> 也不是两个人同时标记时的实际体感。

**人工验收清单（必须真机执行过才谈得上交付）：**

- [ ] 两台真机、同一局域网、同时标记同一批照片
- [ ] 断网 30 秒再恢复，两端收敛到一致
- [ ] 电脑浏览器上的访客界面
- [ ] 链接被转发后仍可用（这是功能，也是必须让摄影师理解的风险）
- [ ] 管理员改角色，访客端立即变灰
- [ ] 撤销分享，在线访客立即被阻断
- [ ] 审计日志导出 CSV，用文本编辑器打开确认无令牌
- [ ] 承自上一阶段、**至今未执行**的单机验收：3000 对真实照片、
      读卡器路径、滚动条拖动、三分钟内存曲线、重启后秒开

- [ ] **Step 1-2: 写文档并提交**
