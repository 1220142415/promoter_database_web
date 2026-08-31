import 'server-only';

export type PredictionJobEvent = {
  jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  mode: 'predict' | 'genome_scan';
  modelVersion: string;
  inputBases: number;
  inputSha256: string;
  submittedAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
  artifactsExpiresAt?: string | null;
  checkpointSha256?: string | null;
  modelConfigSha256?: string | null;
  artifacts?: unknown[] | null;
  error?: { type?: string; message?: string } | null;
};

const JOB_ID = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;

export function parsePredictionJobEvent(value: unknown): PredictionJobEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (typeof event.jobId !== 'string' || !JOB_ID.test(event.jobId)
    || !['queued', 'running', 'succeeded', 'failed'].includes(String(event.status))
    || !['predict', 'genome_scan'].includes(String(event.mode))
    || typeof event.modelVersion !== 'string' || !event.modelVersion || event.modelVersion.length > 200
    || !Number.isSafeInteger(event.inputBases) || Number(event.inputBases) <= 0
    || typeof event.inputSha256 !== 'string' || !SHA256.test(event.inputSha256)
    || typeof event.submittedAt !== 'string' || !ISO_DATE.test(event.submittedAt)) return null;
  return event as PredictionJobEvent;
}

export async function writePredictionJobEvent(database: D1Database, event: PredictionJobEvent, now = new Date()) {
  const artifacts = event.artifacts == null ? null : JSON.stringify(event.artifacts);
  if (artifacts && new TextEncoder().encode(artifacts).byteLength > 64 * 1024) throw new Error('Artifact manifest is too large.');
  const result = await database.prepare(`INSERT INTO prediction_jobs
      (job_id, status, mode, model_version, input_bases, input_sha256,
       checkpoint_sha256, model_config_sha256, artifacts_json, error_type, error_message,
       submitted_at, started_at, ended_at, artifacts_expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      status = excluded.status,
      checkpoint_sha256 = COALESCE(excluded.checkpoint_sha256, prediction_jobs.checkpoint_sha256),
      model_config_sha256 = COALESCE(excluded.model_config_sha256, prediction_jobs.model_config_sha256),
      artifacts_json = COALESCE(excluded.artifacts_json, prediction_jobs.artifacts_json),
      error_type = excluded.error_type,
      error_message = excluded.error_message,
      started_at = COALESCE(excluded.started_at, prediction_jobs.started_at),
      ended_at = COALESCE(excluded.ended_at, prediction_jobs.ended_at),
      artifacts_expires_at = COALESCE(excluded.artifacts_expires_at, prediction_jobs.artifacts_expires_at),
      updated_at = excluded.updated_at
    WHERE prediction_jobs.mode = excluded.mode
      AND prediction_jobs.model_version = excluded.model_version
      AND prediction_jobs.input_bases = excluded.input_bases
      AND prediction_jobs.input_sha256 = excluded.input_sha256
      AND CASE prediction_jobs.status
        WHEN 'queued' THEN excluded.status IN ('queued', 'running', 'succeeded', 'failed')
        WHEN 'running' THEN excluded.status IN ('running', 'succeeded', 'failed')
        WHEN 'succeeded' THEN excluded.status = 'succeeded'
        WHEN 'failed' THEN excluded.status = 'failed'
      END`)
    .bind(
      event.jobId, event.status, event.mode, event.modelVersion, event.inputBases, event.inputSha256,
      event.checkpointSha256 || null, event.modelConfigSha256 || null, artifacts,
      event.error?.type?.slice(0, 200) || null, event.error?.message?.slice(0, 500) || null,
      event.submittedAt, event.startedAt || null, event.endedAt || null,
      event.artifactsExpiresAt || null, now.toISOString(),
    )
    .run();
  return Number(result.meta?.changes) === 1;
}
