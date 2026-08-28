import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as getCapabilities } from '@/app/api/predictions/capabilities/route';
import { POST as issueTicket } from '@/app/api/prediction-tickets/route';
import { POST as createUpload } from '@/app/api/predictions/uploads/route';
import { POST as createPrediction } from '@/app/api/predictions/route';
import { POST as createDemoPrediction } from '@/app/api/predictions/demo/route';
import { GET as getPrediction } from '@/app/api/predictions/[jobId]/route';
import { POST as submitPrediction } from '@/app/api/predictions/[jobId]/submit/route';
import { GET as getResult } from '@/app/api/predictions/[jobId]/result/route';
import { resetDemoPredictionState } from '@/features/prediction/demo-provider';
import { PREDICTION_CONTRACT_VERSION, type PredictionJob, type PredictionResult, type PredictionTicketResponse, type PredictionUploadSlot } from '@/features/prediction/types';

const modelVersion = 'rapptor-cgr-100bp-demo-v1';
const bodyRequest = (url: string, body: unknown, headers?: HeadersInit) => new Request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const context = (jobId: string) => ({ params: Promise.resolve({ jobId }) });

async function ticket(genomeBytes = 0) {
  const response = await issueTicket(bodyRequest('http://localhost/api/prediction-tickets', {
    contractVersion: PREDICTION_CONTRACT_VERSION,
    turnstileToken: 'demo-turnstile-bypass',
    modelVersion,
    targetBases: 120,
    genomeBytes,
  }));
  expect(response.status).toBe(201);
  return await response.json() as PredictionTicketResponse;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-28T06:00:00.000Z'));
  process.env.RAPPTOR_PREDICTION_MODE = 'demo';
  resetDemoPredictionState();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.RAPPTOR_PREDICTION_MODE;
  delete process.env.RAPPTOR_PREDICTION_API_BASE_URL;
  delete process.env.RAPPTOR_PREDICTION_SERVICE_TOKEN;
  delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  delete process.env.RAPPTOR_TURNSTILE_SECRET_KEY;
});

