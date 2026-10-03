import { useState } from 'react';
import { deletePreset, readPresets, savePreset } from '../lib/filterPresets';
import { filterChips, normalizeFilters } from '../lib/filterState';
import { SORT_OPTIONS } from '../lib/photoSort';
import { useDialogFocus } from '../lib/useDialogFocus';
import { useView } from '../store/view';
import { useWorkspace } from '../store/workspace';
import { useSession } from '../store/session';

export function FilterPresets({ scope, onClose }: { scope: string; onClose: () => void }) {
  const [presets, setPresets] = useState(() => readPresets(scope));
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const ref = useDialogFocus(onClose);
  const sort = useWorkspace((state) => state.sort);
  const filters = useView();
  const chips = filterChips(filters);
  const save = () => {
    try { setPresets(savePreset(scope, name, filters, sort)); setName(''); setError(''); }
    catch (err) { setError((err as Error).message); }
  };
  return <div className="modal"><div ref={ref} className="modal-box filter-presets" role="dialog" aria-modal="true" aria-label="筛选预设" tabIndex={-1}>
    <h2>筛选预设</h2>
    <p className="muted">保存在当前浏览器，按照片库和选片身份分别管理。预设包含筛选条件与排序，不保存选区。</p>
    <p>当前：{chips.length ? chips.map((chip) => chip.label).join(' · ') : '全部照片'} · {SORT_OPTIONS[sort]}</p>
    <form onSubmit={(event) => { event.preventDefault(); save(); }} className="preset-save">
      <label>预设名称<input data-autofocus value={name} maxLength={40} placeholder="例如：未看照片、收藏待精修"
        onChange={(event) => setName(event.target.value)} /></label>
      <button type="submit" disabled={!name.trim()}>保存当前条件</button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="preset-list">
      {!presets.length && <p className="muted">还没有预设。先设置筛选条件，再在这里保存。</p>}
      {presets.map((preset) => <article key={preset.id} className="preset-entry">
        <div><strong>{preset.name}</strong><p className="muted">{filterChips(preset.filters).length} 项筛选 · {SORT_OPTIONS[preset.sort]}</p></div>
        <button onClick={() => {
          useView.getState().applyFilters(normalizeFilters(preset.filters, useSession.getState().kind === 'admin'));
          useWorkspace.getState().setSort(preset.sort); onClose();
        }} aria-label={`应用预设 ${preset.name}`}>应用</button>
        <button aria-label={`删除预设 ${preset.name}`} onClick={() => {
          try { setPresets(deletePreset(scope, preset.id)); setError(''); }
          catch (err) { setError((err as Error).message); }
        }}>删除</button>
      </article>)}
    </div>
    <div className="modal-actions"><button onClick={onClose}>关闭</button></div>
  </div></div>;
}
