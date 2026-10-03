export type OpinionFilter = 'all' | 'common' | 'conflict' | 'multiPick';
export function summarizeOpinions(votes?: Record<string, { mark: string }>): {
  picks: number; rejects: number; common: boolean; conflict: boolean; multiPick: boolean;
};
export function matchesOpinion(votes: Record<string, { mark: string }> | undefined, filter: OpinionFilter): boolean;
