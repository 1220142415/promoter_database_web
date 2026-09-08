import { referenceWindow } from './live-result';

export const RESULT_TABLE_HEADER = 'sequence_id\twindow_start_1based\twindow_end_1based\tanchor_position_1based\tstrand\tmodel_score\n';

type TableContext = { windowLength?: number; sequenceLength?: number; coordinateSystem?: string; lengths: Map<string, number> };
type ScoreRow = { sequenceId: string; start?: number; anchor: number; strand: '+' | '-'; score: string };

function invalid(): never { throw new Error('The source result file is invalid.'); }

function integer(value: string) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) invalid();
  return Number(value);
}

function tableRow(row: ScoreRow, context: TableContext) {
  const { sequenceId, start, anchor, strand, score } = row;
  if (!sequenceId || /[\t\r\n]/.test(sequenceId) || (strand !== '+' && strand !== '-')
    || !Number.isSafeInteger(anchor) || anchor < 1 || !score.trim()
    || !Number.isFinite(Number(score)) || Number(score) < 0 || Number(score) > 1
    || (start !== undefined && (!Number.isSafeInteger(start) || start < 0))) invalid();
  const length = context.lengths.get(sequenceId) ?? context.sequenceLength;
  const window = start === undefined ? null : referenceWindow(start, strand, context.windowLength, length, context.coordinateSystem);
  if ((length !== undefined && anchor > length) || (window && (window.start < 1 || (length !== undefined && window.end > length)))) invalid();
  // Preserve the identifier, including quotes, as a TSV text field.
  const id = sequenceId.includes('"') ? `"${sequenceId.replaceAll('"', '""')}"` : sequenceId;
  return `${id}\t${window?.start ?? 'NA'}\t${window?.end ?? 'NA'}\t${anchor}\t${strand}\t${score}\n`;
}

export function parseReferenceLengths(text: string) {
  const lengths = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [id, length] = line.split('\t');
    if (!id || !length || lengths.has(id)) invalid();
    const bases = integer(length);
    if (bases < 1) invalid();
    lengths.set(id, bases);
  }
  return lengths;
}

async function* textChunks(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    yield decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

async function* gffRows(body: ReadableStream<Uint8Array>, context: TableContext) {
  let pending = '';
  let recognized = false;
  function parse(line: string) {
    line = line.replace(/\r$/, '');
    if (line === '##gff-version 3') recognized = true;
    if (line === '##RAPPtor-window-start-coordinate-system reference_0based') context = { ...context, coordinateSystem: 'reference_0based' };
    if (!line.trim() || line.startsWith('#')) return null;
    const fields = line.split('\t');
    if (fields.length !== 9) invalid();
    const anchor = integer(fields[3]);
    if (integer(fields[4]) !== anchor) invalid();
    const start = fields[8].split(';').find((field) => field.startsWith('window_start_0based='))?.slice('window_start_0based='.length);
    const row = tableRow({ sequenceId: fields[0], start: start === undefined ? undefined : integer(start), anchor, strand: fields[6] as '+' | '-', score: fields[5] }, context);
    recognized = true;
    return row;
  }
  for await (const chunk of textChunks(body)) {
    pending += chunk;
    let offset = 0;
    let end: number;
    while ((end = pending.indexOf('\n', offset)) !== -1) {
      const row = parse(pending.slice(offset, end));
      if (row) yield row;
      offset = end + 1;
    }
    pending = pending.slice(offset);
    if (pending.length > 1024 * 1024) invalid();
  }
  if (pending) { const row = parse(pending); if (row) yield row; }
  if (!recognized) invalid();
}

/** Read the JSON array one object at a time, including legacy files without line breaks. */
async function* jsonRows(body: ReadableStream<Uint8Array>, context: TableContext) {
  let state: 'array' | 'first' | 'value' | 'object' | 'separator' | 'done' = 'array';
  let pending = '';
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for await (const chunk of textChunks(body)) {
    for (const char of chunk) {
      if (state === 'object') {
        pending += char;
        if (pending.length > 1024 * 1024) invalid();
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{') depth++;
        else if (char === '}') depth--;
        if (depth === 0) {
          const row = JSON.parse(pending);
          if (typeof row.sequence_id !== 'string' || typeof row.score !== 'number'
            || !Number.isSafeInteger(row.window_start_0based) || !Number.isSafeInteger(row.anchor_position_0based)) invalid();
          yield tableRow({ sequenceId: row.sequence_id, start: row.window_start_0based, anchor: row.anchor_position_0based + 1, strand: row.strand, score: String(row.score) }, context);
          pending = '';
          state = 'separator';
        }
        continue;
      }
      if (/\s/.test(char)) continue;
      if (state === 'array' && char === '[') state = 'first';
      else if ((state === 'first' || state === 'value') && char === '{') { state = 'object'; pending = '{'; depth = 1; }
      else if ((state === 'first' || state === 'separator') && char === ']') state = 'done';
      else if (state === 'separator' && char === ',') state = 'value';
      else invalid();
    }
  }
  if (state !== 'done') invalid();
}

export async function resultTableStream(body: ReadableStream<Uint8Array>, format: 'gff3' | 'json', context: TableContext) {
  const rows = format === 'gff3' ? gffRows(body, context) : jsonRows(body, context);
  // Validate the first record (or a legitimate zero-hit result) before sending download headers.
  const first = await rows.next();
  const encoder = new TextEncoder();
  let initial = true;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (initial) {
          initial = false;
          controller.enqueue(encoder.encode(RESULT_TABLE_HEADER + (first.value || '')));
          if (first.done) controller.close();
          return;
        }
        // Batch rows without buffering the complete genome result.
        let batch = '';
        while (batch.length < 64 * 1024) {
          const next = await rows.next();
          if (next.done) { if (batch) controller.enqueue(encoder.encode(batch)); controller.close(); return; }
          batch += next.value;
        }
        controller.enqueue(encoder.encode(batch));
      } catch (error) {
        // A corrupt later record terminates the download rather than silently omitting rows.
        controller.error(error);
      }
    },
    async cancel() { await rows.return(); },
  });
}
