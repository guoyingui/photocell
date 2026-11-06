import type { Mark } from '../types';

/**
 * 收藏 / 排除的图标，网格、大图、对比、批量操作条共用一套。
 *
 * 收藏用勾而不是星：缩略图左上角的后期信息已经用 ★ 表示星级，
 * 同一格里出现两种星会让人分不清"收藏了"还是"评了一星"。
 * 用 SVG 而不是 ✓ / ✕ 字符：字符的粗细和大小随系统字体变，Windows 上尤其明显。
 */
export function MarkIcon({ mark, size = 12 }: { mark: Mark; size?: number }) {
  return (
    <svg className="mark-icon" width={size} height={size} viewBox="0 0 16 16" fill="none"
         stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={mark === 'pick' ? 'M3.2 8.6 6.5 11.8 12.8 4.4' : 'M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2'} />
    </svg>
  );
}
