import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { ZoomSlider } from './ZoomSlider';
import { useLibrary } from '../store/library';

beforeEach(() => {
  vi.useFakeTimers();
  useLibrary.setState({ settings: { burstThresholdMs: 1000, cellWidth: 210, sort: 'time' } });
});
// cleanup() 是本文件相对 brief 唯一的出入：vitest.config.js 没开 test.globals，
// @testing-library/react 的自动清理靠探测全局 afterEach 注册，探测不到就不生效
// （见 TopBar.test.tsx / GuestApp.test.tsx 等每一个既有 .tsx 用例文件都手动调它）。
// 没有这一行，三个 it 各自 render 一次 <ZoomSlider /> 却互不清场，第二个 it 开始
// getByLabelText 就会因为 DOM 里同时存在多个「网格缩放」而报"找到多个元素"，
// 而不是这条用例本来要测的东西。
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('ZoomSlider', () => {
  it('拖动立刻改本地状态', () => {
    const { getByLabelText } = render(<ZoomSlider />);
    fireEvent.change(getByLabelText('网格缩放'), { target: { value: '300' } });
    expect(useLibrary.getState().settings.cellWidth).toBe(300);
  });

  it('连续拖动只在停下之后发一次请求', async () => {
    // 滑块是连续拖动的，每帧发一个请求会把服务端捶烂，
    // 而且每一次都要走 markStore 的防抖落盘。
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, settings: {} }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    );
    const { getByLabelText } = render(<ZoomSlider />);
    const slider = getByLabelText('网格缩放');

    fireEvent.change(slider, { target: { value: '240' } });
    fireEvent.change(slider, { target: { value: '260' } });
    fireEvent.change(slider, { target: { value: '280' } });
    expect(fetchSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    const settingsCalls = fetchSpy.mock.calls.filter(
      ([url]) => String(url).includes('/api/library/settings'));
    expect(settingsCalls).toHaveLength(1);
    expect(JSON.parse(String(settingsCalls[0][1]?.body))).toEqual({ cellWidth: 280 });
  });

  it('滑块的上下界就是服务端认的那两个数', () => {
    const { getByLabelText } = render(<ZoomSlider />);
    const slider = getByLabelText('网格缩放') as HTMLInputElement;
    expect(slider.min).toBe('120');
    expect(slider.max).toBe('420');
  });
});
