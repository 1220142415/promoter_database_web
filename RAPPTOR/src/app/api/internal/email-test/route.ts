import { serviceSecretMatches } from '@/features/prediction/tickets';

export const dynamic = 'force-dynamic';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'RAPPtor <no-reply@auth.email.duolalab.qzz.io>';
const NO_STORE = { 'Cache-Control': 'no-store' };

function maskedMessageId(value: string) {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : 'accepted';
}

export async function POST(request: Request) {
  const apiKey = process.env.RESEND_API_KEY;
  const recipient = process.env.RESEND_TEST_TO;
  const expectedToken = process.env.RAPPTOR_EMAIL_TEST_TOKEN;
  if (!apiKey || !recipient || !expectedToken) {
    return Response.json({ accepted: false, error: 'Email test is not configured.' }, { status: 503, headers: NO_STORE });
  }

  const authorization = request.headers.get('authorization');
  const providedToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
  if (!serviceSecretMatches(providedToken, expectedToken)) {
    return Response.json({ accepted: false }, { status: 401, headers: NO_STORE });
  }

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || DEFAULT_FROM,
        to: [recipient],
        subject: 'RAPPtor email delivery test',
        text: 'This is a one-time RAPPtor delivery test through Cloudflare Worker and Resend.',
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return Response.json({ accepted: false, error: 'Resend could not be reached.' }, { status: 502, headers: NO_STORE });
  }

  if (!response.ok) {
    return Response.json({ accepted: false, providerStatus: response.status }, { status: 502, headers: NO_STORE });
  }
  const result = await response.json().catch(() => null) as { id?: unknown } | null;
  if (typeof result?.id !== 'string' || !result.id) {
    return Response.json({ accepted: false, error: 'Resend returned no message ID.' }, { status: 502, headers: NO_STORE });
  }
  return Response.json({
    accepted: true,
    messageId: maskedMessageId(result.id),
    submittedAt: new Date().toISOString(),
  }, { headers: NO_STORE });
}
