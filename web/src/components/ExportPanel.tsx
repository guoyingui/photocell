import { useEffect, useMemo, useState } from 'react';
import { postJSON, openStream } from '../lib/api';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { useView } from '../store/view';
import { useSession } from '../store/session';
import { resolveExportScope, type ExportScope } from '../../../shared/exportScope.js';
import { DirBrowser } from './DirBrowser';
import { ExportHistory } from './ExportHistory';

interface AssetRef { id: string; existingPath: string }
interface RenamedRef { id: string; path: string }

interface Summary {
  exported: number; skipped: number; renamed: number;
  // 只有一个数字说明不了问题：跳过是"目标已经有一份大小/时间都匹配的文件，
  // 什么都没写"，改名是"目标撞名但内容不同，另存成了 _1"——这两种情况都需要
  // 摄影师能对着具体的 id/路径去核实"到底是不是我要的那张"，而不是凭一个
  // 数字自己猜。丢掉这两个数组就是 Task 8 修复过的"manifest 把跳过当已导出"
  // 那个 bug 的翻版。
  skippedAssets: AssetRef[];
  renamedAssets: RenamedRef[];
  // 只有 id，没有"这张根本没有 RAW"这件事本身重要——一张摄影师标记为收藏、
  // 实际却什么都没收到的照片，是仅次于误删的最坏结果，必须显眼，不能塞进
  // 折叠框里。
  missingRaw: string[];
  errors: { id: string; message: string }[];
  canceled: boolean;
  destRoot: string;
}

interface ProgressState {
  done: number;
  total: number;
  currentFile?: string;
  skipped?: number;
  renamed?: number;
  errors?: number;
}

/** 服务端 summary 里的 skippedAssets/renamedAssets 用 asset id 表示 RAW 和 JPG 两种任务，
 * 没有单独的 kind 字段——同一张照片的 RAW 和 JPG 会共享同一个 id，只能靠落地路径的
 * 扩展名区分是哪一个文件。 */
function kindOf(p: string): 'JPG' | 'RAW' {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' || ext === 'jpe' ? 'JPG' : 'RAW';
}

/** 把 HTTP 状态码翻译成摄影师能看懂、能照着做的话，而不是一句"请求失败"。 */
function describeError(e: unknown): string {
  const status = (e as { status?: number } | null)?.status;
  const message = e instanceof Error ? e.message : String(e);
  if (status === 403) {
    return `目标文件夹不在允许访问的范围内（只能导出到主目录或外接硬盘/卷内）：${message}`;
  }
  if (status === 409) {
    return '尚未打开照片文件夹，请先在首页选择要导出的文件夹后再试一次。';
  }
  if (status === 400) {
    // 400 有两种情况：目标是源文件夹自身或其子目录；或者确认数量对不上——
    // 服务端这两条消息本身已经说清楚是哪一种，原样展示即可。
    return message;
  }
  return message;
}

