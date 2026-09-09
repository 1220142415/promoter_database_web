import 'server-only';
import { predictionAccessMode } from '@/features/email-system/access-mode';
import { readAuthSettings } from '@/features/email-system/supabase';
import { readPredictionTicketSettings } from './tickets';
import { checkLocalPredictionTestAvailability, localPredictionTestEnabled } from './local-test';

export type QueuedPredictionCapabilities = {
  available: boolean;
  modelVersion: string;
  supportsScoreCutoff: boolean;
  supportsPeakCalling?: boolean;
  gff3RequiresStride1?: boolean;
  siteKey: string;
  reason?: string;
  submissionIssue?: string;
};

export function queuedPredictionLocalTest(headers: Pick<Headers, 'get'> = new Headers()) {
  return localPredictionTestEnabled(headers);
}

export async function queuedPredictionCapabilities(localTest = false): Promise<QueuedPredictionCapabilities> {
  const base = process.env.RAPPTOR_PREDICTION_SERVICE_URL?.trim().replace(/\/+$/, '');
  const modelVersion = process.env.RAPPTOR_PREDICTION_MODEL_VERSION || 'candidate-github-93cf';
  const siteKey = process.env.NEXT_PUBLIC_RAPPTOR_TURNSTILE_SITE_KEY?.trim() || '';
  const missing: string[] = [];
  let localIssue: string | undefined;
  if (localTest) {
    try { await checkLocalPredictionTestAvailability(); }
    catch (cause) { localIssue = (cause as Error).message; }
  } else {
    if (predictionAccessMode() === 'email' && !readAuthSettings()) missing.push('Email sign-in');
    if (!siteKey) missing.push('human verification');
    try { readPredictionTicketSettings(); } catch { missing.push('prediction authorization'); }
  }
  const submissionIssue = localIssue || (missing.length ? `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not configured on this site. Prediction cannot be submitted yet.` : undefined);
  const initial = { available: false, modelVersion, supportsScoreCutoff: false, siteKey, submissionIssue };
  if (!base) return { ...initial, reason: 'Prediction service is not configured.' };
  try {
    const [metadata, readiness] = await Promise.all([
      fetch(`${base}/v1/models/current`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) }),
      fetch(`${base}/readyz`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) }),
    ]);
    if (!metadata.ok || !readiness.ok) throw new Error();
    const model = await metadata.json() as { model_version?: string; genome_scan?: {
      score_cutoff?: { operator?: string };
      gff3_postprocessing?: { required_stride?: number | null; smoothing?: { method?: string; sigma?: number; mode?: string }; peaks?: { distance?: number; distance_unit?: string; sample_distance_rule?: string; coordinate_resolution?: string; cutoff?: number; default_cutoff?: number; configurable_cutoff?: boolean; operator?: string; filename?: string } };
    } };
    const ready = await readiness.json() as { status?: string };
    if (model.model_version !== modelVersion) return { ...initial, reason: 'The active model does not match this deployment.' };
    if (ready.status !== 'ready') throw new Error();
    const processing = model.genome_scan?.gff3_postprocessing;
    const strideAwarePeaks = processing?.required_stride === null
      && processing.peaks?.distance_unit === 'bp'
      && processing.peaks.sample_distance_rule === 'ceil(distance_bp/stride)'
      && processing.peaks.coordinate_resolution === 'stride';
    return { ...initial, available: true, supportsScoreCutoff: model.genome_scan?.score_cutoff?.operator === '>',
      gff3RequiresStride1: processing?.required_stride === 1,
      supportsPeakCalling: (processing?.required_stride === 1 || strideAwarePeaks) && processing.smoothing?.method === 'gaussian'
        && processing.smoothing.sigma === 1 && processing.smoothing.mode === 'reflect'
        && processing.peaks?.distance === 10
        && (processing.peaks.configurable_cutoff === true || processing.peaks.cutoff === 0.9)
        && processing.peaks.operator === '>' && processing.peaks.filename === 'peaks.gff3',
    };
  } catch {
    return { ...initial, reason: 'Prediction service is temporarily unavailable. Retry shortly.' };
  }
}
