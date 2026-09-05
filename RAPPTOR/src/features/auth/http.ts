import 'server-only';

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function readJsonObject(request: Request, maxBytes = 16 * 1024): Promise<Record<string, unknown> | null> {
  if (request.method !== 'POST') return null;
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function isEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
