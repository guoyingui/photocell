export type Stage = 'initial' | 'retouch' | 'delivery';
export type ColorLabel = 'none' | 'red' | 'yellow' | 'green' | 'blue' | 'purple';
export interface Annotation { rating: number; label: ColorLabel; stage: Stage; keywords: string[] }
export interface AnnotationFilters { rating: string; label: string; stage: string; keyword: string }
export const STAGES: Record<Stage, string>;
export const LABELS: Record<ColorLabel, string>;
export const EMPTY_ANNOTATION: Annotation;
export function normalizeAnnotation(value?: unknown): Annotation;
export function matchesAnnotation(value: unknown, filters: AnnotationFilters): boolean;
