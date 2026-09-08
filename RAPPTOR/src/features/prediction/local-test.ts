import 'server-only';
import { PredictionTicketConfigurationError, type PredictionTaskMode } from './tickets';

type RequestHeaders = Pick<Headers, 'get'>;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

// Host/Origin checks complement the dev command's loopback-only socket binding.
// Forwarded headers never grant access; conflicting values reject it.
export function localPredictionTestEnabled(headers: RequestHeaders, requestUrl?: string, mutation = false) {
  if (process.env.NODE_ENV !== 'development'
    || process.env.RAPPTOR_DEPLOYMENT_ENV !== 'local'
    || process.env.RAPPTOR_PREDICTION_LOCAL_TEST !== 'on'
    || process.env.NEXT_PUBLIC_RAPPTOR_PREDICTION_LOCAL_TEST !== 'on') return false;
  try {
    const configured = new URL(process.env.RAPPTOR_LOCAL_TEST_ORIGIN || '');
    const host = headers.get('host');
    if (!host || !loopbackHosts.has(configured.hostname) || configured.protocol !== 'http:'
      || configured.href !== `${configured.origin}/`) return false;
    const origin = `http://${host}`;
    const actual = new URL(origin);
    if (!loopbackHosts.has(actual.hostname) || actual.port !== configured.port || actual.origin !== origin) return false;
    if (requestUrl) {
      // NextURL normalizes 127.0.0.1 and ::1 to localhost. Host and Origin still
      // have to match each other exactly; the framework URL may use that alias.
      const resolved = new URL(requestUrl);
      if (resolved.protocol !== 'http:' || !loopbackHosts.has(resolved.hostname)
        || resolved.port !== actual.port || resolved.username || resolved.password) return false;
    }
    if (headers.get('forwarded') || headers.get('cf-connecting-ip')) return false;
    const forwardedHost = headers.get('x-forwarded-host');
    const forwardedProto = headers.get('x-forwarded-proto');
    if ((forwardedHost && forwardedHost !== host) || (forwardedProto && forwardedProto !== 'http')) return false;
    const addresses = headers.get('x-forwarded-for');
    if (addresses && addresses.split(',').some((value) => !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value.trim()))) return false;
    const sentOrigin = headers.get('origin');
    if ((mutation || sentOrigin) && sentOrigin !== origin) return false;
    const site = headers.get('sec-fetch-site');
    return !site || site === 'same-origin' || (!mutation && site === 'none');
  } catch { return false; }
}

export function readLocalPredictionTestSettings() {
  const secret = process.env.RAPPTOR_LOCAL_TEST_SECRET?.trim();
  if (!secret || !/^[a-f0-9]{64}$/.test(secret)) {
    throw new PredictionTicketConfigurationError('Local real prediction testing requires a dedicated development key. Run npm run prediction:local:setup.');
  }
  if (secret === process.env.RAPPTOR_PREDICTION_SERVICE_SECRET?.trim()) {
    throw new PredictionTicketConfigurationError('The development key must be separate from the model service key.');
  }
  let origin: URL;
  try { origin = new URL(process.env.RAPPTOR_LOCAL_TEST_TICKET_ORIGIN || ''); }
  catch { throw new PredictionTicketConfigurationError('The remote test-ticket origin is not configured.'); }
  if (origin.protocol !== 'https:' || origin.href !== `${origin.origin}/`) {
    throw new PredictionTicketConfigurationError('The remote test-ticket origin must be an HTTPS origin without credentials or a path.');
  }
  return { secret, url: `${origin.origin}/api/internal/prediction-test-tickets` };
}

export class LocalPredictionTicketError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) { super(message); }
}

async function remoteTestTickets(input?: { modelVersion: string; bases: number; mode: PredictionTaskMode }) {
  const { secret, url } = readLocalPredictionTestSettings();
  let response: Response;
  try {
    response = await fetch(url, {
      method: input ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      ...(input ? { body: JSON.stringify(input) } : {}),
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new LocalPredictionTicketError('TEST_TICKETS_UNAVAILABLE', 'The remote test-ticket service could not be reached. Check its deployment and retry.', 503); }
  if (!response.ok) {
    let upstreamCode: string | undefined;
    try {
      const result = await response.json() as { error?: { code?: unknown } };
      if (typeof result?.error?.code === 'string') upstreamCode = result.error.code;
    } catch { /* Use the status-only fallback below. */ }
    const retryAfter = Number(response.headers.get('retry-after'));
    const retryAfterSeconds = Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
    const limitErrors: Record<string, string> = {
      TICKET_RATE_LIMIT_REACHED: `The local development ticket limit has been reached.${retryAfterSeconds ? ` Retry in ${retryAfterSeconds} seconds.` : ' Retry shortly.'}`,
      GENOME_SCAN_DAILY_LIMIT_REACHED: 'The local development daily genome-scan limit has been reached. Retry after 00:00 Beijing time.',
      DAILY_BASE_LIMIT_REACHED: 'The local development daily base limit has been reached. Retry after 00:00 Beijing time.',
    };
    if (response.status === 429 && upstreamCode && limitErrors[upstreamCode]) {
      throw new LocalPredictionTicketError(upstreamCode, limitErrors[upstreamCode], 429, retryAfterSeconds);
    }
    const errors: Record<number, [string, string]> = {
      400: ['INVALID_REQUEST', 'The remote test-ticket service rejected the model or input size.'],
      401: ['TEST_KEY_REJECTED', 'The remote test-ticket service rejected the development key. Check the Cloudflare Secret.'],
      403: ['TEST_KEY_REJECTED', 'The remote test-ticket service denied development access.'],
      404: ['TEST_TICKETS_DISABLED', 'The remote test-ticket endpoint is not deployed or its development key is disabled.'],
      413: ['INPUT_TOO_LARGE', 'Input exceeds the remote test-ticket base limit.'],
      429: ['RATE_LIMITED', 'The remote test-ticket limit has been reached. Retry after the limit resets.'],
    };
    const [code, message] = errors[response.status] || ['TEST_TICKETS_UNAVAILABLE', 'The remote test-ticket service or its D1 configuration is unavailable.'];
    throw new LocalPredictionTicketError(code, message, errors[response.status] ? response.status : 503, retryAfterSeconds);
  }
  try {
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid ticket response.');
    return result as Record<string, unknown>;
  }
  catch { throw new LocalPredictionTicketError('TEST_TICKETS_UNAVAILABLE', 'The remote test-ticket service returned an invalid response.', 502); }
}

export async function checkLocalPredictionTestAvailability() {
  const result = await remoteTestTickets();
  if (result?.available !== true || result.modelVersion !== process.env.RAPPTOR_PREDICTION_MODEL_VERSION) {
    throw new PredictionTicketConfigurationError('The remote test-ticket configuration does not match the selected model.');
  }
}

export async function requestLocalPredictionTicket(input: { modelVersion: string; bases: number; mode: PredictionTaskMode }) {
  const result = await remoteTestTickets(input);
  if (typeof result?.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.ticket)
    || result.modelVersion !== input.modelVersion || result.maxBases !== input.bases
    || typeof result.expiresAt !== 'string' || !(Date.parse(result.expiresAt) > Date.now())) {
    throw new LocalPredictionTicketError('TEST_TICKETS_UNAVAILABLE', 'The remote test-ticket service returned an invalid or expired ticket.', 502);
  }
  return {
    ticket: result.ticket, expiresAt: result.expiresAt,
    modelVersion: input.modelVersion, maxBases: input.bases,
    inputRequirements: { completeGenomeRequired: true, conditioning: 'CGR_128x128' },
  };
}
