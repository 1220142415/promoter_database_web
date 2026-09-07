export type FocusedScore = { strand: '+' | '-'; score: number; window_start_0based: number; anchor_position_0based: number };

export function parseSequenceScores(value: unknown, sequenceBases: number, bothStrands = true): FocusedScore[] {
  const windowsPerStrand = sequenceBases - 99;
  if (!Number.isSafeInteger(sequenceBases) || windowsPerStrand < 1
    || !Array.isArray(value) || value.length !== windowsPerStrand * (bothStrands ? 2 : 1)) {
    throw new Error('The short-sequence score artifact has an unexpected number of windows.');
  }
  const rows = value as FocusedScore[];
  const windows = new Set<string>();
  for (const row of rows) {
    const key = `${row?.strand}|${row?.window_start_0based}`;
    if (!row || (row.strand !== '+' && row.strand !== '-') || (!bothStrands && row.strand !== '+') || windows.has(key)
      || typeof row.score !== 'number' || !Number.isFinite(row.score) || row.score < 0 || row.score > 1
      || !Number.isInteger(row.window_start_0based) || row.window_start_0based < 0 || row.window_start_0based >= windowsPerStrand
      || !Number.isInteger(row.anchor_position_0based)
      || row.anchor_position_0based < 0 || row.anchor_position_0based >= sequenceBases) throw new Error('The short-sequence score artifact is invalid.');
    windows.add(key);
  }
  if (!rows.some((row) => row.strand === '+')) throw new Error('The forward-strand score is missing.');
  return [...rows].sort((left, right) => left.strand === right.strand
    ? left.window_start_0based - right.window_start_0based
    : left.strand === '+' ? -1 : 1);
}

export function parseFocusedScores(value: unknown, bothStrands = true): FocusedScore[] {
  return parseSequenceScores(value, 100, bothStrands);
}
