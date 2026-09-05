import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { CreatedPredictionJob, PredictionProvider } from './provider';
import { PredictionProviderError } from './provider';
import type {
  PredictionJob,
  PredictionResult,
  PredictionScorePoint,
  PredictionSubmission,
  PredictionTicketRequest,
  PredictionTicketResponse,
  PredictionUploadRequest,
  PredictionUploadSlot,
  PredictionWindowResult,
} from './types';
import { PREDICTION_CONTRACT_VERSION, PREDICTION_WINDOW_BASES } from './types';
import { predictionCapabilities } from './capabilities';

interface DemoTicketRecord {
  request: PredictionTicketRequest;
  expiresAt: number;
  used: boolean;
}

interface DemoUploadRecord extends PredictionUploadRequest {
  expiresAt: number;
}

interface DemoJobRecord {
  submission: PredictionSubmission;
  accessToken: string;
  createdAt: number;
  submittedAt: number | null;
}

interface DemoState {
  tickets: Map<string, DemoTicketRecord>;
  uploads: Map<string, DemoUploadRecord>;
  jobs: Map<string, DemoJobRecord>;
}

interface D1TicketRow {
  request_json: string;
  expires_at_ms: number;
  used_marker: string | null;
}

interface D1UploadRow {
  request_json: string;
  expires_at_ms: number;
}

interface D1JobRow {
  access_token_hash: string;
  submission_json: string;
  created_at_ms: number;
  submitted_at_ms: number | null;
}

type LegacyPredictionSubmission = Omit<PredictionSubmission, 'contractVersion' | 'predictionKind'> & {
  contractVersion: 1;
  predictionKind?: undefined;
};

declare global {
  var __rapptorPredictionDemoState: DemoState | undefined;
}

function state(): DemoState {
  if (!globalThis.__rapptorPredictionDemoState) {
    globalThis.__rapptorPredictionDemoState = {
      tickets: new Map(),
      uploads: new Map(),
      jobs: new Map(),
    };
  }
  return globalThis.__rapptorPredictionDemoState;
}

function opaqueToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

function tokenHash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function demoDatabase(): D1Database | null {
  try {
    return getCloudflareContext().env.RAPPTOR_DB ?? null;
  } catch {
    return null;
  }
}

export function normalizeStoredPredictionSubmission(value: PredictionSubmission | LegacyPredictionSubmission): PredictionSubmission {
  return {
    ...value,
    contractVersion: PREDICTION_CONTRACT_VERSION,
    predictionKind: 'candidate',
  };
}

function fromD1Job(row: D1JobRow): DemoJobRecord {
  return {
    submission: normalizeStoredPredictionSubmission(JSON.parse(row.submission_json) as PredictionSubmission | LegacyPredictionSubmission),
    accessToken: '',
    createdAt: Number(row.created_at_ms),
    submittedAt: row.submitted_at_ms === null ? null : Number(row.submitted_at_ms),
  };
}

function storedTicketRequest(request: PredictionTicketRequest) {
  return { ...request, turnstileToken: 'verified' };
}

function storedUploadRequest(request: PredictionUploadRequest) {
  return { ...request, ticket: 'consumed' };
}

function storedSubmission(submission: PredictionSubmission): PredictionSubmission {
  return {
    ...normalizeStoredPredictionSubmission(submission),
    ticket: 'consumed',
    target: { ...submission.target, sequence: undefined },
  };
}

function demoJob(record: DemoJobRecord, jobId: string): PredictionJob {
  const submission = normalizeStoredPredictionSubmission(record.submission as PredictionSubmission | LegacyPredictionSubmission);
  const now = Date.now();
  const started = record.submittedAt;
  let stateValue: PredictionJob['state'] = 'queued';
  let progress = 5;
  let message = started ? 'Demo job is queued.' : 'Waiting for submission confirmation.';
  if (started !== null) {
    const elapsed = now - started;
    if (elapsed >= 1_500) {
      stateValue = 'succeeded';
      progress = 100;
      message = 'Demo result ready; no model was run.';
    } else if (elapsed >= 500) {
      stateValue = 'running';
      progress = Math.min(88, 35 + Math.floor((elapsed - 500) / 18));
      message = 'Simulating CGR-conditioned scoring.';
    }
  }
  return {
    contractVersion: PREDICTION_CONTRACT_VERSION,
    predictionKind: 'candidate',
    jobId,
    state: stateValue,
    progress,
    modelVersion: submission.modelVersion,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(now).toISOString(),
    resultAvailable: stateValue === 'succeeded',
    demo: true,
    message,
  };
}

