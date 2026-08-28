import 'server-only';

import { DemoPredictionProvider } from './demo-provider';
import { RemotePredictionProvider } from './remote-provider';
import type { PredictionProvider } from './provider';
import { PredictionProviderError } from './provider';
import { predictionCapabilities, predictionMode } from './capabilities';
import { accessCookieName } from './validation';

let demoProvider: DemoPredictionProvider | null = null;

export function predictionProvider(): PredictionProvider {
  if (predictionMode() === 'remote') return new RemotePredictionProvider();
  demoProvider ??= new DemoPredictionProvider();
  return demoProvider;
}

export function demoPredictionProvider(): DemoPredictionProvider {
  demoProvider ??= new DemoPredictionProvider();
  return demoProvider;
}

export function predictionProviderForJob(jobId: string): PredictionProvider {
  return jobId.startsWith('demo_') ? demoPredictionProvider() : predictionProvider();
}

export function predictionAccessCookie(jobId: string, accessToken: string) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${accessCookieName(jobId)}=${encodeURIComponent(accessToken)}; HttpOnly; SameSite=Lax; Path=/api/predictions/${jobId}; Max-Age=604800${secure}`;
}

export async function verifyPredictionTurnstile(token: string, remoteIp?: string | null) {
  const capabilities = predictionCapabilities();
  if (capabilities.mode === 'demo') return token === 'demo-turnstile-bypass';
  const secret = process.env.RAPPTOR_TURNSTILE_SECRET_KEY;
  if (!secret) throw new PredictionProviderError('PREDICTION_UNAVAILABLE', 'Turnstile secret is not configured.', 503, true);
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);
  let response: Response;
  try {
    response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      cache: 'no-store',
    });
  } catch {
    throw new PredictionProviderError('TURNSTILE_UNAVAILABLE', 'Turnstile verification is temporarily unavailable.', 503, true);
  }
  const result = await response.json().catch(() => null) as { success?: boolean } | null;
  return Boolean(response.ok && result?.success);
}

export function predictionClientIp(request: Request) {
  return request.headers.get('cf-connecting-ip') || null;
}
