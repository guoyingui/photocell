# PhotoCull 仓库指南

PhotoCull 是面向电脑浏览器、使用鼠标与键盘操作的 RAW/JPG Web 选片工具，支持本地浏览、标记、导出和访客协同选片。
前端使用 React、TypeScript、Vite 和 Zustand；服务端是 Node.js ESM + Express；桌面版通过 Tauri 启动同一份 Node 服务。

## 代码位置

- `server/index.js`：应用装配、API 挂载表、监听端口和桌面就绪协议。
- `server/routes/`、`server/middleware/`：HTTP/SSE 接口、身份与权限、Host 校验。
- `shared/`：前后端共用的纯逻辑（导出范围），不引入服务端或浏览器专属依赖。
- `server/lib/`：扫描配对、EXIF、缩略图、持久化、会话、分享和文件导出。
- `web/src/routes.tsx`：摄影师、访客、管理页面入口；对应 `App.tsx`、`guest/`、`admin/`。
- `web/src/components/`：共享界面；`store/`：Zustand 状态；`lib/`：API、实时同步和交互逻辑；`types.ts`：前端共享类型。
- `src-tauri/`、`desktop/splash/`、`scripts/`：桌面壳、启动页和打包流程。
- `deploy/`：Linux 打包与部署；`.github/workflows/desktop.yml`：macOS/Windows 安装包构建。
- `README.md`：当前使用方式；`docs/acceptance-collaborative.md`：人工验收；`docs/superpowers/`：历史设计与实施计划。历史计划可能落后于实现，修改前结合当前代码和测试核对。

## 开发命令

在仓库根目录执行。按 README 使用 Node 22.12+ 的 22.x 版本与 npm；依赖锁文件为 `package-lock.json`。

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 按锁文件安装依赖；`sharp` 包含平台相关的原生模块 |
| `npm run dev` | 同时启动 Vite 和 Node watch 服务 |
| `npm run dev:web` / `npm run dev:server` | 单独启动前端或服务端 |
| `npm run build` | 构建前端到 `server/public/` |
| `npm start` | 构建前端后启动服务 |
| `npm test` | 运行全部 Vitest 测试并退出 |
| `npm test -- server/routes/permissions.test.js` | 按文件运行测试，可替换路径 |
| `npm run test:watch` | 测试监听模式 |
| `npx tsc --noEmit` | 检查 `web/src` 类型，服务端 JS 不参与 |
| `npm run desktop:dev` | 启动 Tauri 桌面开发模式，需要 Rust 和平台构建环境 |
| `npm run desktop:build` | 构建桌面安装包，Tauri 钩子自动准备运行时 |

开发时访问 `http://127.0.0.1:5173`。Vite 将 `/api` 代理到 `127.0.0.1:5183`；保留 `changeOrigin: true`，否则服务端 Host 校验会拒绝请求。
服务端默认端口被占用时会尝试至 5199，Vite 代理目标不会随之自动改变。直接访问服务端看到的是上次构建产物。
开发分享功能时分别运行 `node server/index.js --share` 和 `npm run dev:web`；`npm run dev -- --share` 不会把开关传给服务端。

macOS/Windows 打包脚本为 `./scripts/build-desktop.sh [mac|win]`；Linux 为 `./deploy/build-linux.sh`，详见 `deploy/README.md` 和 `docs/部署到-Linux.md`。

## 实现约定

- 沿用现有两空格缩进、单引号、分号和 ESM 写法。服务端相对导入带 `.js`；前端使用 TypeScript/TSX、函数组件和 Zustand。
- 界面文案和项目说明主要使用中文；新增文案保持一致，错误提示说明用户能采取的操作。
- 复用 `web/src/lib/api.ts` 的请求与 SSE 封装，保留会话头和 `session-gone` 处理；`?sid=` 只用于 GET，写请求使用 `X-PhotoCull-Session`。
- 新增 `/api` 路由通过 `server/index.js` 的 `API_MOUNTS` 注册，并更新 `server/routes/permissions.test.js` 的权限矩阵。
- 保留 Host 校验、身份解析、默认拒绝和路由权限检查的顺序。默认监听回环地址，只有显式 `--share` 才开放网络访问；访客不能导出文件。
- 文件操作复用 `server/lib/safepath.js` 的路径边界检查。扫描不跟随符号链接；RAW/JPG 按同目录、忽略大小写的文件主名配对，修改资产 ID 逻辑时考虑已有标记兼容性。
- 排除和隐藏仅修改状态，不删除照片。移动导出必须保留「复制 → 校验大小 → 删除源文件」流程，以及服务端独立校验 `confirmCount` 的约束。
- 照片目录的 `.photocull/` 保存标记、设置和缩略图；用户家目录的 `~/.photocull/` 保存分享、用户和审计数据。修改持久化时维护已有数据兼容性。
- 筛选、隐藏、刷新和切库可能使光标、选区或大图失效；修改交互时同时核对键盘、鼠标和访客入口，避免操作作用于已不可见的照片。

## 验证方式

- 测试与代码就近放置：服务端 `*.test.js`，前端逻辑 `*.test.ts`，组件 `*.test.tsx`。
- `vitest.config.js` 定义两个项目：`server-node` 运行服务端测试和前端 `.test.ts`；`web-dom` 在 jsdom 中运行 `.test.tsx`。调整匹配规则时保持所有测试都被覆盖。
- Vitest 未启用全局 API；显式导入测试函数。组件测试显式调用 `cleanup()`，并重置 Zustand 状态、模拟和计时器。
- 文件系统测试使用临时目录。涉及分享或用户存储时将 `PHOTOCULL_HOME` 指向临时目录并在结束后恢复；关闭服务器、SSE 和会话，避免写入真实照片或用户数据。
- 权限测试需覆盖管理员、编辑者、只读访客及无身份请求。参考现有测试模拟访客来源地址，直接从回环发请求会被识别为管理员。
- 行为变更先运行相关测试；交付代码变更前运行 `npm test`，涉及前端时再运行 `npx tsc --noEmit` 和 `npm run build`。目前没有独立 lint 脚本。
- 纯文档修改核对路径、命令及差异即可。自动测试不替代真机验收；仅在实际操作并观察结果后勾选人工验收清单。

## 变更范围与产物

- 开始修改前检查工作区，保留已有未提交改动；避免顺带重构或格式化无关文件。
- 不手工编辑或提交生成目录：`server/public/`、`deploy/dist/`、`src-tauri/binaries/`、`src-tauri/resources/`、`src-tauri/.cache/`、`src-tauri/target/`，以及 `node_modules/` 和运行数据 `.photocull/`。
- 桌面和 Linux 包中的 Node、`sharp` 必须匹配目标平台；使用现有 staging/打包脚本，不直接复制开发机依赖。
- 用户可见行为或启动方式变化时同步 README；提交说明沿用现有 `feat:`、`fix:`、`docs:` 等前缀，交付时说明实际执行的验证及未覆盖部分。
