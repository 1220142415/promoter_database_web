import { usageDatabase } from '@/features/usage/store';
import {
  consumePredictionTicket,
  hasPreparedPredictionReference,
  PredictionTicketConfigurationError,
  readPredictionTicketSettings,
  serviceSecretMatches,
} from '@/features/prediction/tickets';
import { resolvePredictionReferenceSource } from '@/features/prediction/reference-source';

export const dynamic = 'force-dynamic';
const MAX_CONSUME_REQUEST_BYTES = 8 * 1024;

export async function POST(request: Request) {
  try {
    const settings = readPredictionTicketSettings();
    const authorization = request.headers.get('authorization');
    const provided = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!serviceSecretMatches(provided, settings.serviceSecret)) {
      return Response.json({ allowed: false }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    }
    const database = usageDatabase();
    if (!database) return Response.json({ allowed: false }, { status: 503 });
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_CONSUME_REQUEST_BYTES) {
      return Response.json({ allowed: false }, { status: 413 });
    }
    let body: { ticket?: unknown; modelVersion?: unknown; bases?: unknown; mode?: unknown; referenceAccession?: unknown };
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_CONSUME_REQUEST_BYTES) {
        return Response.json({ allowed: false }, { status: 413 });
      }
      body = JSON.parse(raw) as typeof body;
    } catch {
      return Response.json({ allowed: false }, { status: 400 });
    }
    if (typeof body.ticket !== 'string' || typeof body.modelVersion !== 'string' || typeof body.bases !== 'number'
      || (body.mode !== 'predict' && body.mode !== 'genome_scan')) {
      return Response.json({ allowed: false }, { status: 400 });
    }
    if (body.referenceAccession !== null && body.referenceAccession !== undefined
      && (typeof body.referenceAccession !== 'string' || !/^GC[AF]_\d{9}\.[1-9]\d{0,3}$/.test(body.referenceAccession))) {
      return Response.json({ allowed: false }, { status: 400 });
    }
    const referenceSource = typeof body.referenceAccession === 'string'
      ? await resolvePredictionReferenceSource(body.referenceAccession)
      : null;
    if (body.referenceAccession && !referenceSource
      && !await hasPreparedPredictionReference(database, body.ticket, body.referenceAccession as string, body.mode)) {
      return Response.json({ allowed: false, errorCode: 'REFERENCE_CGR_NOT_FOUND' }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    const allowed = await consumePredictionTicket(database, {
      ticket: body.ticket,
      modelVersion: body.modelVersion,
      bases: body.bases,
      mode: body.mode,
      referenceAccession: typeof body.referenceAccession === 'string' ? body.referenceAccession : null,
    });
    return Response.json({ allowed, ...(allowed && referenceSource ? { referenceSource } : {}) }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (cause) {
    if (cause instanceof PredictionTicketConfigurationError) {
      return Response.json({ allowed: false }, { status: 503 });
    }
    return Response.json({ allowed: false }, { status: 503 });
  }
}
