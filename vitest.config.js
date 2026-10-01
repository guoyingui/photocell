import { defineConfig } from 'vitest/config';

// 服务端测试要用真实 fs / net，被拖进 jsdom 会出各种怪问题；前端组件测试则
// 反过来必须有 DOM 才能渲染。计划文档编写时 vitest 还有 environmentMatchGlobs
// 可以按路径直接分派环境，但当前安装的 vitest 4.1.10 已经把它整个移除了
// （4.x 把这类"同一份配置、不同文件用不同环境"的需求统一收进了 test.projects）。
// 这里用 projects 复刻同样的效果：两个 project 分别声明自己的 include + environment。
//
// 注意：一旦声明了 projects，根级的 test.include 就不再被直接执行——Vitest 只跑
// projects 数组里列出的那些。所以下面两个 project 的 include 合起来必须覆盖
// 全部测试文件，少列一个 glob 就会有文件被无声跳过（vitest run 不报错，只是
// 那些用例再也不会被执行）。
export default defineConfig({
  test: {
    testTimeout: 20000,
    projects: [
      {
        extends: true,
        test: {
          name: 'server-node',
          include: ['server/**/*.test.js', 'web/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'web-dom',
          include: ['web/src/**/*.test.tsx'],
          environment: 'jsdom',
        },
      },
    ],
  },
});
