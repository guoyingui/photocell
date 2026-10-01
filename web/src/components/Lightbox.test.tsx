import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Lightbox } from './Lightbox';
import { useMarks } from '../store/marks';
import { useView } from '../store/view';
import { originalUrl, thumbUrl } from '../lib/thumbSource';
import type { Asset } from '../types';

const ASSET: Asset = {
  id: 'IMG_0002', dir: '', stem: 'IMG_0002',
  raws: ['IMG_0002.CR3'], jpg: 'IMG_0002.JPG', jpgSize: 1, jpgMtimeMs: 1,
};
const ORDER = ['IMG_0002'];
const BY_ID = new Map([['IMG_0002', ASSET]]);

const HINT_FIT = '滚轮缩放 · 双击放大 · ←→ 翻页 · P 收藏 · X 排除 · Esc 退出';

// 底部提示 <span className="muted"> 在 .lb-bar 里出现两次（位置指示 + 这条提示，
// 见 Lightbox.tsx 的 JSX 与 styles.css 里 `.lb-bar > .muted:last-of-type` 那条
// 专门用来选中后一个的规则）。这里同样取最后一个，不依赖具体下标。
const hint = (container: HTMLElement) =>
  [...container.querySelectorAll('.muted')].at(-1)?.textContent;

const renderLightbox = () => render(<Lightbox order={ORDER} byId={BY_ID} />);

beforeEach(() => {
  useMarks.getState().load({});
  useView.getState().reset();
});

// 本仓库没有 test.globals，testing-library 的自动 cleanup 不会注册，
// 不写这一句 DOM 会跨用例泄漏。
afterEach(() => { cleanup(); });

describe('Lightbox', () => {
  it('lightbox 为空时什么都不渲染', () => {
    // beforeEach 的 reset() 把 lightbox 留在 null，不用再显式关一次。
    const { container } = renderLightbox();
    expect(container.firstChild).toBeNull();
  });

  // 这是 Task 9 最容易被后人无意中撤销的一条：stage 原来的 onClick 会在
  // 贴合/1:1 之间切换，Task 9 特意删掉了它——因为它和拖拽平移天然打架，
  // 拖完松手那一下 click 会让图片当场跳回贴合。背景点击关闭是另一条独立
  // 通路（.lightbox 自己的 onClick，用 e.target === e.currentTarget 判断），
  // 不受这次改动影响，顺带在这里钉住做回归网。
  it('点 stage 不关闭、也不切换缩放；点背景仍然关闭', () => {
    useView.getState().openLightbox('IMG_0002');
    const { container } = renderLightbox();
    const stage = container.querySelector('.lb-stage')!;

    fireEvent.click(stage);

    expect(useView.getState().lightbox).toBe('IMG_0002');
    expect(hint(container)).toBe(HINT_FIT);
    expect(container.querySelector('img')!.getAttribute('src'))
      .toBe(thumbUrl('IMG_0002', 'preview'));

    fireEvent.click(container.querySelector('.lightbox')!);
    expect(useView.getState().lightbox).toBeNull();
  });

  it('双击 stage 在贴合与放大之间切换', () => {
    useView.getState().openLightbox('IMG_0002');
    const { container } = renderLightbox();
    const stage = container.querySelector('.lb-stage')!;

    fireEvent.doubleClick(stage);
    expect(hint(container)).toBe('2.0× — 拖拽平移，双击回到贴合');

    fireEvent.doubleClick(stage);
    expect(hint(container)).toBe(HINT_FIT);
  });

  it('放大之后 img 的 src 切到原图，贴合状态下用 preview', () => {
    useView.getState().openLightbox('IMG_0002');
    const { container } = renderLightbox();
    const stage = container.querySelector('.lb-stage')!;
    const img = () => container.querySelector('img')!;

    expect(img().getAttribute('src')).toBe(thumbUrl('IMG_0002', 'preview'));

    fireEvent.doubleClick(stage);
    expect(img().getAttribute('src')).toBe(originalUrl('IMG_0002'));
  });
});

describe('Lightbox 关闭按钮', () => {
  it('右上角有一个带 aria-label 的关闭按钮', () => {
    useView.getState().openLightbox('IMG_0002');
    const { getByLabelText } = renderLightbox();
    expect(getByLabelText('关闭')).toBeTruthy();
  });

  it('点它就关掉大图', () => {
    useView.getState().openLightbox('IMG_0002');
    const { getByLabelText } = renderLightbox();
    fireEvent.click(getByLabelText('关闭'));
    expect(useView.getState().lightbox).toBeNull();
  });

  it('底部信息条里那个「关闭」已经不在了', () => {
    // 两个关闭按钮是冗余，而右上角是所有人看图时找关闭的第一个地方。
    useView.getState().openLightbox('IMG_0002');
    const { queryByText } = renderLightbox();
    expect(queryByText('关闭')).toBeNull();   // 文本形式的那个按钮
  });
});
