/** 相同对象的两个不可变版本；备注清除也必须出现在差异中。 */
export function selectionDiff(before, after) {
  const previous = new Set(before?.pickedIds ?? []), current = new Set(after?.pickedIds ?? []);
  const oldNotes = before?.photoNotes ?? {}, newNotes = after?.photoNotes ?? {};
  return {
    added: [...current].filter((id) => !previous.has(id)),
    removed: [...previous].filter((id) => !current.has(id)),
    noteChanged: (before?.note ?? '') !== (after?.note ?? ''),
    photoNotes: [...new Set([...Object.keys(oldNotes), ...Object.keys(newNotes)])]
      .filter((id) => (oldNotes[id] ?? '') !== (newNotes[id] ?? ''))
      .map((id) => ({ id, before: oldNotes[id] ?? '', after: newNotes[id] ?? '' })),
  };
}