function resultSeries(length: number, strandMode: PredictionSubmission['strandMode']): PredictionScorePoint[] {
  const windows = Math.max(1, length - PREDICTION_WINDOW_BASES + 1);
  const pointCount = Math.min(25, windows);
  const step = pointCount === 1 ? 0 : (windows - 1) / (pointCount - 1);
  return Array.from({ length: pointCount }, (_, index) => {
    const start = Math.round(index * step);
    const plus = index === Math.floor(pointCount * 0.62)
      ? 0.947
      : Math.min(0.886, 0.18 + Math.abs(Math.sin(index * 0.71)) * 0.61);
    const minus = strandMode === 'both'
      ? Math.min(0.914, 0.12 + Math.abs(Math.cos(index * 0.53)) * 0.68)
      : null;
    return { windowStart: start + 1, plus: Number(plus.toFixed(3)), minus: minus === null ? null : Number(minus.toFixed(3)) };
  });
}

export function topPromoterWindows(series: PredictionScorePoint[]): PredictionWindowResult[] {
  const candidates = series.flatMap((point) => [
    { probability: point.plus, strand: '+' as const, promoterStart: point.windowStart, promoterEnd: point.windowStart + PREDICTION_WINDOW_BASES - 1 },
    ...(point.minus === null ? [] : [{ probability: point.minus, strand: '-' as const, promoterStart: point.windowStart, promoterEnd: point.windowStart + PREDICTION_WINDOW_BASES - 1 }]),
  ]).sort((a, b) => b.probability - a.probability).slice(0, 5);
  return candidates.map((item, index) => ({ rank: index + 1, ...item }));
}

function demoResult(record: DemoJobRecord, jobId: string): PredictionResult {
  const submission = normalizeStoredPredictionSubmission(record.submission as PredictionSubmission | LegacyPredictionSubmission);
  const series = resultSeries(submission.target.length, submission.strandMode);
  const windows = topPromoterWindows(series);
  const top = windows[0];
  const genome = submission.genomeContext;
  const genomeLabel = genome.kind === 'catalog'
    ? `${genome.accession}${genome.organismName ? ` — ${genome.organismName}` : ''}`
    : genome.fileName;
  const genomeSha = genome.kind === 'catalog'
    ? createHash('sha256').update(`demo:${genome.accession}`).digest('hex')
    : genome.sha256;
  return {
    contractVersion: PREDICTION_CONTRACT_VERSION,
    predictionKind: 'candidate',
    jobId,
    demo: true,
    modelVersion: submission.modelVersion,
    probabilityThreshold: 0.9,
    highestProbability: top.probability,
    bestWindow: {
      promoterStart: top.promoterStart,
      promoterEnd: top.promoterEnd,
      strand: top.strand,
    },
    call: top.probability > 0.9 ? 'model-positive-candidate' : 'below-model-threshold',
    input: {
      length: submission.target.length,
      sha256: submission.target.sha256,
      strandMode: submission.strandMode,
    },
    genomeContext: {
      kind: genome.kind,
      label: genomeLabel,
      sha256: genomeSha,
      cgrConverterVersion: 'demo-cgr-128-v1',
    },
    scoreSeries: series,
    topWindows: windows,
    completedAt: new Date((record.submittedAt || record.createdAt) + 1_500).toISOString(),
  };
}

export class DemoPredictionProvider implements PredictionProvider {
  capabilities() {
    return predictionCapabilities();
  }

