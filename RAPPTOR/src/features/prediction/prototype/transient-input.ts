import type { PrototypeParsedSequenceInput } from './inputs';

/**
 * The registry exists only in this browser JavaScript context. It deliberately
 * does not use sessionStorage, localStorage, the URL, a React server action,
 * or an API route, so normalized DNA/FASTA disappears after a refresh.
 */
export interface PrototypeTransientSequenceRecord {
  sequenceId: string;
  normalizedSequence: string;
}

export interface PrototypeTransientInput {
  format: PrototypeParsedSequenceInput['format'];
  records: readonly PrototypeTransientSequenceRecord[];
}

const transientInputs = new Map<string, PrototypeTransientInput>();
const MAX_TRANSIENT_INPUTS = 6;

function copyInput(input: PrototypeParsedSequenceInput): PrototypeTransientInput {
  return {
    format: input.format,
    records: input.records.map(({ sequenceId, normalizedSequence }) => ({ sequenceId, normalizedSequence })),
  };
}

/**
 * Register a just-submitted inline/upload input before client navigation to a
 * prototype result. This is intentionally a memory-only handoff.
 */
export function registerPrototypeTransientInput(runId: string, input: PrototypeParsedSequenceInput) {
  if (!runId.trim()) throw new Error('A prototype run ID is required for transient input.');
  transientInputs.delete(runId);
  transientInputs.set(runId, copyInput(input));
  while (transientInputs.size > MAX_TRANSIENT_INPUTS) {
    const oldestRunId = transientInputs.keys().next().value;
    if (typeof oldestRunId !== 'string') break;
    transientInputs.delete(oldestRunId);
  }
}

/**
 * Return a defensive copy so consumers cannot mutate another result view's
 * in-memory input. A missing value means the page was refreshed or opened in
 * another tab and must use metadata-only illustrative fallback assets.
 */
export function readPrototypeTransientInput(runId: string): PrototypeTransientInput | null {
  const input = transientInputs.get(runId);
  if (!input) return null;
  return {
    format: input.format,
    records: input.records.map(({ sequenceId, normalizedSequence }) => ({ sequenceId, normalizedSequence })),
  };
}

/** Remove one browser-local handoff when a caller no longer needs it. */
export function clearPrototypeTransientInput(runId: string) {
  transientInputs.delete(runId);
}
