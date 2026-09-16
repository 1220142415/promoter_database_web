import 'server-only';

export type PredictionServerStatus = {
  status: 'idle' | 'busy' | 'offline';
  waiting: { genomes: number; shortSequences: number };
  running: { genomes: number; shortSequences: number };
};

const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const offline = (): PredictionServerStatus => ({ status: 'offline', waiting: { genomes: 0, shortSequences: 0 }, running: { genomes: 0, shortSequences: 0 } });

export async function readPredictionServerStatus(): Promise<PredictionServerStatus> {
  const base = process.env.RAPPTOR_PREDICTION_SERVICE_URL?.trim().replace(/\/+$/, '');
  if (!base) return offline();
  try {
    const response = await fetch(`${base}/v1/status`, { cache: 'no-store', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return offline();
    const payload = await response.json() as {
      status?: unknown;
      worker_ready?: unknown;
      queues?: { predict?: unknown; genome_scan?: unknown };
      workload?: { running?: { predict?: { jobs?: unknown }; genome_scan?: { jobs?: unknown } } };
    };
    const waiting = { genomes: count(payload.queues?.genome_scan), shortSequences: count(payload.queues?.predict) };
    const running = {
      genomes: count(payload.workload?.running?.genome_scan?.jobs),
      shortSequences: count(payload.workload?.running?.predict?.jobs),
    };
    const jobs = waiting.genomes + waiting.shortSequences + running.genomes + running.shortSequences;
    const ready = payload.status === 'ready' && payload.worker_ready === true;
    return { status: ready ? (jobs ? 'busy' : 'idle') : 'offline', waiting, running };
  } catch {
    return offline();
  }
}
