import { useMemo, useState } from 'react';
import { putJSON, getSessionId } from '../lib/api';
import { groupBursts } from '../lib/bursts';
import { toBurstItems } from '../lib/derive';
import { useLibrary } from '../store/library';
import { useView } from '../store/view';
import type { Settings } from '../types';
import { CacheSettings } from './CacheSettings';

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const assets = useLibrary((s) => s.assets);
  const metas = useLibrary((s) => s.metas);
  const threshold = useView((s) => s.threshold);
  const [seconds, setSeconds] = useState(String(threshold / 1000));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const value = Number(seconds) * 1000;
  const valid = seconds.trim() !== '' && Number.isInteger(value) && value >= 0 && value <= 10000;
  const groups = useMemo(() => valid ? groupBursts(toBurstItems(assets, metas), value) : [], [assets, metas, valid, value]);
  const save = async () => {
    if (!valid || busy) return;
    const sid = getSessionId();
    setBusy(true); setError('');
    try {
      const result = await putJSON<{ settings: Settings }>('/api/library/settings', { burstThresholdMs: value });
      if (getSessionId() !== sid) return;
      useLibrary.setState({ settings: result.settings });
      if (useView.getState().threshold !== result.settings.burstThresholdMs) {
        useView.getState().setThreshold(result.settings.burstThresholdMs);
      }
      onClose();
    } catch (err) { setError(`设置未能保存：${(err as Error).message}`); }
    finally { setBusy(false); }
  };
  return <div className="modal"><section className="modal-box" role="dialog" aria-modal="true" aria-label="选片设置">
    <h2>选片设置</h2>
    <label className="row">连拍间隔（秒）<input type="number" min="0" max="10" step="0.1" value={seconds}
      disabled={busy} onChange={(event) => setSeconds(event.target.value)} /></label>
    <p className="muted">同一相机相邻照片在此间隔内归为一组。范围 0–10 秒，默认 1 秒。仅按可靠的拍摄时间分组。</p>
    <p>{valid ? `预计 ${groups.filter((group) => group.ids.length > 1).length} 个连拍组（元数据仍在读取时会更新）` : '请输入 0–10 秒之间的数字'}</p>
    <p className="muted">保存在当前照片目录，所有协同成员使用相同的分组设置。</p>
    {error && <p className="error">{error}</p>}
    <CacheSettings />
    <div className="modal-actions"><button disabled={busy} onClick={onClose}>取消</button>
      <button onClick={() => setSeconds('1')} disabled={busy}>恢复默认值</button>
      <button className="primary" disabled={!valid || busy} onClick={() => void save()}>{busy ? '保存中…' : '保存设置'}</button></div>
  </section></div>;
}
