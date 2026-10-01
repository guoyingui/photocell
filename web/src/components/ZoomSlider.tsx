import { useLibrary } from '../store/library';
import { CELL_WIDTH_MIN, CELL_WIDTH_MAX } from '../types';

/**
 * 网格缩放滑块。
 *
 * 改造前 `gridSize` 三档枚举在类型、服务端默认值、Grid 的 CELL_W 表里都存在，
 * **唯独没有任何界面能改它**。这个组件是那条链路缺的最后一环。
 */
export function ZoomSlider() {
  const cellWidth = useLibrary((s) => s.settings.cellWidth);
  const setCellWidth = useLibrary((s) => s.setCellWidth);

  return (
    <label className="zoom-slider">
      <span className="zoom-slider-icon" aria-hidden="true">▦</span>
      <input
        type="range"
        aria-label="网格缩放"
        min={CELL_WIDTH_MIN}
        max={CELL_WIDTH_MAX}
        step={10}
        value={cellWidth}
        onChange={(e) => setCellWidth(Number(e.target.value))}
      />
    </label>
  );
}
