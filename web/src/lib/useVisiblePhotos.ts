import { useLayoutEffect } from 'react';
import { useView } from '../store/view';

/** 标记和隐藏会动态改变筛选结果；鼠标、键盘和大图必须使用同一份有效选区。 */
export function useVisiblePhotos(photoOrder: string[], ready: boolean) {
  useLayoutEffect(() => {
    if (ready) useView.getState().pruneMissing(new Set(photoOrder));
  }, [photoOrder, ready]);
}
