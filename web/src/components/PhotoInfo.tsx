import { useLibrary } from '../store/library';
import { useView } from '../store/view';
import { useReview } from '../store/review';
import { META_FIELDS, formatMeta } from '../lib/photoFilters';
import { PhotoNote } from './PhotoNote';
import { OpinionInfo } from './OpinionInfo';
import { AnnotationEditor } from './AnnotationEditor';
import { PreviewInfo } from './PreviewInfo';

export function PhotoInfo({ id }: { id: string | null }) {
  const open = useView((s) => s.infoOpen);
  const asset = useLibrary((s) => s.assets.find((entry) => entry.id === id));
  const meta = useLibrary((s) => id ? s.metas.get(id) : undefined);
  const metaDone = useLibrary((s) => s.metaDone);
  const seen = useReview((s) => id !== null && s.reviewed.has(id));
  if (!open) return null;
  return <aside className="photo-info" aria-label="照片信息">
    <div className="photo-info-title"><strong>照片信息</strong>
      <button onClick={() => useView.getState().toggleInfo()} aria-label="关闭照片信息">×</button></div>
    {!asset ? <p className="muted">选择一张照片查看拍摄参数</p> : <>
      <p className="photo-info-name">{asset.stem}</p>
      <p className="muted">{seen ? '已看过' : '还没看'}</p>
      {!asset.jpg && <PreviewInfo key={asset.id} id={asset.id} />}
      <dl>
        <dt>所在目录</dt><dd>{asset.dir || '根目录'}</dd>
        <dt>RAW</dt><dd>{asset.raws.join('、') || '无 RAW'}</dd>
        <dt>JPG</dt><dd>{asset.jpg || '无 JPG'}</dd>
        <dt>{meta?.timeSource === 'mtime' ? '文件时间' : '拍摄时间'}</dt>
        <dd>{meta?.time ? new Date(meta.time).toLocaleString('zh-CN') : '未知'}</dd>
        {META_FIELDS.map(({ key, label }) => <div className="photo-info-field" key={key}>
          <dt>{label}</dt><dd>{formatMeta(key, meta?.[key])}</dd>
        </div>)}
      </dl>
      {!meta && <p className="muted">{metaDone ? '未能读取拍摄参数' : '正在读取拍摄参数…'}</p>}
      <PhotoNote id={asset.id} />
      <OpinionInfo id={asset.id} />
      <AnnotationEditor id={asset.id} />
    </>}
  </aside>;
}
