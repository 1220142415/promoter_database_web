import { usageDatabase } from '@/features/usage/store';
import {
  issuePredictionTicket, PredictionTicketInputError, PredictionTicketLimitError,
  readLocalPredictionTicketIssueSettings, serviceSecretMatches,
} from '@/features/prediction/tickets';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };
const MAX_BYTES = 4096;

function denied(request: Request) {
  const secret = process.env.RAPPTOR_LOCAL_TEST_SECRET?.trim();
  if (!secret || !/^[a-f0-9]{64}$/.test(secret) || secret === process.env.RAPPTOR_PREDICTION_SERVICE_SECRET?.trim()) {
    return Response.json({ error: { code: 'TEST_TICKETS_DISABLED', message: 'Development ticket issuance is disabled.' } }, { status: 404, headers });
  }
  const auth = request.headers.get('authorization');
  if (!serviceSecretMatches(auth?.startsWith('Bearer ') ? auth.slice(7) : null, secret)) {
    return Response.json({ error: { code: 'UNAUTHORIZED', message: 'Development authorization is required.' } }, { status: 401, headers });
  }
  return null;
}

function unavailable() {
  return Response.json({ error: { code: 'UNAVAILABLE', message: 'Development ticket configuration or database is unavailable.' } }, { status: 503, headers });
}

// An authenticated readiness probe issues no ticket and consumes no quota.
export async function GET(request: Request) {
  const rejection = denied(request);
  if (rejection) return rejection;
  try {
    const settings = readLocalPredictionTicketIssueSettings();
    const database = usageDatabase();
    if (!database) return unavailable();
    await database.prepare('SELECT ticket_hash FROM prediction_tickets LIMIT 0').all();
    return Response.json({ available: true, modelVersion: settings.modelVersion, maxBases: settings.maxBases }, { headers });
  } catch { return unavailable(); }
}

export async function POST(request: Request) {
  const rejection = denied(request);
  if (rejection) return rejection;
  if (Number(request.headers.get('content-length')) > MAX_BYTES) {
    return Response.json({ error: { code: 'INPUT_TOO_LARGE', message: 'Ticket request is too large.' } }, { status: 413, headers });
  }
  let body;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) {
      return Response.json({ error: { code: 'INPUT_TOO_LARGE', message: 'Ticket request is too large.' } }, { status: 413, headers });
    }
    body = JSON.parse(raw);
    if (!body || (body.mode !== 'predict' && body.mode !== 'genome_scan')
      || typeof body.modelVersion !== 'string' || body.modelVersion.length > 200 || typeof body.bases !== 'number') throw new Error();
  } catch {
    return Response.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid development ticket request.' } }, { status: 400, headers });
  }
  try {
    const settings = readLocalPredictionTicketIssueSettings();
    const database = usageDatabase();
    if (!database) return unavailable();
    const ticket = await issuePredictionTicket(database, settings, {
      // All development clients share a separate quota. Rotation does not reset it.
      address: 'internal:local-real-prediction-test',
      modelVersion: body.modelVersion, bases: body.bases, mode: body.mode, anonymousIpLimit: true,
    });
    return Response.json(ticket, { status: 201, headers });
  } catch (cause) {
    if (cause instanceof PredictionTicketInputError) {
      return Response.json({ error: { code: cause.code, message: cause.message } }, { status: cause.code === 'INPUT_TOO_LARGE' ? 413 : 400, headers });
    }
    if (cause instanceof PredictionTicketLimitError) {
      return Response.json(
        { error: { code: cause.code, message: cause.message } },
        { status: 429, headers: { ...headers, 'Retry-After': String(cause.retryAfterSeconds) } },
      );
    }
    return unavailable();
  }
}
