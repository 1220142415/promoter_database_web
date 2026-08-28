import type { PredictionCapabilities, PredictionServiceMode } from './types';
import { PREDICTION_ANCHOR_BASE, PREDICTION_CONTRACT_VERSION, PREDICTION_WINDOW_BASES } from './types';

const DEFAULT_CAPABILITIES = {
  contractVersion: PREDICTION_CONTRACT_VERSION,
  modelVersion: process.env.RAPPTOR_PREDICTION_MODEL_VERSION || 'rapptor-cgr-100bp-demo-v1',
  supportedPredictionKinds: ['candidate'],
  windowBases: PREDICTION_WINDOW_BASES,
  predictionAnchorBase: PREDICTION_ANCHOR_BASE,
  promoterThreshold: 0.9,
  acceptedTargetFormats: ['raw DNA', 'FASTA'],
  acceptedGenomeFormats: ['.fa', '.fasta', '.fna', '.fa.gz', '.fasta.gz', '.fna.gz'],
  limits: {
    targetMaxBases: 10_000,
    genomeMaxBytes: 50 * 1024 * 1024,
  },
  retention: {
    inputHours: 24,
    resultDays: 7,
  },
} satisfies Omit<PredictionCapabilities, 'available' | 'mode' | 'serviceStatus' | 'demoPreviewAvailable' | 'turnstileSiteKey' | 'unavailableReason'>;

export function predictionMode(): PredictionServiceMode {
  return process.env.RAPPTOR_PREDICTION_MODE?.toLowerCase() === 'remote' ? 'remote' : 'demo';
}

export function predictionCapabilities(): PredictionCapabilities {
  const mode = predictionMode();
  if (mode === 'demo') {
    return {
      ...DEFAULT_CAPABILITIES,
      available: true,
      mode,
      serviceStatus: 'demo',
      demoPreviewAvailable: true,
      turnstileSiteKey: null,
    };
  }

  const missing = [
    ['RAPPTOR_PREDICTION_API_BASE_URL', process.env.RAPPTOR_PREDICTION_API_BASE_URL],
    ['RAPPTOR_PREDICTION_SERVICE_TOKEN', process.env.RAPPTOR_PREDICTION_SERVICE_TOKEN],
    ['NEXT_PUBLIC_TURNSTILE_SITE_KEY', process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY],
    ['RAPPTOR_TURNSTILE_SECRET_KEY', process.env.RAPPTOR_TURNSTILE_SECRET_KEY],
  ].filter(([, value]) => !value).map(([name]) => name);

  return {
    ...DEFAULT_CAPABILITIES,
    available: missing.length === 0,
    mode,
    serviceStatus: missing.length === 0 ? 'ready' : 'unavailable',
    demoPreviewAvailable: true,
    turnstileSiteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || null,
    unavailableReason: missing.length ? 'Cloud prediction is not available in this deployment yet.' : undefined,
  };
}

export function demoPredictionCapabilities(): PredictionCapabilities {
  return {
    ...DEFAULT_CAPABILITIES,
    modelVersion: 'rapptor-cgr-100bp-demo-v1',
    available: true,
    mode: 'demo',
    serviceStatus: 'demo',
    demoPreviewAvailable: true,
    turnstileSiteKey: null,
  };
}
