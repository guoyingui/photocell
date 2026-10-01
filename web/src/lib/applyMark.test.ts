import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyHidden } from './applyMark';
import { useMarks } from '../store/marks';
import { setSession } from '../store/session';
import { useView } from '../store/view';

// 断言必须落在 setHidden **收到的参数**上，不能只看 applyHidden 的返回值。
// 返回值是 applyHidden 自己算出来的那两个数字，它和「真的把哪几个 id、往哪个
// 方向传下去了」是两件事：`setHidden(targets, hidden)`（漏掉过滤）在六条用例下
// 返回值一模一样，但本地会乐观地把已标记的那张也藏起来，直到服务端响应回来
// 才弹回去——用户看得见这一闪。`setHidden(eligible, true)`（把方向写死）同理。
const spyOnSetHidden = () =>
  vi.spyOn(useMarks.getState(), 'setHidden').mockImplementation(() => {});
let setHidden: ReturnType<typeof spyOnSetHidden>;

beforeEach(() => {
  useMarks.setState({ marks: {}, marksMeta: {}, hidden: new Set(), error: null });
  useView.setState({ selection: new Set(), cursor: null });
  setSession({ kind: 'admin', user: null });
  // mockClear 不能省。zustand 的 setState 是 Object.assign 出一个新的 state 对象，
  // 上一条用例装上去的那个 mock 会被原样抄进来；而 vi.spyOn 撞见一个已经是 mock
  // 的属性时**直接把它原样返回**（@vitest/spy 的 isMockFunction 短路），不会新建
  // 一个。结果就是整份用例共用同一份调用记录：某条用例的 `not.toHaveBeenCalled()`
  // 会被上一条的调用弄红，而某条 `toHaveBeenCalledWith` 又可能靠上一条的调用变绿。
  setHidden = spyOnSetHidden();
  setHidden.mockClear();
});

describe('applyHidden', () => {
  it('访客一律拒绝，连请求都不发', () => {
    // 三道门禁里的第三道。只靠服务端的话，乐观更新会先把照片藏起来、
    // 等 403 回来再弹回去——中间那一瞬间「看起来我藏成功了」最容易误判。
    setSession({ kind: 'user', user: { id: 'u_ab', nickname: '小林', role: 'editor' } });
    expect(applyHidden(true, { targets: ['a'] })).toBeNull();
    expect(setHidden).not.toHaveBeenCalled();
  });

  it('身份未定时也拒绝（默认拒绝）', () => {
    setSession({ kind: 'none', user: null });
    expect(applyHidden(true, { targets: ['a'] })).toBeNull();
    expect(setHidden).not.toHaveBeenCalled();
  });

  it('没有目标时返回 null', () => {
    expect(applyHidden(true)).toBeNull();
    expect(setHidden).not.toHaveBeenCalled();
  });

  it('一批里已标记的被跳过，未标记的照常隐藏', () => {
    // 整批拒绝是更差的选择：框选五十张里有一张收藏过，就什么都做不了。
    useMarks.setState({ marks: { a: 'pick' }, marksMeta: {}, hidden: new Set() });
    expect(applyHidden(true, { targets: ['a', 'b', 'c'] })).toEqual({ hidden: 2, skipped: 1 });
    // 传下去的必须是 ['b','c']。把 'a' 一起传下去时返回值仍然是 {2,1}，
    // 这条断言是唯一能把那种实现挡下来的东西。
    expect(setHidden).toHaveBeenCalledWith(['b', 'c'], true);
  });

  it('取消隐藏不受「已标记」限制', () => {
    // 已隐藏的必然未标记，所以取消隐藏这条路径上不可能撞上这个限制；
    // 但真要撞上（脏数据），也不该把它挡在外面——那会让它永远藏着。
    useMarks.setState({ marks: { a: 'pick' }, marksMeta: {}, hidden: new Set(['a']) });
    expect(applyHidden(false, { targets: ['a'] })).toEqual({ hidden: 1, skipped: 0 });
    // 方向也要钉死：写死 true 的实现同样能让上面那句返回值断言通过。
    expect(setHidden).toHaveBeenCalledWith(['a'], false);
  });

  it('没有选区时作用于光标那一张', () => {
    useView.setState({ selection: new Set(), cursor: 'a' });
    expect(applyHidden(true)).toEqual({ hidden: 1, skipped: 0 });
    expect(setHidden).toHaveBeenCalledWith(['a'], true);
  });
});

describe('applyHidden 推进光标', () => {
  // 传了 order 才推进，和 applyMark 同一条规矩：键盘传（连续剔片要自动前进），
  // 按钮不传（批量操作后直接清空选区）。
  const order = ['a', 'b', 'c'];

  it('隐藏之后光标落到视图里的下一张，而不是留在刚藏起来的那张上', () => {
    // 不推进的话 cursor 还指着 'b'，而 'b' 已经从视图里消失了；下一次方向键
    // 在 useKeyboard 里算出 order.indexOf('b') === -1，再经 Math.max(0, -1 + 1)
    // 得到 order[0]——光标跳回第一张。于是「按住 H 连续剔片」变成反复隐藏
    // 第一张照片。这条用例钉的就是这个。
    useView.setState({ selection: new Set(), cursor: 'b', lightbox: null });
    applyHidden(true, { order });
    expect(useView.getState().cursor).toBe('c');
  });

  it('被跳过的那张仍在视图里，可以是光标的落点', () => {
    // 'b' 已有标记 → 藏不了 → 它**没有**离开视图。推进时如果按整批 targets
    // 排除（把 'b' 也当成走了），光标会越过它落到 'c'，比该去的地方远一张。
    // 这一条 applyMark 那边不存在：标记没有 skipped 这一环。
    useMarks.setState({ marks: { b: 'pick' }, marksMeta: {}, hidden: new Set() });
    useView.setState({ selection: new Set(), cursor: 'a', lightbox: null });

    expect(applyHidden(true, { targets: ['a', 'b'], order })).toEqual({ hidden: 1, skipped: 1 });
    expect(useView.getState().cursor).toBe('b');
  });

  it('不传 order 就不动光标', () => {
    useView.setState({ selection: new Set(), cursor: 'b', lightbox: null });
    applyHidden(true, { targets: ['b'] });
    expect(useView.getState().cursor).toBe('b');
  });
});