describe('prediction API contract', () => {
  it('publishes demo capabilities without a Turnstile site key', async () => {
    const response = getCapabilities();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ contractVersion: PREDICTION_CONTRACT_VERSION, supportedPredictionKinds: ['candidate'], mode: 'demo', serviceStatus: 'demo', demoPreviewAvailable: true, available: true, windowBases: 100, predictionAnchorBase: 80, turnstileSiteKey: null });
  });

  it('creates and submits a protected demo job in one metadata-only request', async () => {
    const response = await createDemoPrediction(bodyRequest('http://localhost/api/predictions/demo', {
      contractVersion: PREDICTION_CONTRACT_VERSION,
      predictionKind: 'candidate',
      target: { format: 'raw', length: 120, sha256: 'e'.repeat(64) },
      genomeContext: { kind: 'catalog', accession: 'GCA_000411415.1', organismName: 'Test bacterium' },
      strandMode: 'both',
    }));
    expect(response.status).toBe(201);
    const job = await response.json() as PredictionJob;
    expect(job).toMatchObject({ state: 'queued', demo: true });
    expect(response.headers.get('set-cookie')).toContain(`rapptor_prediction_${job.jobId}=`);

    const rejected = await createDemoPrediction(bodyRequest('http://localhost/api/predictions/demo', {
      contractVersion: PREDICTION_CONTRACT_VERSION,
      predictionKind: 'candidate',
      target: { format: 'raw', length: 120, sha256: 'e'.repeat(64), sequence: 'A'.repeat(120) },
      genomeContext: { kind: 'catalog', accession: 'GCA_000411415.1' },
      strandMode: 'both',
    }));
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: 'RAW_SEQUENCE_NOT_ALLOWED' } });
  });

  it('consumes a ticket once and protects status/result with a separate cookie token', async () => {
    const issued = await ticket();
    const submission = {
      contractVersion: PREDICTION_CONTRACT_VERSION,
      predictionKind: 'candidate',
      ticket: issued.ticket,
      modelVersion,
      target: { format: 'raw', length: 120, sha256: 'a'.repeat(64) },
      genomeContext: { kind: 'catalog', accession: 'GCA_000411415.1', organismName: 'Test bacterium' },
      strandMode: 'both',
    };
    const createdResponse = await createPrediction(bodyRequest('http://localhost/api/predictions', submission));
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as PredictionJob;
    const setCookie = createdResponse.headers.get('set-cookie');
    expect(created.jobId).toMatch(/^demo_/);
    expect(setCookie).toContain(`rapptor_prediction_${created.jobId}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const replay = await createPrediction(bodyRequest('http://localhost/api/predictions', submission));
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toMatchObject({ error: { code: 'INVALID_TICKET' } });

    const noCookie = await getPrediction(new Request(`http://localhost/api/predictions/${created.jobId}`), context(created.jobId));
    expect(noCookie.status).toBe(401);
    const cookie = setCookie!.split(';', 1)[0];
    const submitted = await submitPrediction(new Request(`http://localhost/api/predictions/${created.jobId}/submit`, { method: 'POST', headers: { cookie } }), context(created.jobId));
    expect(submitted.status).toBe(200);
    await expect(submitted.json()).resolves.toMatchObject({ state: 'queued', demo: true });

    vi.advanceTimersByTime(700);
    const running = await getPrediction(new Request(`http://localhost/api/predictions/${created.jobId}`, { headers: { cookie } }), context(created.jobId));
    await expect(running.json()).resolves.toMatchObject({ state: 'running', resultAvailable: false });

    vi.advanceTimersByTime(1_000);
    const resultResponse = await getResult(new Request(`http://localhost/api/predictions/${created.jobId}/result`, { headers: { cookie } }), context(created.jobId));
    expect(resultResponse.status).toBe(200);
    const result = await resultResponse.json() as PredictionResult;
    expect(result).toMatchObject({ contractVersion: PREDICTION_CONTRACT_VERSION, predictionKind: 'candidate', demo: true, call: 'model-positive-candidate', input: { sha256: 'a'.repeat(64) }, bestWindow: { promoterStart: expect.any(Number), promoterEnd: expect.any(Number) } });
    expect(JSON.stringify(result).toLowerCase()).not.toContain('tss');
    expect(result.topWindows[0]).toMatchObject({ probability: expect.any(Number), promoterStart: expect.any(Number), promoterEnd: expect.any(Number) });
  });

  it('creates a metadata-only demo upload slot and binds it to the ticket scope', async () => {
    const issued = await ticket(1_024);
    const response = await createUpload(bodyRequest('http://localhost/api/predictions/uploads', {
      contractVersion: PREDICTION_CONTRACT_VERSION,
      ticket: issued.ticket,
      fileName: 'genome.fna',
      fileSize: 1_024,
      sha256: 'b'.repeat(64),
    }));
    expect(response.status).toBe(201);
    await expect(response.json() as Promise<PredictionUploadSlot>).resolves.toMatchObject({ uploadRequired: false, uploadUrl: null, method: null });

    const mismatch = await createUpload(bodyRequest('http://localhost/api/predictions/uploads', {
      contractVersion: PREDICTION_CONTRACT_VERSION,
      ticket: issued.ticket,
      fileName: 'genome.fna',
      fileSize: 512,
      sha256: 'b'.repeat(64),
    }));
    expect(mismatch.status).toBe(401);
  });

  it('refuses remote mode when service and Turnstile configuration are incomplete', async () => {
    process.env.RAPPTOR_PREDICTION_MODE = 'remote';
    const capabilities = getCapabilities();
    await expect(capabilities.json()).resolves.toMatchObject({ mode: 'remote', serviceStatus: 'unavailable', demoPreviewAvailable: true, available: false, unavailableReason: 'Cloud prediction is not available in this deployment yet.' });
    const response = await issueTicket(bodyRequest('http://localhost/api/prediction-tickets', {
      contractVersion: PREDICTION_CONTRACT_VERSION,
      turnstileToken: 'token',
      modelVersion,
      targetBases: 120,
      genomeBytes: 0,
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'PREDICTION_UNAVAILABLE' } });
  });
});
