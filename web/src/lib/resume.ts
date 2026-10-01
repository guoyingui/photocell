const KEY = 'photocull.positions';
const LIMIT = 20;
interface Position { root: string; actor: string; id: string }

function positions(): Position[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is Position => entry !== null && typeof entry === 'object'
      && typeof entry.root === 'string' && typeof entry.actor === 'string' && typeof entry.id === 'string');
  } catch { return []; }
}

export function readPosition(root: string, actor = 'admin'): string | null {
  return positions().find((entry) => entry.root === root && entry.actor === actor)?.id ?? null;
}

export function rememberPosition(root: string, id: string, actor = 'admin') {
  if (!root || !id) return;
  try {
    localStorage.setItem(KEY, JSON.stringify([
      { root, actor, id }, ...positions().filter((entry) => entry.root !== root || entry.actor !== actor),
    ].slice(0, LIMIT)));
  } catch { /* 浏览器禁用本地存储时仍然可以正常选片。 */ }
}
