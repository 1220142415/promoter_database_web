import type {
  PredictionApiError,
  PredictionCapabilities,
  PredictionJob,
  PredictionResult,
  PredictionTicketResponse,
  PredictionUploadSlot,
} from './types';

export class PredictionClientError extends Error {
  code: string;
  retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'PredictionClientError';
    this.code = code;
    this.retryable = retryable;
  }
}

export async function predictionApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => null) as T | PredictionApiError | null;
  if (!response.ok) {
    const error = (payload as PredictionApiError | null)?.error;
    throw new PredictionClientError(error?.code || 'PREDICTION_REQUEST_FAILED', error?.message || 'Prediction request failed.', Boolean(error?.retryable));
  }
  return payload as T;
}

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function sha256Text(value: string) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export async function sha256File(file: File) {
  return hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
}

export type { PredictionCapabilities, PredictionJob, PredictionResult, PredictionTicketResponse, PredictionUploadSlot };
