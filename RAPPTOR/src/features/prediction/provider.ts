import 'server-only';

import type {
  PredictionCapabilities,
  PredictionJob,
  PredictionResult,
  PredictionSubmission,
  PredictionTicketRequest,
  PredictionTicketResponse,
  PredictionUploadRequest,
  PredictionUploadSlot,
} from './types';

export interface CreatedPredictionJob {
  job: PredictionJob;
  accessToken: string;
}

export interface PredictionProvider {
  capabilities(): PredictionCapabilities;
  issueTicket(request: PredictionTicketRequest): Promise<PredictionTicketResponse>;
  createUpload(request: PredictionUploadRequest): Promise<PredictionUploadSlot>;
  createJob(submission: PredictionSubmission): Promise<CreatedPredictionJob>;
  submitJob(jobId: string, accessToken: string): Promise<PredictionJob>;
  getJob(jobId: string, accessToken: string): Promise<PredictionJob | null>;
  getResult(jobId: string, accessToken: string): Promise<PredictionResult | null>;
}

export class PredictionProviderError extends Error {
  code: string;
  status: number;
  retryable: boolean;

  constructor(code: string, message: string, status = 400, retryable = false) {
    super(message);
    this.name = 'PredictionProviderError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
