import { useEffect, useState } from 'react';
import { LABELS, STAGES, normalizeAnnotation } from '../../../shared/annotations.js';
import { useAnnotations } from '../store/annotations';
import { useSession } from '../store/session';

export function AnnotationEditor({ id }: { id: string }) {
  const entry = useAnnotations((state) => state.annotations[id]);
  const ready = useAnnotations((state) => state.ready);
  const busy = useAnnotations((state) => state.busy);
  const isAdmin = useSession((state) => state.kind === 'admin');
  const [draft, setDraft] = useState(normalizeAnnotation(entry));
  const [keywords, setKeywords] = useState(draft.keywords.join('、'));
  useEffect(() => { const next = normalizeAnnotation(entry); setDraft(next); setKeywords(next.keywords.join('、')); }, [entry, id]);
  if (!isAdmin) {
    const value = normalizeAnnotation(entry);
    return <section className="annotation-editor"><strong>后期信息</strong><p>{value.rating ? `${value.rating} 星` : '未评级'} · {LABELS[value.label]} · {STAGES[value.stage]}</p>
      {value.keywords.length > 0 && <p>{value.keywords.join('、')}</p>}</section>;
  }
  return <section className="annotation-editor" aria-label="后期信息"><strong>星级、标签与阶段</strong>
    <label>星级<select value={draft.rating} disabled={!ready || busy} onChange={(event) => setDraft({ ...draft, rating: Number(event.target.value) })}>
      {[0, 1, 2, 3, 4, 5].map((rating) => <option key={rating} value={rating}>{rating ? `${rating} 星` : '未评级'}</option>)}</select></label>
    <label>颜色标签<select value={draft.label} disabled={!ready || busy} onChange={(event) => setDraft({ ...draft, label: event.target.value as typeof draft.label })}>
      {Object.entries(LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
    <label>后期阶段<select value={draft.stage} disabled={!ready || busy} onChange={(event) => setDraft({ ...draft, stage: event.target.value as typeof draft.stage })}>
      {Object.entries(STAGES).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
    <label>关键词<input value={keywords} disabled={!ready || busy} placeholder="用逗号或顿号分隔" onChange={(event) => setKeywords(event.target.value)} /></label>
    <button disabled={!ready || busy} onClick={() => void useAnnotations.getState().save([id], { ...draft, keywords: keywords.split(/[,，、]/).map((word) => word.trim()).filter(Boolean) })}>保存后期信息</button>
  </section>;
}
