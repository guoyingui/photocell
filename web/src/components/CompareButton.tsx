import { useView } from '../store/view';

export function CompareButton({ order }: { order: string[] }) {
  const selection = useView((s) => s.selection);
  const openCompare = useView((s) => s.openCompare);
  const visible = new Set(order);
  const ids = [...selection].filter((id) => visible.has(id));
  return <button type="button" disabled={ids.length !== 2}
    title="选中两张照片并排对比（C）" onClick={() => openCompare(ids[0], ids[1])}>对比</button>;
}