export function ExportPanel({ open, onClose, visibleIds }: { open: boolean; onClose: () => void; visibleIds?: string[] }) {
  const assets = useLibrary((s) => s.assets);
  const marks = useMarks((s) => s.marks);
  const contrib = useMarks((s) => s.contrib);
  const hidden = useMarks((s) => s.hidden);
  const selection = useView((s) => s.selection);
  const dir = useView((s) => s.dirFilter);
  const tab = useView((s) => s.tab);
  const clientFilter = useView((s) => s.clientFilter);
  const roster = useSession((s) => s.roster);
  const online = useSession((s) => s.online);
  const [scopeKind, setScopeKind] = useState<ExportScope['kind']>('all');
  const [clientId, setClientId] = useState('');
  const clients = useMemo(() => {
    const names = new Map([...online, ...roster].map((user) => [user.id, user.nickname]));
    names.set('admin', '摄影师');
    for (const votes of Object.values(contrib)) {
      for (const id of Object.keys(votes ?? {})) if (!names.has(id)) names.set(id, '已离开的成员');
    }
    return [...names].map(([id, nickname]) => ({ id, nickname }));
  }, [online, roster, contrib]);
  const scope: ExportScope = scopeKind === 'selection' ? { kind: 'selection', assetIds: [...selection] }
    : scopeKind === 'client' ? { kind: 'client', clientId }
      : scopeKind === 'filtered' ? { kind: 'filtered', dir, tab, clientId: clientFilter, ...(visibleIds ? { assetIds: visibleIds } : {}) }
        : { kind: 'all' };
  let scopeError = '';
  let picked: typeof assets = [];
  try {
    const result = resolveExportScope(assets, { marks, contrib, hidden }, scope);
    picked = result.assets.filter((asset) => result.marks[asset.id] === 'pick');
  } catch (e) { scopeError = (e as Error).message; }
  const scopeLabel = scopeKind === 'selection' ? '手动选中照片（不要求收藏）'
    : scopeKind === 'client' ? `${clients.find((user) => user.id === clientId)?.nickname ?? '客户'}的收藏`
      : scopeKind === 'filtered' ? '当前筛选中的收藏' : '全库最终收藏';

  const [here, setHere] = useState('');
  const [dest, setDest] = useState('');
  const [includeJpg, setIncludeJpg] = useState(false);
  const [jpgSubdir, setJpgSubdir] = useState(true);
  const [flatten, setFlatten] = useState(false);
  const [manifest, setManifest] = useState(true);
  const [mode, setMode] = useState<'copy' | 'move'>('copy');
  const [confirmText, setConfirmText] = useState('');
  // move 的输入确认现在是一个独立的、可访问的弹层（role="dialog"），而不是嵌在
  // 主面板里的一行——这样它的 DOM 子树里天然不包含主面板顶部「共 N 个文件」
  // 那一行,「数字只在对话框外面的按钮上出现」才是可核实的，不是靠约定。
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  // 任务发起时的模式要单独记一份：面板上的复选框在任务跑的时候仍然可以点，
  // 用 mode 判断"现在跑的是不是 move"会在用户手滑时给出错误答案。
  const [jobMode, setJobMode] = useState<'copy' | 'move'>('copy');
  const [err, setErr] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  // 传输层掉线（EventSource 自己的 onerror，没有 message）跟服务端真的报告
  // "导出失败"（有 message 的 error 事件）不是一回事：前者只是连接不稳定，
  // 浏览器会自动重连，任务在服务端仍在继续跑，只有 /cancel 才会中止它。
  // 这个标志只用来提示"连接不稳定"，绝不清 progress/jobId，也绝不主动
  // 关闭 EventSource——见 start() 里的注释。
  const [streamNotice, setStreamNotice] = useState(false);

  const fileCount = picked.reduce(
    (n, a) => n + a.raws.length + (includeJpg && a.jpg ? 1 : 0), 0);
  const missingRawCount = picked.filter((a) => a.raws.length === 0).length;
  const moveBlocked = mode === 'move' && Number(confirmText) !== fileCount;

  const onLocationChange = (path: string) => {
    setHere(path);
    if (!dest) setDest(path);   // 首次进面板时给个合理默认值
  };

  // 面板是常驻挂载的（!open 时只是返回 null），所以上一次导出的 summary/jobId
  // 会一直留在 state 里。换了文件夹之后重新打开面板，闪现的是上一个文件夹的
  // 导出结果——摄影师完全可以读成"这个文件夹已经交付过了"。每次打开都清干净。
  // 有任务在跑时面板关不掉（关闭按钮 disabled，点背景也被拦），所以这里不会
  // 把一个正在进行的任务的 jobId 清掉。
  useEffect(() => {
    if (!open) return;
    const view = useView.getState();
    setClientId(view.clientFilter ?? 'admin');
    setScopeKind(view.selection.size > 1 ? 'selection'
      : view.dirFilter !== null || view.tab !== 'all' || Object.values(view.photoFilters).some(Boolean)
        || view.reviewFilter !== 'all' || view.opinionFilter !== 'all' || view.matchedIds !== null || Object.values(view.annotationFilters).some(Boolean) ? 'filtered'
        : view.clientFilter ? 'client' : 'all');
    setSummary(null);
    setProgress(null);
    setJobId(null);
    setErr(null);
    setStreamNotice(false);
    setConfirmText('');
    setConfirmOpen(false);
    setHistoryOpen(false);
  }, [open]);

  // 确认期间即使张数没变，名单变了也必须重新确认。
  const pickedKey = JSON.stringify(picked.map((asset) => asset.id));
  useEffect(() => { setConfirmText(''); }, [pickedKey, scopeKind, clientId]);

  // 刷新或关标签页会让前端彻底忘掉这个任务，而服务端还在一个一个删源文件，
  // 用户既看不到进度也没法取消。只在 move 任务真的在跑的时候拦。
  useEffect(() => {
    if (!jobId || jobMode !== 'move') return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';   // 老浏览器要求给 returnValue 赋值才会弹确认框
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [jobId, jobMode]);

  const start = async () => {
    setErr(null); setSummary(null); setStreamNotice(false);
    setProgress({ done: 0, total: fileCount });
    try {
      const res = await postJSON<{ jobId: string; total: number }>('/api/export', {
        destRoot: dest, includeJpg, jpgSubdir: includeJpg && jpgSubdir ? 'JPG' : '',
        flatten,
        // manifest 默认 true——底层库自己的默认是相反的（不生成），这里永远
        // 显式传出当前勾选状态的字面值，不依赖"不传就是默认"，避免哪天服务端
        // 默认值的假设变了而悄悄改变行为。
        manifest,
        mode,
        ...(scope.kind === 'all' ? {} : { scope }),
        ...(mode === 'move' ? { confirmCount: Number(confirmText) } : {}),
      });
      setJobId(res.jobId);
      setJobMode(mode);
      const stop = openStream(`/api/export/${res.jobId}/stream`, (event) => {
        if (event.type === 'progress') {
          setStreamNotice(false);
          setProgress({
            done: event.done, total: event.total, currentFile: event.currentFile,
            skipped: event.skipped, renamed: event.renamed, errors: event.errors,
          });
        } else if (event.type === 'done') {
          setStreamNotice(false);
          setSummary(event.summary); setProgress(null); setJobId(null); stop();
        } else if (event.type === 'error') {
          if (event.message) {
            // 服务端真的报告了失败（比如导出过程本身抛了异常）。
            setErr(event.message); setProgress(null); setJobId(null);
            setStreamNotice(false); stop();
          } else {
            // 传输层掉线：既不能当成导出失败清掉 jobId/progress（用户会连
            // 取消按钮都点不到，而 move 模式下文件可能还在服务端被逐个删除），
            // 也不能调用 stop() 关闭 EventSource——那会连带取消浏览器正在
            // 自动进行的重连尝试。只提示一下，等重连成功、job 重放缓冲的
            // 事件后状态会自己恢复。
            setStreamNotice(true);
          }
        }
      });
    } catch (e) {
      setErr(describeError(e));
      setProgress(null);
    }
  };

  if (!open) return null;

  return (
    <div className="modal" onClick={(e) => { if (e.target === e.currentTarget && !progress && !historyBusy) onClose(); }}>
      <div className="modal-box">
        <h2>导出照片</h2>
        <nav className="tabs">
          <button className={!historyOpen ? 'tab tab-on' : 'tab'} disabled={!!progress || historyBusy} onClick={() => setHistoryOpen(false)}>新建导出</button>
          <button className={historyOpen ? 'tab tab-on' : 'tab'} disabled={!!progress || historyBusy} onClick={() => setHistoryOpen(true)}>导出历史</button>
        </nav>
        {historyOpen ? <>
          <ExportHistory onBusyChange={setHistoryBusy} />
          <div className="modal-actions"><button disabled={historyBusy} onClick={onClose}>关闭</button></div>
        </> : <>

        <fieldset className="export-options" disabled={!!progress}>
          <label className="row">导出范围
            <select value={scopeKind} onChange={(e) => setScopeKind(e.target.value as ExportScope['kind'])}>
              <option value="all">全库最终收藏</option>
              <option value="filtered">当前筛选中的收藏</option>
              <option value="client">指定成员的收藏</option>
              <option value="selection">手动选中照片</option>
            </select>
          </label>
          {scopeKind === 'client' && <label className="row">选片成员
            <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
              {clients.map((user) => <option key={user.id} value={user.id}>{user.nickname}</option>)}
            </select>
          </label>}
          <p className="export-scope" role="status">本次范围：{scopeLabel}</p>
          {scopeKind === 'filtered' && <p className="muted">
            仅导出当前目录、标签页、成员、文件名、拍摄参数和浏览状态筛选内的收藏，包含折叠连拍组中的照片。
          </p>}
          {scopeError && <p className="error">{scopeError}</p>}

        <p className="muted">
          {scopeKind === 'selection' ? '选中' : '收藏'} {picked.length} 张，共 {fileCount} 个文件
          {missingRawCount > 0 && (
              <strong className="warn"> · 其中 {missingRawCount} 张没有 RAW{includeJpg ? '，可用 JPG 按选项导出' : '，会被跳过'}</strong>
          )}
        </p>

        <DirBrowser
          onLocationChange={onLocationChange}
          maxHeight={180}
          rowAction={(d) => (
            <button className="ghost" onClick={() => setDest(d.path)}>选这里</button>
          )}
        />
        <div className="picker-actions">
          <button onClick={() => here && setDest(here)} disabled={!here}>选当前目录</button>
        </div>

        <label className="row">导出到 <input value={dest} onChange={(e) => setDest(e.target.value)} /></label>

        <div className="opts">
          <label><input type="checkbox" checked={includeJpg}
                        onChange={(e) => { setIncludeJpg(e.target.checked); setConfirmText(''); }} /> 同时复制 JPG</label>
          {includeJpg && (
            <label><input type="checkbox" checked={jpgSubdir}
                          onChange={(e) => setJpgSubdir(e.target.checked)} /> JPG 放进 JPG/ 子目录</label>
          )}
          <label><input type="checkbox" checked={flatten}
                        onChange={(e) => setFlatten(e.target.checked)} /> 平铺到单层目录（不保留子目录结构）</label>
          <label><input type="checkbox" checked={manifest}
                        onChange={(e) => setManifest(e.target.checked)} /> 生成 manifest.csv 与 rejected.txt</label>
          <label><input type="checkbox" checked={mode === 'move'}
                        onChange={(e) => {
                          setMode(e.target.checked ? 'move' : 'copy');
                          setConfirmText('');
                          setConfirmOpen(false);
                        }} />
            <strong className="warn">移动（会从源文件夹删除原文件）</strong></label>
        </div>
        </fieldset>

        {progress && (
          <div className="progress">
            <div className="progress-bar" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
            <span>{progress.done} / {progress.total}</span>
            {progress.currentFile && <span className="muted progress-file">{progress.currentFile}</span>}
            {streamNotice && <span className="warn">连接不稳定，正在自动重连…（导出仍在服务端继续）</span>}
            <button onClick={() => {
              if (!jobId) return;
              // 取消请求本身失败（比如任务碰巧已经跑完、注册表里的记录过期）
              // 不用打扰用户——真正的终态永远以 SSE 的 done/error 事件为准。
              void postJSON(`/api/export/${jobId}/cancel`).catch(() => {});
            }}>取消</button>
          </div>
        )}

        {summary && (
          <div className="summary">
            <p>{summary.canceled ? '已取消。' : '导出完成。'}
              成功 {summary.exported} · 跳过 {summary.skipped} · 重命名 {summary.renamed}</p>

            {summary.missingRaw.length > 0 && (
              <div className="missing-raw">
                <strong>{summary.missingRaw.length} 张照片没有 RAW，请核对对应文件；可用 JPG 按导出选项处理：</strong>
                <ul>{summary.missingRaw.map((id) => <li key={id}><code>{id}</code></li>)}</ul>
              </div>
            )}

            {summary.skippedAssets.length > 0 && (
              <details>
                <summary>{summary.skipped} 个文件因目标已有大小和时间都匹配的文件而跳过（未覆盖）</summary>
                <ul>{summary.skippedAssets.map((a, i) => (
                  <li key={i}><code>{a.id}</code>（{kindOf(a.existingPath)}）已存在于 <code>{a.existingPath}</code></li>
                ))}</ul>
              </details>
            )}

            {summary.renamedAssets.length > 0 && (
              <details>
                <summary>{summary.renamed} 个文件因目标撞名但内容不同而改名保存</summary>
                <ul>{summary.renamedAssets.map((a, i) => (
                  <li key={i}><code>{a.id}</code>（{kindOf(a.path)}）另存为 <code>{a.path}</code></li>
                ))}</ul>
              </details>
            )}

            {summary.errors.length > 0 && (
              <details>
                <summary className="error">{summary.errors.length} 个文件未能完成，其余文件不受影响</summary>
                <ul>{summary.errors.map((e, i) => <li key={i}>{e.id}：{e.message}</li>)}</ul>
              </details>
            )}
            <code>{summary.destRoot}</code>
          </div>
        )}

        {err && <p className="error">{err}</p>}

        <div className="modal-actions">
          <button onClick={onClose} disabled={!!progress}>关闭</button>
          <button
            className="primary"
            onClick={() => { if (mode === 'move') setConfirmOpen(true); else void start(); }}
            disabled={!dest || fileCount === 0 || !!progress}
          >
            {/* move 模式下这颗按钮本身就是"数字出现的地方"——它在确认对话框外面，
                点它只是打开确认弹层，真正的 start() 要等弹层里核对过数字才会跑。 */}
            {mode === 'move' ? `移动 ${fileCount} 个文件` : `复制 ${fileCount} 个文件`}
          </button>
        </div>
        </>}
      </div>

      {/* move 的二次确认：独立的可访问弹层，故意不在自己的 DOM 子树里出现 fileCount——
          要填的数字只能从已经关掉的、上面那颗按钮上记下来，逼用户真的看过一眼数字，
          而不是照着输入框旁边现成的答案抄一遍。这只是人的减速带；真正的安全属性是
          服务端 /api/export 的二次核对（见 describeError 上面的注释）。 */}
      {confirmOpen && mode === 'move' && (
        <div
          className="modal confirm-modal"
          onClick={(e) => { if (e.target === e.currentTarget) { setConfirmOpen(false); setConfirmText(''); } }}
        >
          <div className="modal-box" role="dialog" aria-label="确认移动">
            <h2>确认移动</h2>
            <p>移动会删除源文件。请回到本面板顶部那一行，把「共 … 个文件」里的数字填进来以确认：</p>
            <label className="row confirm">
              <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} inputMode="numeric" />
            </label>
            <div className="modal-actions">
              <button onClick={() => { setConfirmOpen(false); setConfirmText(''); }}>取消</button>
              <button
                className="primary danger"
                disabled={moveBlocked}
                onClick={() => { setConfirmOpen(false); void start(); }}
              >
                确认移动
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
