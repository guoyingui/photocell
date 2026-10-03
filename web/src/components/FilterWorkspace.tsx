import { useState } from 'react';
import { useWorkspace, type FilterSection } from '../store/workspace';
import { useView } from '../store/view';
import { useLibrary } from '../store/library';
import { useSession } from '../store/session';
import { filterChips } from '../lib/filterState';
import { SORT_OPTIONS, type PhotoSort } from '../lib/photoSort';
import { FilterPresets } from './FilterPresets';
import { FilenameMatchPanel } from './FilenameMatchPanel';

export function FilterWorkspace() {
  const root = useLibrary((state) => state.root);
  const kind = useSession((state) => state.kind);
  const user = useSession((state) => state.user);
  const roster = useSession((state) => state.roster);
  const online = useSession((state) => state.online);
  const collapsed = useWorkspace((state) => state.collapsed);
  const sort = useWorkspace((state) => state.sort);
  const storageError = useWorkspace((state) => state.storageError);
  const filters = useView();
  const [dialog, setDialog] = useState<'presets' | 'match' | null>(null);
  const scope = kind === 'admin' && root ? `admin:${root}` : kind === 'user' && user ? `user:${user.id}` : null;
  const chips = filterChips(filters, new Map([...online, ...roster].map((member) => [member.id, member.nickname])));
  const sections: [FilterSection, string][] = [['capture', '拍摄参数'], ...(kind === 'admin' ? [['opinions', '客户意见'] as [FilterSection, string]] : []), ['annotations', '后期筛选']];
  return <section className="filter-workspace filter-bar" aria-label="筛选工作区">
    <div className="workspace-toolbar">
      <div className="workspace-sections" role="group" aria-label="筛选面板显示">
        {sections.map(([key, label]) => <button className="section-toggle" key={key} aria-expanded={!collapsed[key]}
          onClick={() => useWorkspace.getState().toggleSection(key)}>
          <span aria-hidden="true">{collapsed[key] ? '▸' : '▾'}</span> {label}
        </button>)}
      </div>
      <label className="filter-field"><span>排序</span><select value={sort}
        onChange={(event) => useWorkspace.getState().setSort(event.target.value as PhotoSort)}>
        {Object.entries(SORT_OPTIONS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select></label>
      <button disabled={!scope} onClick={() => setDialog('presets')}>筛选预设…</button>
      <button disabled={!scope} onClick={() => setDialog('match')}>批量文件名匹配…</button>
      <span className="muted workspace-hint">{chips.length ? `已启用 ${chips.length} 项筛选` : '未启用筛选'}</span>
    </div>
    {chips.length > 0 && <div className="active-filters" aria-label="已启用的筛选条件">
      {chips.map((chip) => <button key={chip.key} className="filter-chip" title={chip.label} aria-label={`清除筛选 ${chip.label}`}
        onClick={() => useView.getState().applyFilters({ ...useView.getState(), ...chip.patch })}>
        <span>{chip.label}</span><span aria-hidden="true">×</span>
      </button>)}
    </div>}
    {storageError && <p className="error" role="status">{storageError}</p>}
    {scope && dialog === 'presets' && <FilterPresets key={scope} scope={scope} onClose={() => setDialog(null)} />}
    {scope && dialog === 'match' && <FilenameMatchPanel key={scope} onClose={() => setDialog(null)} />}
  </section>;
}
