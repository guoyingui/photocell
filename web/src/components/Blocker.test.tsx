import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Blocker } from './Blocker';

afterEach(() => {
  cleanup();
});

describe('Blocker', () => {
  it('渲染 message，且带 role=alert 让屏幕阅读器立刻读出来', async () => {
    render(<Blocker message="链接不存在或已失效" />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('链接不存在或已失效');
  });

  it('不传 title 时给一个通用标题，而不是空白', async () => {
    render(<Blocker message="随便什么原因" />);
    expect(screen.getByText('无法继续')).toBeTruthy();
  });

  it('title 可以被调用方覆盖（Task 17 的 kicked / share-ended 会传不同文案）', async () => {
    render(<Blocker title="你已被移出" message="管理员结束了你的访问" />);
    expect(screen.getByText('你已被移出')).toBeTruthy();
  });

  it('detail 是可选的：不传就不渲染任何补充说明节点', async () => {
    const { container } = render(<Blocker message="链接不存在或已失效" />);
    expect(container.querySelector('.blocker-detail')).toBeNull();
  });

  it('传了 detail 就渲染出来', async () => {
    render(<Blocker message="链接不存在或已失效" detail="请向摄影师索要新链接。" />);
    expect(screen.getByText('请向摄影师索要新链接。')).toBeTruthy();
  });
});
