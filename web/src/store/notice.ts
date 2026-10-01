import { create } from 'zustand';

interface NoticeState {
  /** 一句一次性提示。null = 没有。 */
  text: string | null;
}

/**
 * 一次性提示。放在独立 store 而不是塞进 marks store，是因为它和标记无关：
 * 「已标记的照片不能隐藏」这种话，marks 那边没有任何字段能自然地表达。
 */
export const useNotice = create<NoticeState>(() => ({ text: null }));

let timer: ReturnType<typeof setTimeout> | null = null;

export function showToast(text: string) {
  if (timer) clearTimeout(timer);
  useNotice.setState({ text });
  timer = setTimeout(() => {
    timer = null;
    useNotice.setState({ text: null });
  }, 3000);
}

/** 换文件夹时清掉。上一个文件夹的提示留到下一个文件夹里是纯噪音。 */
export function clearToast() {
  if (timer) { clearTimeout(timer); timer = null; }
  useNotice.setState({ text: null });
}
