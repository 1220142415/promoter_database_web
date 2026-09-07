import 'server-only';
import { readAuthSettings } from '@/features/email-system/supabase';
import { readPredictionTicketSettings } from './tickets';
import { checkLocalPredictionTestAvailability, localPredictionTestEnabled } from './local-test';

export type QueuedPredictionCapabilities = {
  available: boolean;
  modelVersion: string;
  supportsScoreCutoff: boolean;
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
    if (!readAuthSettings()) missing.push('Email sign-in');
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
    const model = await metadata.json();
    const ready = await readiness.json();
    if (model.model_version !== modelVersion) return { ...initial, reason: 'The active model does not match this deployment.' };
    if (ready.status !== 'ready') throw new Error();
    return { ...initial, available: true, supportsScoreCutoff: model.genome_scan?.score_cutoff?.operator === '>' };
  } catch {
    return { ...initial, reason: 'Prediction service is temporarily unavailable. Retry shortly.' };
  }
}
