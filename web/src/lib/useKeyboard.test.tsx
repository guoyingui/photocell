import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useKeyboard } from './useKeyboard';
import { useMarks } from '../store/marks';
import { clearToast, useNotice } from '../store/notice';
import { useView } from '../store/view';
import { setSession } from '../store/session';
import type { Role } from '../store/session';

// 这个文件必须是 .test.tsx：vitest.config.js 里 `web/src/**/*.test.ts` 跑在
// node 环境（没有 window，装不上 keydown 监听器），只有 `*.test.tsx` 跑 jsdom。
// 计划里写的是 useKeyboard.test.ts，那个后缀会让整份用例连挂载都做不到。

const apiMock = vi.hoisted(() => ({
  putJSON: vi.fn(() => Promise.resolve({})),
}));

// marks/view 两个 store 都只从 lib/api 里拿 putJSON —— 标记写请求是这里唯一
// 关心的副作用，所以直接盯住它。其余导出给全，避免将来某个 store 多 import
// 一个函数就让整份用例在模块求值期炸掉。
vi.mock('./api', () => ({
  putJSON: apiMock.putJSON,
  getJSON: vi.fn(),
  postJSON: vi.fn(),
  openStream: vi.fn(() => () => {}),
  withSid: (u: string) => u,
  setSessionId: vi.fn(),
  getSessionId: vi.fn(() => null),
  setSessionGoneHandler: vi.fn(),
}));

const ORDER = ['IMG_0001', 'IMG_0002', 'IMG_0003'];

/** useKeyboard 是个 hook，挂在一个什么都不渲染的宿主上就够了。 */
function Harness() {
  useKeyboard(ORDER);
  return null;
}

function fireKey(key: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(document.body, { key, ...init });
}

/**
 * 同样是派发一次 keydown，但把事件本身交回来——「这一下有没有被吞掉」
 * （preventDefault）只能从它身上看，fireEvent 不给。
 */
function fireKeyEvent(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  return event;
}

function asGuest(role: Role) {
  setSession({
    kind: 'user',
    user: { id: 'u_1', nickname: '新娘小林', role },
    share: { label: '婚礼初选' },
  });
}

