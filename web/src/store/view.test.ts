import { describe, it, expect, beforeEach } from 'vitest';
import { useView } from './view';

beforeEach(() => { useView.getState().reset(); });

const view = () => useView.getState();

describe('setSelection', () => {
  it('空数组清空选区和光标', () => {
    useView.getState().setCursor('a');
    useView.getState().setSelection([]);
    expect(useView.getState().selection.size).toBe(0);
    expect(useView.getState().cursor).toBeNull();
  });

  it('一批 id 整批替换，光标落在最后一张', () => {
    useView.getState().setSelection(['a', 'b', 'c']);
    expect([...useView.getState().selection]).toEqual(['a', 'b', 'c']);
    expect(useView.getState().cursor).toBe('c');
    expect(useView.getState().anchor).toBe('a');
  });
});

describe('useView.reset — 换文件夹时的硬复位', () => {
  it('清掉每一个「装着上一个文件夹的 id」的字段', () => {
    useView.setState({ tab: 'reject', dirFilter: 'cam-a', threshold: 2500 });
    view().setCursor('A');                    // 同时设 cursor / anchor / selection
    useView.setState({ expanded: new Set(['A']), lightbox: 'A' });
    view().setResolveVisible(() => 'A');      // 捕获了上一个文件夹 groups 的闭包

    view().reset();

    expect(view().tab).toBe('all');
    expect(view().dirFilter).toBeNull();
    expect(view().cursor).toBeNull();
    expect(view().anchor).toBeNull();
    expect(view().selection.size).toBe(0);
    expect(view().expanded.size).toBe(0);
    expect(view().lightbox).toBeNull();
    expect(view().threshold).toBe(1000);
    // resolveVisible 必须退回恒等函数，否则新文件夹的 id 会被映射到旧组的"出头"上
    expect(view().resolveVisible('NEW', new Set())).toBe('NEW');
  });

  it('每次 reset 都给出全新的集合对象，不共享引用', () => {
    view().reset();
    const first = view().selection;
    view().setCursor('A');
    view().reset();
    expect(view().selection).not.toBe(first);
    expect(view().selection.size).toBe(0);
  });

  it('reset 之后 setCursor 仍然正常工作（复位不是把 store 打坏）', () => {
    view().reset();
    view().setCursor('B');
    expect(view().cursor).toBe('B');
    expect([...view().selection]).toEqual(['B']);
  });
});

describe('电脑端选择与对比', () => {
  it('组合键点选只增减选区，保留范围选择的锚点', () => {
    view().setCursor('A');
    view().toggleSelect('B');
    expect([...view().selection]).toEqual(['A', 'B']);
    expect(view().anchor).toBe('A');
    view().toggleSelect('B');
    expect([...view().selection]).toEqual(['A']);
  });

  it('对比只聚焦候选图，切换筛选或文件夹时关闭', () => {
    view().setSelection(['A', 'B', 'C']);
    view().openCompare('A', 'B');
    expect([...view().selection]).toEqual(['B']);
    expect(view().lightbox).toBeNull();
    view().setTab('pick');
    expect(view().compare).toBeNull();
    view().openCompare('A', 'B');
    view().reset();
    expect(view().compare).toBeNull();
  });

  it('刷新后有一张对比照片消失就关闭对比', () => {
    view().openCompare('A', 'B');
    view().pruneMissing(new Set(['A']));
    expect(view().compare).toBeNull();
  });
});
