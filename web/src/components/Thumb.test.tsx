import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Thumb } from './Thumb';
import { PresenceBar } from './PresenceBar';
import { useMarks } from '../store/marks';
import { useView } from '../store/view';
import { setSession, useSession } from '../store/session';
import { avatarColor } from '../lib/avatar';
import type { Asset } from '../types';

// 缩略图整条链路（fetch → Blob → createObjectURL）在 jsdom 里既跑不通也不是
// 这里要验的东西。换成一个不出图的替身，格子照常渲染骨架。
vi.mock('../lib/thumbSource', () => ({
  useThumb: () => ({ url: null, failed: false }),
  reprioritizeThumbs: vi.fn(),
  clearThumbCache: vi.fn(),
  thumbUrl: (id: string) => `/api/thumb?id=${id}`,
  originalUrl: (id: string) => `/api/original?id=${id}`,
}));

const ASSET: Asset = {
  id: 'IMG_0002', dir: '', stem: 'IMG_0002',
  raws: ['IMG_0002.CR3'], jpg: 'IMG_0002.JPG', jpgSize: 1, jpgMtimeMs: 1,
};

/** 2026-07-27 14:05 本地时间。断言也用本地时间拼，不受跑测机器的时区影响。 */
const AT = new Date(2026, 6, 27, 14, 5, 30).getTime();

const renderThumb = () => render(<Thumb asset={ASSET} priority={0} visible />);
const badgeOf = (container: HTMLElement) => container.querySelector('.thumb-by') as HTMLElement | null;

/** jsdom 的 CSSOM 把 hsl() 归一化成 rgb()，参照值必须走同一遍归一化才比得了。 */
function normalized(color: string): string {
  const probe = document.createElement('div');
  probe.style.background = color;
  return probe.style.backgroundColor;
}

beforeEach(() => {
  useMarks.getState().load({});
  useView.getState().reset();
  setSession({ kind: 'none', user: null, share: null, online: [] });
});

afterEach(() => {
  cleanup();
});

