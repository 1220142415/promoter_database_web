import { serviceSecretMatches } from '@/features/prediction/tickets';
import { sendRappTorEmail } from '@/features/email/resend';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

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

  const result = await sendRappTorEmail({ apiKey, from: process.env.RESEND_FROM }, {
    to: recipient,
    subject: 'RAPPtor email delivery test',
    text: 'This is a one-time RAPPtor delivery test through Cloudflare Worker and Resend.',
  });
  if (!result.ok) {
    return Response.json({ accepted: false, ...(result.providerStatus ? { providerStatus: result.providerStatus } : { error: result.error }) }, { status: result.status, headers: NO_STORE });
  }
  return Response.json({
    accepted: true,
    messageId: result.messageId,
    submittedAt: new Date().toISOString(),
  }, { headers: NO_STORE });
}
