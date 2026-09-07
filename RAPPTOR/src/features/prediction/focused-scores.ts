export type FocusedScore = { strand: '+' | '-'; score: number; window_start_0based: number; anchor_position_0based: number };

export function parseFocusedScores(value: unknown, bothStrands = true): FocusedScore[] {
  if (!Array.isArray(value) || value.length !== (bothStrands ? 2 : 1)) throw new Error('The 100 bp score artifact has an unexpected number of windows.');
  const rows = value as FocusedScore[];
  const strands = new Set<string>();
  for (const row of rows) {
    if (!row || (row.strand !== '+' && row.strand !== '-') || strands.has(row.strand)
      || typeof row.score !== 'number' || !Number.isFinite(row.score) || row.score < 0 || row.score > 1
      || row.window_start_0based !== 0 || !Number.isInteger(row.anchor_position_0based)
      || row.anchor_position_0based < 0 || row.anchor_position_0based >= 100) throw new Error('The 100 bp score artifact is invalid.');
    strands.add(row.strand);
  }
  if (!strands.has('+')) throw new Error('The forward-strand score is missing.');
  return [...rows].sort((left, right) => left.strand === right.strand ? 0 : left.strand === '+' ? -1 : 1);
}
