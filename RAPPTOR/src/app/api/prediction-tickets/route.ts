import { predictionErrorResponse } from '@/features/prediction/api-response';
import { predictionCapabilities } from '@/features/prediction/capabilities';
import { PredictionProviderError } from '@/features/prediction/provider';
import { predictionClientIp, predictionProvider, verifyPredictionTurnstile } from '@/features/prediction/runtime';
import { parseTicketRequest } from '@/features/prediction/validation';
import { usageDatabase } from '@/features/usage/store';
import {
  issuePredictionTicket,
  PredictionTicketConfigurationError,
  PredictionTicketInputError,
  PredictionTicketLimitError,
  readPredictionTicketSettings,
  verifyTurnstile,
} from '@/features/prediction/tickets';
import { requirePredictionAuth } from '@/features/email-system/supabase';
import { localPredictionTestEnabled, LocalPredictionTicketError, requestLocalPredictionTicket } from '@/features/prediction/local-test';

export const dynamic = 'force-dynamic';
const MAX_TICKET_REQUEST_BYTES = 16 * 1024;

export async function POST(request: Request) {
  const localTest = localPredictionTestEnabled(request.headers, request.url, true);
  const auth = localTest ? null : await requirePredictionAuth(request);
  if (auth instanceof Response) return auth;
  try {
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_TICKET_REQUEST_BYTES) {
      return Response.json({ error: { code: 'INPUT_TOO_LARGE', message: 'Prediction ticket request is too large.' } }, { status: 413 });
    }
    let body: { contractVersion?: unknown; turnstileToken?: unknown; modelVersion?: unknown; bases?: unknown; mode?: unknown };
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_TICKET_REQUEST_BYTES) {
        return Response.json({ error: { code: 'INPUT_TOO_LARGE', message: 'Prediction ticket request is too large.' } }, { status: 413 });
      }
      body = JSON.parse(raw) as typeof body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    } catch {
      return Response.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid prediction ticket request.' } }, { status: 400 });
    }
    if (body.contractVersion !== undefined) {
      // The local exception applies only to the queued model service contract.
      if (localTest) {
        const legacyAuth = await requirePredictionAuth(request);
        if (legacyAuth instanceof Response) return legacyAuth;
      }
      if (body.mode !== 'predict') {
        return Response.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid prediction task mode.' } }, { status: 400 });
      }
      const capabilities = predictionCapabilities();
      if (!capabilities.available) {
        throw new PredictionProviderError('PREDICTION_UNAVAILABLE', capabilities.unavailableReason || 'Prediction is unavailable.', 503, true);
      }
      const input = parseTicketRequest(body, capabilities);
      if (!await verifyPredictionTurnstile(input.turnstileToken, predictionClientIp(request))) {
        throw new PredictionProviderError('INVALID_TURNSTILE', 'Turnstile verification failed.', 401);
      }
      return Response.json(await predictionProvider().issueTicket(input), { status: 201, headers: { 'Cache-Control': 'no-store' } });
    }
    if ((body.mode !== 'predict' && body.mode !== 'genome_scan')
      || (!localTest && (typeof body.turnstileToken !== 'string' || !body.turnstileToken || body.turnstileToken.length > 4096))
      || typeof body.modelVersion !== 'string' || body.modelVersion.length > 200 || typeof body.bases !== 'number') {
      return Response.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid prediction ticket request.' } }, { status: 400 });
    }
    if (localTest) {
      const ticket = await requestLocalPredictionTicket({ mode: body.mode, modelVersion: body.modelVersion, bases: body.bases });
      return Response.json(ticket, { status: 201, headers: { 'Cache-Control': 'no-store' } });
    }
    const settings = readPredictionTicketSettings();
    const database = usageDatabase();
    if (!database) return Response.json({ error: { code: 'UNAVAILABLE', message: 'Prediction database is unavailable.' } }, { status: 503 });
    const address = request.headers.get('cf-connecting-ip')?.trim();
    if (!address || address.length > 64) return Response.json({ error: { code: 'INVALID_REQUEST', message: 'Client address is unavailable.' } }, { status: 400 });
    if (!await verifyTurnstile(body.turnstileToken as string, address, settings.turnstileSecret)) {
      return Response.json({ error: { code: 'TURNSTILE_REJECTED', message: 'Human verification failed.' } }, { status: 403 });
    }
    const ticket = await issuePredictionTicket(database, settings, {
      address,
      modelVersion: body.modelVersion,
      bases: body.bases,
      mode: body.mode,
    });
    return Response.json(ticket, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (cause) {
    if (cause instanceof LocalPredictionTicketError) {
      return Response.json({ error: { code: cause.code, message: cause.message } }, { status: cause.status, headers: { 'Cache-Control': 'no-store' } });
    }
    if (cause instanceof PredictionProviderError) return predictionErrorResponse(cause);
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
