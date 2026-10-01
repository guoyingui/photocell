import { useEffect } from 'react';
import { useMarks } from '../store/marks';
import { useSession } from '../store/session';
import { useView } from '../store/view';
import { applyHidden, applyMark, markTargets } from './applyMark';
import { showToast } from '../store/notice';
import type { FilterTab, Mark } from '../types';

const TABS: FilterTab[] = ['all', 'pick', 'reject', 'none', 'hidden'];

// markTargets 的定义已经搬到 applyMark.ts（标记入口和它的目标计算属于同一件事）。
// 这里再导出一次：store/library.test.ts 从本模块导入它，那条 import 没有理由
// 因为一次内部搬家而改动。
export { markTargets };

export function useKeyboard(order: string[], photoOrder: string[] = order) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
      if (document.querySelector('.modal')) return;

      const view = useView.getState();
      const marks = useMarks.getState();

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        if (!useSession.getState().canWrite()) return;
        e.preventDefault();
        if (e.shiftKey) marks.redo();
        else marks.undo();
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'y') {
        if (!useSession.getState().canWrite()) return;
        e.preventDefault(); marks.redo(); return;
      }
      if (view.compare) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && !view.lightbox) {
        e.preventDefault(); view.setSelection(photoOrder); return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const visible = new Set(photoOrder);
      const targets = markTargets(view).filter((id) => visible.has(id));

      // preventDefault 从原来的"写之前"挪到了"写之后"——同一次事件派发之内，
      // 对 keydown 完全等价。挪的理由是只有 applyMark 知道这次到底写没写
      // （只读、或者一张都没选中时不该吞掉按键）。
      const setMark = (mark: Mark | null) => {
        if (!applyMark(mark, { targets, order: targets.length > 1 ? undefined : order })) return;
        e.preventDefault();
        if (targets.length > 1) view.setCursor(null);
      };

      const move = (delta: number) => {
        e.preventDefault();
        // 大图打开期间，网格的方向键导航整体失效：左右翻页已经由 Lightbox
        // 自己的 capture 监听器接管（并 stopPropagation 掐断了冒泡到这里的
        // 路径），但上下方向键 Lightbox 完全不处理——如果这里不加判断，会在
        // 用户毫无察觉的情况下把 cursor 悄悄换到别的照片上，而大图显示的还是
        // 原来那张；下次 Esc 退出，网格光标停的就不是刚才在看的那张。这里
        // 选择让 move() 整体在大图打开期间什么都不做，而不是让它去驱动大图翻页——
        // 翻页体验已经完整地由 Lightbox 自己实现（Left/Right），把上下方向键
        // 也接进来翻页没有任何在这个任务的验收标准或说明文档里提到的需求，
        // 反而会让"翻一页跳好几张"这种和方向键本身语义不符的行为凭空出现。
        if (view.lightbox) return;
        if (order.length === 0) return;
        const at = view.cursor ? order.indexOf(view.cursor) : -1;
        const next = order[Math.min(order.length - 1, Math.max(0, at + delta))];
        if (next) view.setCursor(next, { extend: e.shiftKey, order });
      };

      switch (e.key.toLowerCase()) {
        case 'c': {
          const ids = [...view.selection].filter((id) => visible.has(id));
          if (ids.length === 2) { e.preventDefault(); view.openCompare(ids[0], ids[1]); }
          return;
        }
        case 'p': case 'f': return setMark('pick');
        case 'x': return setMark('reject');
        case 'u': return setMark(null);
        case 'h': {
          // 隐藏 / 取消隐藏。作用对象和 P/X 完全一致（markTargets）。
          const inHiddenTab = view.tab === 'hidden';
          // order 和 P/X 一样要传：不传的话光标会留在刚藏起来的那张上，
          // 下一次方向键跳回第一张。
          const result = applyHidden(!inHiddenTab, { targets, order: targets.length > 1 ? undefined : order });
          if (!result) return;             // 没权限或没目标，不吞按键
          e.preventDefault();
          if (targets.length > 1) view.setCursor(null);
          if (result.hidden === 0 && result.skipped > 0) {
            showToast('已标记的照片不能隐藏，先取消标记');
          } else if (result.skipped > 0) {
            showToast(`已隐藏 ${result.hidden} 张，${result.skipped} 张因为已有标记被跳过`);
          }
          return;
        }
        case 'arrowright': return move(1);
        case 'arrowleft': return move(-1);
        case 'arrowdown': return move(Number(document.body.dataset.cols ?? 6));
        case 'arrowup': return move(-Number(document.body.dataset.cols ?? 6));
        case 'enter':
          // 焦点在按钮上时让开：回车是按钮的标准激活方式，浏览器靠它合成 click。
          // 不让的话，网格里那些角标按钮（取消隐藏）全都只能用鼠标点。
          if (target?.closest('button, input')) return;
          if (view.cursor) { e.preventDefault(); view.openLightbox(view.cursor); }
          return;
        case ' ':
          // 网格里空格 = 放大预览当前这一张（和大图里空格切 1:1 是两件事：
          // Lightbox 用 capture + stopPropagation 先把它接走）。
          if (target?.closest('button, input, textarea, select')) return;
          if (view.lightbox) return;
          if (view.cursor) { e.preventDefault(); view.openLightbox(view.cursor); }
          return;
        case 'escape':
          e.preventDefault();
          if (view.lightbox) view.closeLightbox();
          else if (view.expanded.size > 0) view.collapseAll();
          else view.clearSelection();
          return;
        case '1': case '2': case '3': case '4': case '5':
          // 「已隐藏」只有管理员看得到。访客按 5 什么都不该发生——
          // 让他切进一个空的、解释不了的 tab 比不响应更糟。**判在吞之前**：
          // 一个什么都不做却又把按键吃掉的分支，说不清自己吃它干什么。
          if (e.key === '5' && !useSession.getState().canHide()) return;
          e.preventDefault();
          view.setTab(TABS[Number(e.key) - 1]);
          return;
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [order, photoOrder]);
}
