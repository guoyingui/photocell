type Mark = 'pick' | 'reject';
export type ExportScope =
  | { kind: 'all' }
  | { kind: 'client'; clientId: string }
  | { kind: 'filtered'; clientId?: string | null; dir?: string | null; tab?: 'all' | 'pick' | 'reject' | 'none' | 'hidden'; assetIds?: string[] }
  | { kind: 'selection'; assetIds: string[] };

export function resolveExportScope<T extends { id: string; dir: string }>(
  assets: T[],
  data: {
    marks: Record<string, Mark | undefined>;
    contrib?: Record<string, Record<string, { mark: Mark; at: number }> | undefined>;
    hidden?: Iterable<string>;
  },
  scope?: ExportScope,
): { assets: T[]; marks: Record<string, Mark | undefined> };
