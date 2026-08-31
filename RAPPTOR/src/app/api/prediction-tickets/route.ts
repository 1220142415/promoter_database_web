import { usageDatabase } from '@/features/usage/store';
import {
  issuePredictionTicket,
  PredictionTicketConfigurationError,
  PredictionTicketInputError,
  PredictionTicketLimitError,
  readPredictionTicketSettings,
  verifyTurnstile,
} from '@/features/prediction/tickets';

export const dynamic = 'force-dynamic';
const MAX_TICKET_REQUEST_BYTES = 16 * 1024;

function localTestEnabled(request: Request) {
  // This branch is intentionally opt-in and must be paired with the explicit
  // local deployment marker; production deployments never set either value.
  void request;
  return process.env.RAPPTOR_DEPLOYMENT_ENV === 'local'
    && process.env.RAPPTOR_PREDICTION_LOCAL_TEST?.trim().toLowerCase() === 'on';
}

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_TICKET_REQUEST_BYTES) {
      return Response.json({ error: { code: 'INPUT_TOO_LARGE', message: 'Prediction ticket request is too large.' } }, { status: 413 });
    }
    let body: { turnstileToken?: unknown; modelVersion?: unknown; bases?: unknown };
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_TICKET_REQUEST_BYTES) {
        return Response.json({ error: { code: 'INPUT_TOO_LARGE', message: 'Prediction ticket request is too large.' } }, { status: 413 });
      }
      body = JSON.parse(raw) as typeof body;
    } catch {
      return Response.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid prediction ticket request.' } }, { status: 400 });
    }
    if (typeof body.turnstileToken !== 'string' || !body.turnstileToken || body.turnstileToken.length > 4096
      || typeof body.modelVersion !== 'string' || body.modelVersion.length > 200 || typeof body.bases !== 'number') {
      return Response.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid prediction ticket request.' } }, { status: 400 });
    }
    if (localTestEnabled(request)) {
      const modelVersion = process.env.RAPPTOR_PREDICTION_MODEL_VERSION?.trim() || 'candidate-github-93cf';
      const maxBases = Number(process.env.RAPPTOR_PREDICTION_MAX_BASES || 6_000_000);
      if (body.modelVersion !== modelVersion || !Number.isSafeInteger(body.bases) || body.bases <= 0 || body.bases > maxBases) {
        return Response.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid local prediction test request.' } }, { status: 400 });
      }
      return Response.json({
        ticket: `local-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        modelVersion,
        maxBases,
        inputRequirements: { completeGenomeRequired: true, conditioning: 'CGR_128x128' },
      }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
    }
    const settings = readPredictionTicketSettings();
    const database = usageDatabase();
    if (!database) return Response.json({ error: { code: 'UNAVAILABLE', message: 'Prediction database is unavailable.' } }, { status: 503 });
    const address = request.headers.get('cf-connecting-ip')?.trim();
    if (!address || address.length > 64) return Response.json({ error: { code: 'INVALID_REQUEST', message: 'Client address is unavailable.' } }, { status: 400 });
    if (!await verifyTurnstile(body.turnstileToken, address, settings.turnstileSecret)) {
      return Response.json({ error: { code: 'TURNSTILE_REJECTED', message: 'Human verification failed.' } }, { status: 403 });
    }
    const ticket = await issuePredictionTicket(database, settings, {
      address,
      modelVersion: body.modelVersion,
      bases: body.bases,
    });
    return Response.json(ticket, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (cause) {
    if (cause instanceof PredictionTicketInputError) {
      return Response.json({ error: { code: cause.code, message: cause.message } }, { status: cause.code === 'INPUT_TOO_LARGE' ? 413 : 400 });
    }
    if (cause instanceof PredictionTicketLimitError) {
      return Response.json({ error: { code: 'RATE_LIMITED', message: cause.message } }, { status: 429, headers: { 'Retry-After': '60' } });
    }
    if (cause instanceof PredictionTicketConfigurationError) {
      return Response.json({ error: { code: 'UNAVAILABLE', message: cause.message } }, { status: 503 });
    }
    return Response.json({ error: { code: 'UNAVAILABLE', message: 'Prediction ticket service is unavailable.' } }, { status: 503 });
  }
}
