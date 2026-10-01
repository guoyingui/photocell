import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Notice } from './components/Notice';

// 仓库里没有 DOM 测试环境（vitest 的 environment 是 node，include 只收 .ts），
// 这里用 SSR 静态渲染断言"到底渲染出了什么"。Notice 是纯展示组件、状态全靠 props，
// 所以不受 zustand 在 SSR 下只给 getInitialState 的影响。
const html = (props: Parameters<typeof Notice>[0]) =>
  renderToStaticMarkup(createElement(Notice, props));

const noop = () => {};

describe('I9 — marksRecovered 与 skippedFiles 必须真的显示出来', () => {
  it('从备份恢复过标记时给出明确提示（规格 §7）', () => {
    const out = html({ marksRecovered: true, skippedFiles: 0, onDismiss: noop });
    expect(out).toContain('marks.bak.json');
    expect(out).toContain('请先核对一遍收藏和排除再导出');
    expect(out).toContain('notice-warn');   // 恢复过是要抬眼看的，不是普通提示
  });

  it('跳过的非照片文件数显示出来（规格 §3.2）', () => {
    const out = html({ marksRecovered: false, skippedFiles: 12, onDismiss: noop });
    expect(out).toContain('已跳过 12 个非照片文件');
  });

  it('两件事同时发生时都要说，不能只说一件', () => {
    const out = html({ marksRecovered: true, skippedFiles: 3, onDismiss: noop });
    expect(out).toContain('marks.bak.json');
    expect(out).toContain('已跳过 3 个非照片文件');
  });

  it('有提示时带一个"知道了"按钮', () => {
    expect(html({ marksRecovered: true, skippedFiles: 0, onDismiss: noop })).toContain('知道了');
  });

  it('两条都没有时整条提示不渲染，不占位', () => {
    expect(html({ marksRecovered: false, skippedFiles: 0, onDismiss: noop })).toBe('');
  });
});