describe('归属角标（Task 20）', () => {
  // 旧文件夹、以及一直单机用的文件夹，marks.json 里根本没有 marksMeta 这个字段
  // （server/lib/store.js 对它按空表处理）。那是**常态**，不是异常：
  // 角标不显示就对了，但绝不能因此炸掉整个网格。
  it('marksMeta 缺失时不显示角标，也不报错', () => {
    useMarks.getState().load({ IMG_0002: 'pick' });   // 只有标记，没有归属表

    const { container } = renderThumb();

    expect(badgeOf(container)).toBeNull();
    expect(container.querySelector('.thumb')).toBeTruthy();
    expect(container.querySelector('.badge-pick')).toBeTruthy();   // 标记本身照常显示
  });

  it('marksMeta 里没有这一张时同样不显示角标', () => {
    useMarks.getState().load(
      { IMG_0002: 'pick', OTHER: 'pick' },
      { OTHER: { by: 'u_1', at: AT } },
    );
    const { container } = renderThumb();
    expect(badgeOf(container)).toBeNull();
  });

  it('有归属时显示一个色块，颜色由 userId 派生', () => {
    // 昵称必须从 roster 查（Task 21）：online 只回答在不在线，不再兼职当名册用。
    setSession({
      online: [{ id: 'u_2c7b', nickname: '新娘小林', role: 'editor' }],
      roster: [{ id: 'u_2c7b', nickname: '新娘小林' }],
    });
    useMarks.getState().load({ IMG_0002: 'pick' }, { IMG_0002: { by: 'u_2c7b', at: AT } });

    const { container } = renderThumb();
    const badge = badgeOf(container)!;

    expect(badge).toBeTruthy();
    expect(badge.style.backgroundColor).toBe(normalized(avatarColor('u_2c7b')));
    expect(badge.style.backgroundColor).not.toBe('');
    expect(badge.textContent).toBe('新');   // 首字来自昵称
  });

  // 规格 §7.5：颜色由 userId 哈希得到、稳定不变。成员条和角标是同一个人的
  // 两个出场位置，颜色对不上的话色块就白挂了——谁也没法靠它认人。
  it('同一 userId 的色块颜色在整个界面里一致', () => {
    setSession({ online: [{ id: 'u_2c7b', nickname: '新娘小林', role: 'editor' }] });
    useMarks.getState().load({ IMG_0002: 'pick' }, { IMG_0002: { by: 'u_2c7b', at: AT } });

    const { container } = render(<><PresenceBar /><Thumb asset={ASSET} priority={0} visible /></>);

    const dot = container.querySelector('.presence-dot') as HTMLElement;
    const badge = badgeOf(container)!;
    expect(dot.style.backgroundColor).not.toBe('');
    expect(badge.style.backgroundColor).toBe(dot.style.backgroundColor);
  });

  it('不同的人得到不同的颜色（角标得能区分人）', () => {
    useMarks.getState().load({ IMG_0002: 'pick' }, { IMG_0002: { by: 'u_1', at: AT } });
    const first = renderThumb();
    const a = badgeOf(first.container)!.style.backgroundColor;
    cleanup();

    useMarks.getState().load({ IMG_0002: 'pick' }, { IMG_0002: { by: 'u_2', at: AT } });
    const second = renderThumb();
    expect(badgeOf(second.container)!.style.backgroundColor).not.toBe(a);
  });

  it('悬停出昵称与时间', () => {
    // 昵称必须从 roster 查（Task 21）：online 只回答在不在线，不再兼职当名册用。
    setSession({
      online: [{ id: 'u_2c7b', nickname: '新娘小林', role: 'editor' }],
      roster: [{ id: 'u_2c7b', nickname: '新娘小林' }],
    });
    useMarks.getState().load({ IMG_0002: 'pick' }, { IMG_0002: { by: 'u_2c7b', at: AT } });

    const badge = badgeOf(renderThumb().container)!;

    expect(badge.title).toContain('新娘小林');
    expect(badge.title).toContain('2026-07-27 14:05');
  });

  it('管理员的归属显示成「摄影师」，而不是一个裸的 admin', () => {
    useMarks.getState().load({ IMG_0002: 'reject' }, { IMG_0002: { by: 'admin', at: AT } });

    const badge = badgeOf(renderThumb().container)!;

    expect(badge.title).toContain('摄影师');
    expect(badge.title).not.toContain('admin');
  });

  // 标记会留在文件里，人却会走。名单里查不到的 userId 是常态而不是异常，
  // 这时候宁可说「不知道是谁」，也不能把角标算到还在线的另一个人头上。
  it('归属的人已经不在线时不炸，也不冒认成别人', () => {
    setSession({ online: [{ id: 'u_still_here', nickname: '伴娘', role: 'editor' }] });
    useMarks.getState().load({ IMG_0002: 'pick' }, { IMG_0002: { by: 'u_gone', at: AT } });

    const badge = badgeOf(renderThumb().container)!;

    expect(badge).toBeTruthy();
    expect(badge.title).not.toContain('伴娘');
    expect(badge.style.backgroundColor).toBe(normalized(avatarColor('u_gone')));
  });

  it('自己做的标记显示自己的昵称（访客的 user 不一定在 online 快照里）', () => {
    setSession({ kind: 'user', user: { id: 'u_me', nickname: '我', role: 'editor' }, online: [] });
    useMarks.getState().load({ IMG_0002: 'pick' }, { IMG_0002: { by: 'u_me', at: AT } });

    expect(badgeOf(renderThumb().container)!.title).toContain('我');
  });

  it('别人清掉标记之后角标跟着消失', () => {
    setSession({ online: [{ id: 'u_1', nickname: '甲', role: 'editor' }] });
    useMarks.getState().load({ IMG_0002: 'pick' }, { IMG_0002: { by: 'u_1', at: AT } });
    const { container, rerender } = renderThumb();
    expect(badgeOf(container)).toBeTruthy();

    useMarks.getState().applyRemote({ IMG_0002: null });
    rerender(<Thumb asset={ASSET} priority={0} visible />);

    expect(badgeOf(container)).toBeNull();
  });
});