beforeEach(() => {
  apiMock.putJSON.mockClear();
  useMarks.getState().load({});
  useView.getState().reset();
  useView.getState().setCursor('IMG_0002');
  clearToast();
  setSession({ kind: 'none', user: null, share: null, online: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('只读门禁（安全属性）', () => {
  // P / X / U 只有键盘入口，没有按钮可以隐藏。服务端的 403 read-only 是第一道
  // 防线，useKeyboard 里的短路是第二道：只读的人按下去根本不该产生请求。
  it.each(['p', 'x', 'u'])('viewer 按 %s 不产生任何标记写请求', (key) => {
    asGuest('viewer');
    render(<Harness />);

    fireKey(key);

    // 断言的是「没发请求」，不是「按钮被隐藏」。
    expect(apiMock.putJSON).not.toHaveBeenCalled();
    // 乐观更新同样不该发生：先把界面改掉、等 403 回来再回滚，
    // 那一瞬间的「看起来我改成功了」正是最容易让人误判的状态。
    expect(useMarks.getState().marks).toEqual({});
    // 也不该「标记后自动前进一张」—— 什么都没标记，光标凭什么走。
    expect(useView.getState().cursor).toBe('IMG_0002');
  });

  // ── 对照组 ───────────────────────────────────────────────────────────────
  // 上面那条只断言「viewer 按键没反应」，它在键盘监听整个坏掉时也会通过。
  // 下面两条证明同一套装置在有写权限时确实会发请求。
  it('editor 按 P 会发出写请求（对照组）', () => {
    asGuest('editor');
    render(<Harness />);

    fireKey('p');

    expect(apiMock.putJSON).toHaveBeenCalledWith(
      '/api/library/marks', { marks: { IMG_0002: 'pick' } });
    expect(useMarks.getState().marks.IMG_0002).toBe('pick');
  });

  it('admin 按 X 会发出写请求（对照组）', () => {
    setSession({ kind: 'admin', user: null, share: null });
    render(<Harness />);

    fireKey('x');

    expect(apiMock.putJSON).toHaveBeenCalledWith(
      '/api/library/marks', { marks: { IMG_0002: 'reject' } });
  });

  it('身份还没解析出来时同样不写（默认拒绝）', () => {
    // kind: 'none' —— canWrite() 对它也是 false。判据是「能不能写」，
    // 不是「是不是 viewer」：后者是白名单外一律放行，方向反了。
    render(<Harness />);

    fireKey('p');

    expect(apiMock.putJSON).not.toHaveBeenCalled();
  });
});

describe('撤销也是写', () => {
  it('viewer 的 ⌘Z 不发写请求，editor 的会（对照组）', () => {
    // 撤销栈得先有东西，否则 undo() 自己就早退了 —— 那样的用例即使门禁
    // 整个不存在也会通过。先用 editor 身份标一张，把栈填上。
    asGuest('editor');
    render(<Harness />);
    fireKey('p');
    expect(apiMock.putJSON).toHaveBeenCalledTimes(1);
    expect(useMarks.getState().undoStack).toHaveLength(1);

    // 同一个撤销栈，换成只读身份：⌘Z 不该再产生第二次 PUT。
    asGuest('viewer');
    fireKey('z', { metaKey: true });
    expect(apiMock.putJSON).toHaveBeenCalledTimes(1);
    expect(useMarks.getState().marks.IMG_0002).toBe('pick');

    // 换回可写身份，同样的按键确实会撤销 —— 证明上一条不是因为撤销栈是空的。
    asGuest('editor');
    fireKey('z', { metaKey: true });
    expect(apiMock.putJSON).toHaveBeenCalledTimes(2);
    expect(useMarks.getState().marks.IMG_0002).toBeUndefined();
  });
});

describe('只读不等于键盘整个失效', () => {
  // 这是第二条对照组，方向和上面相反：证明短路是精准的，
  // 而不是「viewer 一进来就把 window 监听器整个拆了」。
  it('viewer 仍然可以用方向键移动光标', () => {
    asGuest('viewer');
    render(<Harness />);

    fireKey('ArrowRight');
    expect(useView.getState().cursor).toBe('IMG_0003');

    fireKey('ArrowLeft');
    expect(useView.getState().cursor).toBe('IMG_0002');
  });

  it('viewer 仍然可以切筛选 tab 和打开大图', () => {
    asGuest('viewer');
    render(<Harness />);

    fireKey('2');
    expect(useView.getState().tab).toBe('pick');

    useView.getState().setCursor('IMG_0001');
    fireKey('Enter');
    expect(useView.getState().lightbox).toBe('IMG_0001');
  });

  it('选中一张后按空格打开大图预览', () => {
    setSession({ kind: 'admin', user: null, share: null });
    useView.getState().setCursor('IMG_0002');
    render(<Harness />);
    const event = fireKeyEvent(' ');
    expect(event.defaultPrevented).toBe(true);
    expect(useView.getState().lightbox).toBe('IMG_0002');
  });
});

describe('H —— 隐藏（仅管理员）', () => {
  it('管理员按 H 隐藏光标那一张，并吞掉这次按键', () => {
    setSession({ kind: 'admin', user: null, share: null });
    render(<Harness />);

    const event = fireKeyEvent('h');

    expect(apiMock.putJSON).toHaveBeenCalledWith(
      '/api/library/hidden', { ids: ['IMG_0002'], hidden: true });
    expect(event.defaultPrevented).toBe(true);
  });

  it('在「已隐藏」页签里按 H 是取消隐藏', () => {
    // 方向来自当前 tab。写死 true 的实现能通过上面那条，但会让这个页签里
    // 唯一一个「把照片放回去」的入口变成什么都不做。
    setSession({ kind: 'admin', user: null, share: null });
    useView.getState().setTab('hidden');
    useView.getState().setCursor('IMG_0002');
    render(<Harness />);

    fireKeyEvent('h');

    expect(apiMock.putJSON).toHaveBeenCalledWith(
      '/api/library/hidden', { ids: ['IMG_0002'], hidden: false });
  });

  it('按 H 之后光标前进一张，和 P/X 一致', () => {
    // 钉的是 useKeyboard 这一侧的接线：applyHidden 只有拿到 order 才推进光标，
    // 而 case 'h' 忘了传 order 这件事在 applyMark 那一层的用例里完全看不出来。
    // 不传的后果不是"光标不动"这么轻——cursor 会留在一张已经从视图里消失的
    // 照片上，下一次方向键在 move() 里算出 order.indexOf(cursor) === -1，
    // 再经 Math.max(0, -1 + 1) 得到 order[0]，光标跳回第一张。
    setSession({ kind: 'admin', user: null, share: null });
    render(<Harness />);

    fireKeyEvent('h');

    expect(useView.getState().cursor).toBe('IMG_0003');
  });

  it('访客按 H 不产生任何请求，也不吞掉这次按键', () => {
    // 不吞是有讲究的：H 对访客根本不是一个功能，吞掉它就等于凭空吃掉一个
    // 浏览器/输入法可能还要用的按键，而用户完全看不出发生了什么。
    asGuest('editor');
    render(<Harness />);

    const event = fireKeyEvent('h');

    expect(apiMock.putJSON).not.toHaveBeenCalled();
    expect(useMarks.getState().hidden.size).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it('光标那一张已有标记时不发请求，只留下一句解释', () => {
    setSession({ kind: 'admin', user: null, share: null });
    useMarks.getState().load({ IMG_0002: 'pick' });
    useView.getState().setCursor('IMG_0002');
    render(<Harness />);

    fireKeyEvent('h');

    expect(apiMock.putJSON).not.toHaveBeenCalled();
    // 没有这句话，用户按下 H 之后屏幕上什么都不会变，只能自己猜。
    expect(useNotice.getState().text).toBe('已标记的照片不能隐藏，先取消标记');
  });
});

describe('按钮上的键盘激活不被吞掉', () => {
  // CSS 里有 :focus-visible 样式，设计上就想让这些按钮键盘可达。而空格和回车
  // 是按钮的**标准激活方式**——浏览器靠它们合成 click。全局监听器在这两个键上
  // 不让开的话，格子角标（✓/✕、取消隐藏）和大图关闭按钮就全都只能用鼠标点。
  it('焦点在按钮上时，回车不被吞掉（浏览器才合成得出 click）', () => {
    setSession({ kind: 'admin', user: null, share: null });
    render(<Harness />);
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    btn.focus();

    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    btn.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    // 也不该顺手把大图打开——那是回车在网格上的语义，不是在按钮上的。
    expect(useView.getState().lightbox).toBeNull();
    btn.remove();
  });

  it('焦点不在按钮上时，回车照常开大图', () => {
    // 配对用例：只有上一条的话，一个把整个 case 'enter' 删掉的实现也全绿。
    setSession({ kind: 'admin', user: null, share: null });
    useView.getState().setCursor('IMG_0002');
    render(<Harness />);

    const event = fireKeyEvent('enter');

    expect(event.defaultPrevented).toBe(true);
    expect(useView.getState().lightbox).toBe('IMG_0002');
  });
});

describe('数字键 5 —— 「已隐藏」页签', () => {
  it('管理员按 5 切到「已隐藏」（对照组）', () => {
    setSession({ kind: 'admin', user: null, share: null });
    render(<Harness />);

    fireKey('5');

    expect(useView.getState().tab).toBe('hidden');
  });

  it('访客按 5 停在原地', () => {
    // 「已隐藏」这个页签对访客不存在（TopBar 不给他渲染），切进去他会看到
    // 一屏空白，而且没有任何东西能解释它、也没有明显的路回去。
    asGuest('editor');
    render(<Harness />);

    fireKey('5');

    expect(useView.getState().tab).toBe('all');
  });
});
