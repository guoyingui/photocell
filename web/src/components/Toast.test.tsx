import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toast } from './Toast';
import { useMarks } from '../store/marks';
import { clearToast, showToast } from '../store/notice';
import { setSession } from '../store/session';

// 三条提示共用同一个角落，同时只能显示一条，所以「谁压过谁」是一个设计决定
// 而不是实现细节：错误 > 一次性提示 > 撤销提示。三条用例各钉住一档，
// 顺序被人调换时必须有东西变红。
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
  useMarks.getState().load({});
  setSession({ kind: 'admin', user: null });
  clearToast();
});

// 本仓库没有 test.globals，testing-library 的自动 cleanup 不会注册。
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Toast 的优先级', () => {
  it('只有撤销提示时显示它（对照组）', () => {
    useMarks.getState().setMark(['a'], 'pick');
    const { container, queryByRole } = render(<Toast />);
    expect(container.textContent).toContain('已更新 1 张');
    expect(queryByRole('button', { name: /撤销/ })).toBeTruthy();
  });

  it('一次性提示压过撤销提示', () => {
    // 这两条说的是同一次操作：撤销提示报的是成功的那部分（"已更新 N 张"），
    // 一次性提示解释的是**剩下那部分为什么没生效**。两条一起冒出来，
    // 用户不知道该看哪句。
    useMarks.getState().setMark(['a'], 'pick');
    showToast('已标记的照片不能隐藏，先取消标记');
    const { container, queryByRole } = render(<Toast />);
    expect(container.textContent).toBe('已标记的照片不能隐藏，先取消标记');
    expect(queryByRole('button', { name: /撤销/ })).toBeNull();
  });

  it('错误压过一次性提示', () => {
    // 错误要用户去处理，而且只有手动才关得掉；一次性提示 3 秒后自己就走了。
    showToast('已标记的照片不能隐藏，先取消标记');
    useMarks.setState({ error: '隐藏未能保存：写不进去' });
    const { container } = render(<Toast />);
    expect(container.querySelector('.toast-error')).toBeTruthy();
    expect(container.textContent).toContain('隐藏未能保存：写不进去');
    expect(container.textContent).not.toContain('已标记的照片不能隐藏');
  });

  it('权限改为只读后撤销提示不再提供写入按钮', () => {
    setSession({ kind: 'user', user: { id: 'guest', nickname: '访客', role: 'editor' } });
    useMarks.getState().setMark(['a'], 'pick');
    const { queryByRole } = render(<Toast />);
    expect(queryByRole('button', { name: /撤销/ })).toBeTruthy();
    act(() => setSession({ user: { id: 'guest', nickname: '访客', role: 'viewer' } }));
    expect(queryByRole('button', { name: /撤销/ })).toBeNull();
  });
});