describe('缩略图上不再放收藏/排除按钮', () => {
  const asEditor = () => setSession({
    kind: 'user',
    user: { id: 'u_1', nickname: '小林', role: 'editor' },
    share: null, online: [],
  });

  it('可写时也不渲染 ✓/✕ 角标', () => {
    asEditor();
    const { container, queryByLabelText } = renderThumb();
    expect(container.querySelector('.thumb-check')).toBeNull();
    expect(queryByLabelText('收藏')).toBeNull();
    expect(queryByLabelText('排除')).toBeNull();
  });

  it('点整格是选中这一张', () => {
    asEditor();
    const { container } = renderThumb();
    fireEvent.click(container.querySelector('figure')!);
    expect(useView.getState().cursor).toBe('IMG_0002');
    expect(useView.getState().selection.has('IMG_0002')).toBe(true);
  });

  it('⌘/Ctrl 点是加减选区，不把光标挪走', () => {
    asEditor();
    useView.getState().setCursor('IMG_0001');
    const { container } = renderThumb();
    fireEvent.click(container.querySelector('figure')!, { metaKey: true });
    expect(useView.getState().selection.has('IMG_0002')).toBe(true);
    expect(useView.getState().cursor).toBe('IMG_0001');
  });
});

it('标记者已经离线时，头像仍然显示他的昵称而不是问号', () => {
  // 这是上报的 bug：客户选完照片关掉网页，管理员视图里他标过的照片
  // 头像变成了 '?'。marksMeta 和 users.json 都还在，只是前端查错了地方。
  useSession.setState({
    kind: 'admin',
    online: [],                                            // 人已经走了
    roster: [{ id: 'u_bride', nickname: '新娘' }],          // 但名册还记着
  });
  useMarks.setState({ marks: { IMG_0002: 'pick' }, marksMeta: { IMG_0002: { by: 'u_bride', at: 1 } } });

  const { getByRole } = renderThumb();
  const badge = getByRole('img', { name: /最后修改/ });
  expect(badge.textContent).toBe('新');
  expect(badge.getAttribute('aria-label')).toContain('新娘');
  expect(badge.textContent).not.toBe('?');
});

/**
 * 「已隐藏」视图里，格子右下角的 ✓/✕ 换成一个取消隐藏按钮。
 *
 * 换而不是并列：在这个 tab 里打标记会触发不变量 3（自动取消隐藏），
 * 照片当场从眼前消失。把这个后果藏在一个看起来只是"标记"的按钮后面是误导。
 */
describe('Thumb：「已隐藏」视图里的取消隐藏按钮', () => {
  it('站在「已隐藏」tab 上时有取消隐藏按钮', () => {
    setSession({ kind: 'admin', user: null, share: null, online: [] });
    useView.setState({ tab: 'hidden' });

    const { getByLabelText } = renderThumb();

    expect(getByLabelText('取消隐藏')).toBeTruthy();
  });

  it('别的 tab 上没有这个按钮', () => {
    setSession({ kind: 'admin', user: null, share: null, online: [] });
    useView.setState({ tab: 'all' });

    const { queryByLabelText } = renderThumb();

    expect(queryByLabelText('取消隐藏')).toBeNull();
  });

  it('「已隐藏」tab 上不再显示 ✓/✕', () => {
    setSession({ kind: 'admin', user: null, share: null, online: [] });
    useView.setState({ tab: 'hidden' });

    const { queryByLabelText } = renderThumb();

    expect(queryByLabelText('收藏')).toBeNull();
    expect(queryByLabelText('排除')).toBeNull();
  });

  it('访客即使站在 hidden tab 上也没有这个按钮', () => {
    // 三道防线的第二道。访客本来就切不到这个 tab（TopBar 不渲染它），
    // 但 tab 是 view store 里一个普通字段，这一条钉的是"就算它以别的
    // 路径变成了 hidden，按钮也不出现"。
    setSession({
      kind: 'user', user: { id: 'u_ab', nickname: '小林', role: 'editor' },
      share: null, online: [],
    });
    useView.setState({ tab: 'hidden' });

    const { queryByLabelText } = renderThumb();

    expect(queryByLabelText('取消隐藏')).toBeNull();
  });

  it('点它发起取消隐藏，且不冒泡去改光标', () => {
    setSession({ kind: 'admin', user: null, share: null, online: [] });
    useView.setState({ tab: 'hidden', cursor: null });
    useMarks.getState().load({}, undefined, [ASSET.id]);

    const { getByLabelText } = renderThumb();
    fireEvent.click(getByLabelText('取消隐藏'));

    expect(useMarks.getState().hidden.has(ASSET.id)).toBe(false);
    // stopPropagation：格子本身的 onClick 会 setCursor。少了它，点"取消隐藏"
    // 会顺带把光标挪过来，而这张照片下一瞬间就从这个 tab 里消失了。
    expect(useView.getState().cursor).toBeNull();
  });
});