  async issueTicket(request: PredictionTicketRequest): Promise<PredictionTicketResponse> {
    if (request.turnstileToken !== 'demo-turnstile-bypass') {
      throw new PredictionProviderError('INVALID_TURNSTILE', 'Demo verification token is invalid.', 401);
    }
    const ticket = `ticket_${opaqueToken()}`;
    const expiresAt = Date.now() + 120_000;
    const database = demoDatabase();
    if (database) {
      await database.batch([
        database.prepare('INSERT INTO prediction_demo_tickets (ticket_hash, request_json, expires_at_ms, used_marker) VALUES (?, ?, ?, NULL)')
          .bind(tokenHash(ticket), JSON.stringify(storedTicketRequest(request)), expiresAt),
      ]);
    } else {
      state().tickets.set(ticket, { request, expiresAt, used: false });
    }
    return { contractVersion: PREDICTION_CONTRACT_VERSION, ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  async createUpload(request: PredictionUploadRequest): Promise<PredictionUploadSlot> {
    const uploadToken = `upload_${opaqueToken()}`;
    const expiresAt = Date.now() + 120_000;
    const database = demoDatabase();
    if (database) {
      const ticket = await database.prepare('SELECT request_json, expires_at_ms, used_marker FROM prediction_demo_tickets WHERE ticket_hash = ?')
        .bind(tokenHash(request.ticket)).first<D1TicketRow>();
      if (!ticket || Number(ticket.expires_at_ms) <= Date.now() || ticket.used_marker) {
        throw new PredictionProviderError('INVALID_TICKET', 'Prediction ticket is unknown, expired, or already used.', 401);
      }
      const ticketRequest = JSON.parse(ticket.request_json) as PredictionTicketRequest;
      if (ticketRequest.genomeBytes !== request.fileSize) {
        throw new PredictionProviderError('TICKET_SCOPE_MISMATCH', 'Genome upload exceeds its ticket scope.', 401);
      }
      await database.batch([
        database.prepare('INSERT INTO prediction_demo_uploads (upload_token_hash, request_json, expires_at_ms) VALUES (?, ?, ?)')
          .bind(tokenHash(uploadToken), JSON.stringify(storedUploadRequest(request)), expiresAt),
      ]);
    } else {
      const ticket = state().tickets.get(request.ticket);
      if (!ticket || ticket.expiresAt <= Date.now() || ticket.used) {
        throw new PredictionProviderError('INVALID_TICKET', 'Prediction ticket is unknown, expired, or already used.', 401);
      }
      if (ticket.request.genomeBytes !== request.fileSize) {
        throw new PredictionProviderError('TICKET_SCOPE_MISMATCH', 'Genome upload exceeds its ticket scope.', 401);
      }
      state().uploads.set(uploadToken, { ...request, expiresAt });
    }
    return {
      contractVersion: PREDICTION_CONTRACT_VERSION,
      uploadToken,
      uploadRequired: false,
      uploadUrl: null,
      method: null,
      headers: {},
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async createJob(submission: PredictionSubmission): Promise<CreatedPredictionJob> {
    const jobId = `demo_${opaqueToken(18)}`;
    const accessToken = opaqueToken(32);
    const record: DemoJobRecord = { submission, accessToken, createdAt: Date.now(), submittedAt: null };
    const database = demoDatabase();
    if (database) {
      const usedMarker = opaqueToken(18);
      const results = await database.batch<D1TicketRow>([
        database.prepare('UPDATE prediction_demo_tickets SET used_marker = ? WHERE ticket_hash = ? AND used_marker IS NULL AND expires_at_ms > ?')
          .bind(usedMarker, tokenHash(submission.ticket), Date.now()),
        database.prepare('SELECT request_json, expires_at_ms, used_marker FROM prediction_demo_tickets WHERE ticket_hash = ?')
          .bind(tokenHash(submission.ticket)),
      ]);
      const ticket = results[1]?.results?.[0];
      if (!ticket || ticket.used_marker !== usedMarker) {
        throw new PredictionProviderError('INVALID_TICKET', 'Prediction ticket is unknown, expired, or already used.', 401);
      }
      const ticketRequest = JSON.parse(ticket.request_json) as PredictionTicketRequest;
      if (ticketRequest.targetBases !== submission.target.length || ticketRequest.modelVersion !== submission.modelVersion) {
        throw new PredictionProviderError('TICKET_SCOPE_MISMATCH', 'Prediction submission exceeds its ticket scope.', 401);
      }
      if (submission.genomeContext.kind === 'upload') {
        const upload = await database.prepare('SELECT request_json, expires_at_ms FROM prediction_demo_uploads WHERE upload_token_hash = ?')
          .bind(tokenHash(submission.genomeContext.uploadToken)).first<D1UploadRow>();
        const uploadRequest = upload ? JSON.parse(upload.request_json) as PredictionUploadRequest : null;
        if (!upload || Number(upload.expires_at_ms) <= Date.now() || uploadRequest?.sha256 !== submission.genomeContext.sha256) {
          throw new PredictionProviderError('INVALID_UPLOAD', 'Genome upload token is unknown, expired, or mismatched.', 400);
        }
      }
      await database.batch([
        database.prepare('INSERT INTO prediction_demo_jobs (job_id, access_token_hash, submission_json, created_at_ms, submitted_at_ms) VALUES (?, ?, ?, ?, NULL)')
          .bind(jobId, tokenHash(accessToken), JSON.stringify(storedSubmission(submission)), record.createdAt),
      ]);
    } else {
      const ticket = state().tickets.get(submission.ticket);
      if (!ticket || ticket.expiresAt <= Date.now() || ticket.used) {
        throw new PredictionProviderError('INVALID_TICKET', 'Prediction ticket is unknown, expired, or already used.', 401);
      }
      if (ticket.request.targetBases !== submission.target.length || ticket.request.modelVersion !== submission.modelVersion) {
        throw new PredictionProviderError('TICKET_SCOPE_MISMATCH', 'Prediction submission exceeds its ticket scope.', 401);
      }
      if (submission.genomeContext.kind === 'upload') {
        const upload = state().uploads.get(submission.genomeContext.uploadToken);
        if (!upload || upload.expiresAt <= Date.now() || upload.sha256 !== submission.genomeContext.sha256) {
          throw new PredictionProviderError('INVALID_UPLOAD', 'Genome upload token is unknown, expired, or mismatched.', 400);
        }
      }
      ticket.used = true;
      state().jobs.set(jobId, record);
    }
    return { job: demoJob(record, jobId), accessToken };
  }

  async submitJob(jobId: string, accessToken: string): Promise<PredictionJob> {
    const database = demoDatabase();
    if (database) {
      const row = await this.authorizedD1(database, jobId, accessToken);
      const submittedAt = row.submitted_at_ms === null ? Date.now() : Number(row.submitted_at_ms);
      if (row.submitted_at_ms === null) {
        await database.batch([
          database.prepare('UPDATE prediction_demo_jobs SET submitted_at_ms = ? WHERE job_id = ? AND access_token_hash = ?')
            .bind(submittedAt, jobId, tokenHash(accessToken)),
        ]);
      }
      return demoJob({ ...fromD1Job(row), submittedAt }, jobId);
    }
    const record = this.authorized(jobId, accessToken);
    record.submittedAt ??= Date.now();
    return demoJob(record, jobId);
  }

  async getJob(jobId: string, accessToken: string): Promise<PredictionJob | null> {
    const database = demoDatabase();
    if (database) {
      const row = await database.prepare('SELECT access_token_hash, submission_json, created_at_ms, submitted_at_ms FROM prediction_demo_jobs WHERE job_id = ?')
        .bind(jobId).first<D1JobRow>();
      if (!row) return null;
      if (row.access_token_hash !== tokenHash(accessToken)) throw new PredictionProviderError('FORBIDDEN', 'Prediction access token is invalid.', 403);
      return demoJob(fromD1Job(row), jobId);
    }
    const record = state().jobs.get(jobId);
    if (!record) return null;
    if (record.accessToken !== accessToken) throw new PredictionProviderError('FORBIDDEN', 'Prediction access token is invalid.', 403);
    return demoJob(record, jobId);
  }

  async getResult(jobId: string, accessToken: string): Promise<PredictionResult | null> {
    const database = demoDatabase();
    if (database) {
      const row = await database.prepare('SELECT access_token_hash, submission_json, created_at_ms, submitted_at_ms FROM prediction_demo_jobs WHERE job_id = ?')
        .bind(jobId).first<D1JobRow>();
      if (!row) return null;
      if (row.access_token_hash !== tokenHash(accessToken)) throw new PredictionProviderError('FORBIDDEN', 'Prediction access token is invalid.', 403);
      const record = fromD1Job(row);
      if (demoJob(record, jobId).state !== 'succeeded') throw new PredictionProviderError('RESULT_NOT_READY', 'Prediction result is not ready.', 409, true);
      return demoResult(record, jobId);
    }
    const record = state().jobs.get(jobId);
    if (!record) return null;
    if (record.accessToken !== accessToken) throw new PredictionProviderError('FORBIDDEN', 'Prediction access token is invalid.', 403);
    if (demoJob(record, jobId).state !== 'succeeded') {
      throw new PredictionProviderError('RESULT_NOT_READY', 'Prediction result is not ready.', 409, true);
    }
    return demoResult(record, jobId);
  }

  private authorized(jobId: string, accessToken: string) {
    const record = state().jobs.get(jobId);
    if (!record) throw new PredictionProviderError('JOB_NOT_FOUND', 'Prediction job was not found.', 404);
    if (record.accessToken !== accessToken) throw new PredictionProviderError('FORBIDDEN', 'Prediction access token is invalid.', 403);
    return record;
  }

  private async authorizedD1(database: D1Database, jobId: string, accessToken: string) {
    const row = await database.prepare('SELECT access_token_hash, submission_json, created_at_ms, submitted_at_ms FROM prediction_demo_jobs WHERE job_id = ?')
      .bind(jobId).first<D1JobRow>();
    if (!row) throw new PredictionProviderError('JOB_NOT_FOUND', 'Prediction job was not found.', 404);
    if (row.access_token_hash !== tokenHash(accessToken)) throw new PredictionProviderError('FORBIDDEN', 'Prediction access token is invalid.', 403);
    return row;
  }
}

export function resetDemoPredictionState() {
  globalThis.__rapptorPredictionDemoState = undefined;
}
