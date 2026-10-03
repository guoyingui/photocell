import { useState } from 'react';
import { LABELS, STAGES, type Annotation } from '../../../shared/annotations.js';
import { useAnnotations } from '../store/annotations';
import { useLibrary } from '../store/library';
import { useMarks } from '../store/marks';
import { useView } from '../store/view';
import { useSession } from '../store/session';
import { postBlob } from '../lib/api';

export function AnnotationTools({ order }: { order: string[] }) {
  const filters = useView((state) => state.annotationFilters);
  const selection = useView((state) => state.selection);
  const isAdmin = useSession((state) => state.kind === 'admin');
  const busy = useAnnotations((state) => state.busy);
  const ready = useAnnotations((state) => state.ready);
  const error = useAnnotations((state) => state.error);
  const [batch, setBatch] = useState(false), [xmp, setXmp] = useState(false);
  const selected = order.filter((id) => selection.has(id));
  const change = useView.getState().setAnnotationFilters;
  return <section className="annotation-tools" aria-label="后期筛选">
    <strong>后期</strong><label>至少<select value={filters.rating} onChange={(event) => change({ rating: event.target.value })}>
      <option value="">不限星级</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} 星</option>)}</select></label>
    <label>标签<select value={filters.label} onChange={(event) => change({ label: event.target.value })}><option value="">全部颜色</option>
      {Object.entries(LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
    <label>阶段<select value={filters.stage} onChange={(event) => change({ stage: event.target.value })}><option value="">全部阶段</option>
      {Object.entries(STAGES).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
    <input aria-label="关键词筛选" value={filters.keyword} placeholder="筛选关键词" onChange={(event) => change({ keyword: event.target.value })} />
    {isAdmin && <><button disabled={busy || !ready || !selected.length} onClick={() => setBatch(true)}>批量后期信息（{selected.length}）</button>
      <button disabled={!ready} onClick={() => setXmp(true)}>导出 XMP…</button></>}
    {error && <><span className="error">{error}</span><button onClick={() => void useAnnotations.getState().reload()}>重新载入</button></>}
    {batch && <BatchAnnotations ids={selected} onClose={() => setBatch(false)} />}
    {xmp && <XmpPanel order={order} onClose={() => setXmp(false)} />}
  </section>;
}

function BatchAnnotations({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const busy = useAnnotations((state) => state.busy), error = useAnnotations((state) => state.error);
  const [patch, setPatch] = useState<Partial<Annotation>>({});
  const [words, setWords] = useState('');
  const [replaceKeywords, setReplaceKeywords] = useState(false);
  const save = async () => {
    const changed = { ...patch, ...(replaceKeywords ? { keywords: words.split(/[,，、]/).map((word) => word.trim()).filter(Boolean) } : {}) };
    if (await useAnnotations.getState().save(ids, changed)) onClose();
  };
  return <div className="modal"><section className="modal-box" role="dialog" aria-modal="true" aria-label="批量后期信息">
    <h2>设置 {ids.length} 张照片的后期信息</h2>
    <label className="row">星级<select value={patch.rating ?? ''} onChange={(event) => setPatch(({ rating, ...rest }) => event.target.value === '' ? rest : { ...rest, rating: Number(event.target.value) })}>
      <option value="">保持原值</option>{[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n ? `${n} 星` : '未评级'}</option>)}</select></label>
    {(['label', 'stage'] as const).map((key) => <label className="row" key={key}>{key === 'label' ? '颜色标签' : '后期阶段'}
      <select value={patch[key] ?? ''} onChange={(event) => setPatch((old) => { const next = { ...old }; if (event.target.value) Object.assign(next, { [key]: event.target.value }); else delete next[key]; return next; })}>
        <option value="">保持原值</option>{Object.entries(key === 'label' ? LABELS : STAGES).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>)}
    <label className="row"><input type="checkbox" checked={replaceKeywords} onChange={(event) => setReplaceKeywords(event.target.checked)} />替换关键词（留空会清除）</label>
    <input value={words} disabled={!replaceKeywords} placeholder="用逗号或顿号分隔" onChange={(event) => setWords(event.target.value)} />
    {error && <p className="error">{error}</p>}
    <div className="modal-actions"><button disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy || !ids.length || (!Object.keys(patch).length && !replaceKeywords)} onClick={() => void save()}>保存</button></div>
  </section></div>;
}

function XmpPanel({ order, onClose }: { order: string[]; onClose: () => void }) {
  const assets = useLibrary((state) => state.assets), marks = useMarks((state) => state.marks), hidden = useMarks((state) => state.hidden);
  const selection = useView((state) => state.selection);
  const [scope, setScope] = useState(selection.size ? 'selection' : 'picks');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const ids = assets.filter((asset) => asset.raws.length > 0 && !hidden.has(asset.id)
    && (scope === 'selection' ? selection.has(asset.id) && order.includes(asset.id) : scope === 'visible' ? order.includes(asset.id) : marks[asset.id] === 'pick')).map((asset) => asset.id);
  const download = async () => {
    setBusy(true); setError('');
    try {
      const blob = await postBlob('/api/export/xmp', { assetIds: ids });
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = 'photocull-xmp.zip'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); onClose();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="modal"><section className="modal-box" role="dialog" aria-modal="true" aria-label="导出 XMP">
    <h2>导出后期元数据</h2><label className="row">导出范围<select disabled={busy} value={scope} onChange={(event) => setScope(event.target.value)}>
      <option value="picks">全库最终收藏</option><option value="visible">当前筛选的照片</option><option value="selection">手动选中且可见的照片</option></select></label>
    <p>当前范围：{ids.length} 张有 RAW 的照片。下载 ZIP，按原目录结构提供同主名 XMP。</p>
    <p className="muted">包含星级、颜色标签、关键词和后期阶段。解压后放在对应 RAW 旁，由修图软件读取元数据；请保留已有修图 sidecar，合并前先备份。DNG、JPG 等内嵌元数据格式需在目标软件单独验收。</p>
    <p className="muted">颜色使用 Red / Yellow / Green / Blue / Purple 标签文本，显示颜色取决于软件的标签设置。初选、精修、交付同时写入 PhotoCull 关键词。</p>
    {error && <p className="error">{error}</p>}
    <div className="modal-actions"><button disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy || !ids.length || ids.length > 10000} onClick={() => void download()}>{busy ? '生成中…' : '下载 XMP ZIP'}</button></div>
  </section></div>;
}
