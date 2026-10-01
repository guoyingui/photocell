import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../server/public', emptyOutDir: true },
  server: {
    port: 5173,
    // `changeOrigin: true` 是必须的，不是风格问题：服务端现在校验 `Host` 头
    // （server/middleware/host.js，防 DNS 重绑定），只接受本机地址 + **本连接的端口**。
    // 保留原始 Host 的话，转发过去的请求头里写着 `localhost:5173`，而它落在 5183 上，
    // 端口对不上 -> 每一条 /api 请求在开发模式下都 403 `bad-host`。
    // 改成 true 之后代理把 Host 重写成 target 的 `127.0.0.1:5183`，与实际落点一致。
    proxy: { '/api': { target: 'http://127.0.0.1:5183', changeOrigin: true } },
  },
});
