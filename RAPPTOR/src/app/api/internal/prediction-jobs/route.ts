import { usageDatabase } from '@/features/usage/store';
import { parsePredictionJobEvent, writePredictionJobEvent } from '@/features/prediction/jobs';
import { PredictionTicketConfigurationError, readPredictionTicketSettings, serviceSecretMatches } from '@/features/prediction/tickets';

export const dynamic = 'force-dynamic';
const MAX_EVENT_BYTES = 80 * 1024;

export async function POST(request: Request) {
  try {
    const settings = readPredictionTicketSettings();
    const authorization = request.headers.get('authorization');
    const provided = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!serviceSecretMatches(provided, settings.serviceSecret)) return Response.json({ accepted: false }, { status: 401 });
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_EVENT_BYTES) return Response.json({ accepted: false }, { status: 413 });
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_EVENT_BYTES) return Response.json({ accepted: false }, { status: 413 });
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return Response.json({ accepted: false }, { status: 400 }); }
    const event = parsePredictionJobEvent(parsed);
    if (!event) return Response.json({ accepted: false }, { status: 400 });
    const database = usageDatabase();
    if (!database) return Response.json({ accepted: false }, { status: 503 });
    if (!await writePredictionJobEvent(database, event)) return Response.json({ accepted: false }, { status: 409 });
    return Response.json({ accepted: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (cause) {
    if (cause instanceof PredictionTicketConfigurationError) return Response.json({ accepted: false }, { status: 503 });
    return Response.json({ accepted: false }, { status: 503 });
  }
}
