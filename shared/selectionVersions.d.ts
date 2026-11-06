export interface SelectionVersion {
  id: string;
  subject: string;
  name: string;
  action: 'submit' | 'confirm' | 'reopen' | 'final' | 'export';
  createdAt: number;
  pickedIds: string[];
  note: string;
  photoNotes: Record<string, string>;
  finalMarks?: Record<string, { mark: 'pick' | 'reject'; at: number }>;
}
export function selectionDiff(before: SelectionVersion | null, after: SelectionVersion): {
  added: string[]; removed: string[]; noteChanged: boolean;
  photoNotes: { id: string; before: string; after: string }[];
};
