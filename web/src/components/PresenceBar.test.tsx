import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PresenceBar } from './PresenceBar';
import { fireEvent } from '@testing-library/react';
import { setSession } from '../store/session';
import { useSession } from '../store/session';
import { useMarks } from '../store/marks';
import { useView } from '../store/view';
import { avatarColor } from '../lib/avatar';

beforeEach(() => {
  setSession({ kind: 'none', user: null, share: null, online: [] });
  useSession.setState({ roster: [] });
  useMarks.getState().load({});
  useView.getState().reset();
});

afterEach(() => {
  cleanup();
});

describe('PresenceBar', () => {
  it('没有人在线时什么都不渲染（单机流程不该多出一条空条子）', () => {
    const { container } = render(<PresenceBar />);
    expect(container.querySelector('.presence')).toBeNull();
  });

  it('每个在线成员一个条目，显示昵称首字', () => {
    setSession({
      online: [
        { id: 'admin', nickname: '摄影师', role: 'admin' },
        { id: 'u_1', nickname: '新娘小林', role: 'editor' },
      ],
    });
    render(<PresenceBar />);

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('摄影师')).toBeTruthy();
    expect(screen.getByText('新娘小林')).toBeTruthy();
  });

  it('色块颜色由 userId 派生，和 avatar.ts 是同一份判据', () => {
    setSession({ online: [{ id: 'u_2c7b', nickname: '伴娘', role: 'editor' }] });
    const { container } = render(<PresenceBar />);

    const dot = container.querySelector('.presence-dot') as HTMLElement;
    // jsdom 的 CSSOM 会把 hsl() 归一化成 rgb()，直接跟 avatarColor 的返回值
    // 比字符串必然对不上。让参照值走同一遍归一化，比的就是颜色本身。
    const probe = document.createElement('div');
    probe.style.background = avatarColor('u_2c7b');

    expect(dot.style.backgroundColor).toBe(probe.style.backgroundColor);
    expect(dot.style.backgroundColor).not.toBe('');
  });

  it('不同的 userId 得到不同的颜色（色块得能区分人）', () => {
    setSession({
      online: [
        { id: 'u_1', nickname: '甲', role: 'editor' },
        { id: 'u_2', nickname: '乙', role: 'editor' },
      ],
    });
    const { container } = render(<PresenceBar />);
    const dots = [...container.querySelectorAll('.presence-dot')] as HTMLElement[];
    expect(dots[0].style.backgroundColor).not.toBe(dots[1].style.backgroundColor);
  });

  it('昵称是 emoji 或中文时首字不会被切成半个码点', () => {
    setSession({ online: [{ id: 'u_3', nickname: '🎏小满', role: 'editor' }] });
    const { container } = render(<PresenceBar />);
    expect(container.querySelector('.presence-dot')?.textContent).toBe('🎏');
  });

  it('把「你」标出来——一屏几个色块里得认得出哪个是自己', () => {
    setSession({
      kind: 'user',
      user: { id: 'u_1', nickname: '新娘小林', role: 'editor' },
      online: [
        { id: 'u_1', nickname: '新娘小林', role: 'editor' },
        { id: 'u_2', nickname: '伴娘', role: 'editor' },
      ],
    });
    render(<PresenceBar />);

    const me = screen.getAllByRole('listitem').find((li) => li.className.includes('presence-me'));
    expect(me?.textContent).toContain('新娘小林');
  });

  it('只读成员标出只读——摄影师需要一眼看出谁按 P 是没反应的', () => {
    setSession({
      online: [
        { id: 'u_1', nickname: '新娘小林', role: 'viewer' },
        { id: 'u_2', nickname: '伴娘', role: 'editor' },
      ],
    });
    render(<PresenceBar />);

    // 按名字取，不按下标：成员条现在是排过序的（在线在前、同组按昵称），
    // 下标查询会跟着排序规则一起变，测的就不再是「谁被标成只读」这件事。
    const items = screen.getAllByRole('listitem');
    const byName = (n: string) => items.find((el) => el.title.startsWith(n))!;
    expect(byName('新娘小林').title).toContain('只读');
    expect(byName('伴娘').title).not.toContain('只读');
  });

  it('成员条有可访问的名字，屏幕阅读器不会读成一堆孤立字符', () => {
    setSession({ online: [{ id: 'u_1', nickname: '新娘小林', role: 'editor' }] });
    render(<PresenceBar />);
    expect(screen.getByRole('list', { name: '成员' })).toBeTruthy();
  });
});

/**
 * Task 22：离线的人不消失，头像可点按人筛选。
 *
 * 上报的 bug 有两半：客户关掉网页之后照片上的头像变成问号（Task 21 修的），
 * 以及**整条成员条直接消失**——而他标过的照片还挂在网格里，管理员没有任何
 * 入口能按他筛。这一组钉的是后一半。
 */
describe('PresenceBar：离线成员与按人筛选', () => {
  const bride = { id: 'u_bride', nickname: '新娘' };
  const asAdmin = () => setSession({ kind: 'admin', user: null, share: null, online: [] });

  it('人都走光了，标过照片的仍然留在条上并灰掉', () => {
    asAdmin();
    useSession.setState({ roster: [bride] });
    useMarks.getState().load({}, undefined, undefined,
      { IMG_1: { u_bride: { mark: 'pick', at: 1 } } });

    render(<PresenceBar />);

    const item = screen.getByRole('listitem');
    expect(item.className).toContain('presence-off');
    expect(item.title).toContain('已离线');
  });

  it('离线且没标过的不显示', () => {
    asAdmin();
    useSession.setState({ roster: [bride] });
    render(<PresenceBar />);
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('点头像按这个人筛选，再点一下取消', () => {
    asAdmin();
    setSession({ online: [{ ...bride, role: 'editor' }] });
    render(<PresenceBar />);

    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    expect(useView.getState().clientFilter).toBe('u_bride');

    fireEvent.click(btn);
    expect(useView.getState().clientFilter).toBeNull();
  });

  it('正在按谁筛，那一格描一圈', () => {
    asAdmin();
    setSession({ online: [{ ...bride, role: 'editor' }] });
    useView.getState().setClientFilter('u_bride');
    render(<PresenceBar />);
    expect(screen.getByRole('listitem').className).toContain('presence-active');
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true');
  });

  it('访客那一侧整个不渲染成按钮，不是置灰', () => {
    // 三道防线的第二道。访客点了也没有意义——服务端根本不给他别人的 contrib，
    // 筛出来必然是空的。只读界面只展示有权限的操作。
    setSession({
      kind: 'user', user: { id: 'u_me', nickname: '我', role: 'editor' },
      share: null, online: [{ ...bride, role: 'editor' }],
    });
    render(<PresenceBar />);

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('listitem').textContent).toContain('新娘');
  });
});
