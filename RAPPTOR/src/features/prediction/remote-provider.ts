import 'server-only';

import type { CreatedPredictionJob, PredictionProvider } from './provider';
import { PredictionProviderError } from './provider';
import type {
  PredictionJob,
  PredictionResult,
  PredictionSubmission,
  PredictionTicketRequest,
  PredictionTicketResponse,
  PredictionUploadRequest,
  PredictionUploadSlot,
} from './types';
import { predictionCapabilities } from './capabilities';

export class RemotePredictionProvider implements PredictionProvider {
  private readonly baseUrl: string;
  private readonly serviceToken: string;

  constructor() {
    const capabilities = predictionCapabilities();
    if (!capabilities.available) {
      throw new PredictionProviderError('PREDICTION_UNAVAILABLE', capabilities.unavailableReason || 'Remote prediction is not configured.', 503, true);
    }
    this.baseUrl = String(process.env.RAPPTOR_PREDICTION_API_BASE_URL).replace(/\/+$/, '');
    this.serviceToken = String(process.env.RAPPTOR_PREDICTION_SERVICE_TOKEN);
  }

  capabilities() {
    return predictionCapabilities();
  }

  issueTicket(request: PredictionTicketRequest) {
    return this.request<PredictionTicketResponse>('/v1/tickets', { method: 'POST', body: JSON.stringify(request) });
  }

  createUpload(request: PredictionUploadRequest) {
    return this.request<PredictionUploadSlot>('/v1/uploads', { method: 'POST', body: JSON.stringify(request) });
  }

  createJob(submission: PredictionSubmission) {
    return this.request<CreatedPredictionJob>('/v1/jobs', { method: 'POST', body: JSON.stringify(submission) });
  }

  submitJob(jobId: string, accessToken: string) {
    return this.request<PredictionJob>(`/v1/jobs/${encodeURIComponent(jobId)}/submit`, { method: 'POST' }, accessToken);
  }

  async getJob(jobId: string, accessToken: string) {
    try {
      return await this.request<PredictionJob>(`/v1/jobs/${encodeURIComponent(jobId)}`, {}, accessToken);
    } catch (error) {
      if (error instanceof PredictionProviderError && error.status === 404) return null;
      throw error;
    }
  }

  async getResult(jobId: string, accessToken: string) {
    try {
      return await this.request<PredictionResult>(`/v1/jobs/${encodeURIComponent(jobId)}/result`, {}, accessToken);
    } catch (error) {
      if (error instanceof PredictionProviderError && error.status === 404) return null;
      throw error;
    }
  }

  private async request<T>(path: string, init: RequestInit = {}, accessToken?: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: accessToken ? `Prediction ${accessToken}` : `Bearer ${this.serviceToken}`,
          ...init.headers,
        },
        cache: 'no-store',
      });
    } catch {
      throw new PredictionProviderError('PREDICTION_UPSTREAM_UNAVAILABLE', 'Prediction service could not be reached.', 503, true);
    }
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string; retryable?: boolean } } | null;
    if (!response.ok) {
      throw new PredictionProviderError(
        payload?.error?.code || 'PREDICTION_UPSTREAM_ERROR',
        payload?.error?.message || 'Prediction service returned an error.',
        response.status,
        Boolean(payload?.error?.retryable),
      );
    }
    return payload as T;
  }
}
