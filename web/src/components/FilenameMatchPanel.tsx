import { useEffect, useMemo, useRef, useState } from 'react';
import { FILE_LIST_BYTES, matchFilenames, parseFilenameList, resolveFilenameMatches, type FilenameMatch } from '../lib/filenameMatch';
import { useDialogFocus } from '../lib/useDialogFocus';
import { emptyFilters } from '../lib/filterState';
import { applyMark } from '../lib/applyMark';
import { getSessionId } from '../lib/api';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { useSession } from '../store/session';
import { useView } from '../store/view';
import type { Asset } from '../types';

interface Analysis { matches: FilenameMatch[]; assets: Asset[]; hidden: Set<string>; sid: string | null; emptyRows: number }
const PAGE_SIZE = 100;
const pathOf = (asset: Asset) => [asset.dir, asset.jpg ?? asset.raws[0] ?? asset.stem].filter(Boolean).join('/');

export function FilenameMatchPanel({ onClose }: { onClose: () => void }) {
  const assets = useLibrary((state) => state.assets);
  const hidden = useMarks((state) => state.hidden);
  const canWrite = useSession((state) => state.canWrite());
  const [text, setText] = useState('');
  const [column, setColumn] = useState(-1);
  const [header, setHeader] = useState<boolean | undefined>(undefined);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [choices, setChoices] = useState<Record<number, string | null>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const fileRequest = useRef(0);
  const ref = useDialogFocus(onClose);
  useEffect(() => () => { fileRequest.current++; }, []);
  const parsed = useMemo(() => {
    try { return { value: parseFilenameList(text, header), error: '' }; }
    catch (err) { return { value: null, error: (err as Error).message }; }
  }, [text, header]);
  const selectedColumn = column < 0 ? parsed.value?.defaultColumn ?? 0 : column;
  const result = useMemo(() => resolveFilenameMatches(analysis?.matches ?? [], choices), [analysis, choices]);
  const stale = analysis !== null && (assets !== analysis.assets || hidden !== analysis.hidden || getSessionId() !== analysis.sid);
  const updateText = (value: string) => {
    fileRequest.current++; setLoading(false); setText(value); setColumn(-1); setHeader(undefined); setAnalysis(null); setChoices({}); setError(''); setPage(0);
  };
  const analyze = () => {
    if (!parsed.value) { setError(parsed.error); return; }
    try {
      const names = parsed.value.rows.map((row) => row[selectedColumn] ?? '');
      const matches = matchFilenames(names, assets, hidden);
      if (!matches.length) { setError('这一列没有文件名，请输入清单或选择正确的列。'); return; }
      setAnalysis({ matches, assets, hidden, sid: getSessionId(), emptyRows: names.length - matches.length });
      setChoices({}); setPage(0); setError('');
    } catch (err) { setError((err as Error).message); }
  };
  const apply = (pick: boolean) => {
    if (!analysis || loading || result.conflicts || !result.ids.length) return;
    if (analysis.assets !== useLibrary.getState().assets || analysis.hidden !== useMarks.getState().hidden || analysis.sid !== getSessionId()) {
      setError('照片目录已变化，请重新匹配后再操作。'); return;
    }
    if (pick && !useSession.getState().canWrite()) { setError('当前不能修改收藏，可以将匹配照片加入选区。'); return; }
    const view = useView.getState();
    const available = new Set(assets.filter((asset) => !hidden.has(asset.id)).map((asset) => asset.id));
    const ids = pick ? result.ids : [...new Set([...view.selection].filter((id) => available.has(id)).concat(result.ids))];
    view.applyFilters({ ...emptyFilters(), matchedIds: ids });
    if (pick) applyMark('pick', { targets: result.ids });
    else useView.getState().setSelection(ids);
    onClose();
  };
  const pages = Math.ceil((analysis?.matches.length ?? 0) / PAGE_SIZE);
  return <div className="modal"><div ref={ref} className="modal-box filename-match" role="dialog" aria-modal="true" aria-label="批量文件名匹配" tabIndex={-1}>
    <h2>批量文件名匹配</h2>
    <p className="muted">匹配全库未隐藏的照片。支持完整文件名、不带扩展名的主名或相对路径，忽略大小写；每批最多 5000 行。</p>
    <label className="filename-input">文件名清单<textarea data-autofocus value={text} placeholder={'每行一个文件名，例如：\nIMG_0001.JPG\nday2/IMG_0002\n也可以粘贴 CSV 或 Excel 表格'}
      onChange={(event) => updateText(event.target.value)} /></label>
    <div className="filename-import">
      <label>导入 TXT / CSV<input type="file" accept=".txt,.csv,.tsv,text/plain,text/csv" onChange={async (event) => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (!file) return;
        const request = ++fileRequest.current;
        setAnalysis(null); setError('');
        if (file.size > FILE_LIST_BYTES) { setLoading(false); setError('文件超过 2 MB，请拆分清单后导入。'); return; }
        setLoading(true);
        try {
          const content = await file.text();
          if (request === fileRequest.current) updateText(content);
        } catch { if (request === fileRequest.current) setError('未能读取文件，请确认是 UTF-8 文本，或直接粘贴文件名。'); }
        finally { if (request === fileRequest.current) setLoading(false); }
      }} /></label>
      {parsed.value && text.trim() && <label><input type="checkbox" checked={parsed.value.hasHeader}
        onChange={(event) => { setHeader(event.target.checked); setColumn(-1); setAnalysis(null); setChoices({}); }} />首行是列名</label>}
      {parsed.value && parsed.value.columns.length > 1 && <label className="filter-field"><span>文件名列</span>
        <select value={selectedColumn} onChange={(event) => { setColumn(Number(event.target.value)); setAnalysis(null); setChoices({}); }}>
          {parsed.value.columns.map((label, index) => <option value={index} key={index}>{label}</option>)}
        </select></label>}
      <button disabled={loading || !text.trim()} onClick={analyze}>{loading ? '正在读取…' : analysis ? '重新匹配' : '开始匹配'}</button>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {stale && <p className="error" role="alert">照片目录已变化，请重新匹配后再操作。</p>}
    {analysis && <>
      <p className="match-summary" role="status">已匹配 <b>{result.ids.length}</b> 张 · 未找到 {result.missing} 行 · 待确认同名 {result.conflicts} 行 · 已跳过 {result.skipped} 行
        {analysis.emptyRows > 0 && ` · 空单元格 ${analysis.emptyRows} 行`}</p>
      <div className="match-results"><table><thead><tr><th>输入文件名</th><th>匹配结果</th><th>对应照片</th></tr></thead>
        <tbody>{analysis.matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((match) => <tr key={match.row}>
          <td>{match.input}</td>
          <td>{!match.candidates.length ? '未找到' : choices[match.row] === null ? '已跳过' : match.candidates.length === 1 || choices[match.row] ? '已匹配' : '同名待确认'}</td>
          <td>{match.candidates.length > 1 ? <select aria-label={`第 ${match.row + 1} 行同名照片`} value={choices[match.row] === null ? 'skip' : choices[match.row] ? `id:${choices[match.row]}` : ''}
            onChange={(event) => setChoices((old) => { const next = { ...old };
              if (!event.target.value) delete next[match.row]; else next[match.row] = event.target.value === 'skip' ? null : event.target.value.slice(3); return next;
            })}>
            <option value="">请选择对应目录的照片</option><option value="skip">跳过此项</option>
            {match.candidates.map((asset) => <option value={`id:${asset.id}`} key={asset.id}>{pathOf(asset)}</option>)}
          </select> : match.candidates[0] ? pathOf(match.candidates[0]) : '请检查文件名或相对路径'}</td>
        </tr>)}</tbody></table></div>
      {pages > 1 && <div className="match-pagination"><button disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
        <span>{page + 1} / {pages}</span><button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>下一页</button></div>}
      <p className="muted">重复文件名与同一照片的 RAW/JPG 会合并。未找到的条目不处理，同名条目需指定照片或选择跳过。</p>
      <p className="muted">确认后会清除其他筛选，显示这份文件名清单。「加入选区」同时保留原选区内未隐藏的照片；「收藏匹配」只收藏本次匹配结果。</p>
    </>}
    <div className="modal-actions"><button onClick={onClose}>取消</button>
      <button disabled={loading || stale || !result.ids.length || result.conflicts > 0} onClick={() => apply(false)}>加入选区（{result.ids.length}）</button>
      {canWrite && <button className="primary" disabled={loading || stale || !result.ids.length || result.conflicts > 0} onClick={() => apply(true)}>收藏匹配（{result.ids.length}）</button>}
    </div>
  </div></div>;
}
