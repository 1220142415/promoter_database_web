import type { PredictionCapabilities, PredictionServiceMode } from './types';
import { PREDICTION_ANCHOR_BASE, PREDICTION_CONTRACT_VERSION, PREDICTION_WINDOW_BASES } from './types';

export const DEFAULT_PREDICTION_MAX_REQUEST_BYTES = 12 * 1024 * 1024;

/** Return the configured request/upload limit shared with the prediction service. */
export function predictionMaxRequestBytes(value?: string | number | null) {
  const configured = value === undefined ? process.env.RAPPTOR_MAX_REQUEST_BYTES : value;
  if (configured === undefined || configured === null) return DEFAULT_PREDICTION_MAX_REQUEST_BYTES;
  const normalized = String(configured).trim();
  if (!/^[0-9]+$/.test(normalized)) return DEFAULT_PREDICTION_MAX_REQUEST_BYTES;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_PREDICTION_MAX_REQUEST_BYTES;
}

export function formatPredictionMaxRequestBytes(value: number) {
  const mebibyte = 1024 * 1024;
  if (value % mebibyte === 0) return `${value / mebibyte} MiB`;
  if (value % 1024 === 0) return `${value / 1024} KiB`;
  return `${value.toLocaleString('en-US')} ${value === 1 ? 'byte' : 'bytes'}`;
}

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
    genomeMaxBytes: DEFAULT_PREDICTION_MAX_REQUEST_BYTES,
  },
  retention: {
    inputHours: 24,
    resultDays: 7,
  },
} satisfies Omit<PredictionCapabilities, 'available' | 'mode' | 'serviceStatus' | 'demoPreviewAvailable' | 'turnstileSiteKey' | 'unavailableReason'>;

function capabilitiesWithConfiguredLimit() {
  return {
    ...DEFAULT_CAPABILITIES,
    limits: {
      ...DEFAULT_CAPABILITIES.limits,
      genomeMaxBytes: predictionMaxRequestBytes(),
    },
  };
}

export function predictionMode(): PredictionServiceMode {
  return process.env.RAPPTOR_PREDICTION_MODE?.toLowerCase() === 'remote' ? 'remote' : 'demo';
}

export function predictionCapabilities(): PredictionCapabilities {
  const mode = predictionMode();
  if (mode === 'demo') {
    return {
      ...capabilitiesWithConfiguredLimit(),
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
    ...capabilitiesWithConfiguredLimit(),
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
    ...capabilitiesWithConfiguredLimit(),
    modelVersion: 'rapptor-cgr-100bp-demo-v1',
    available: true,
    mode: 'demo',
    serviceStatus: 'demo',
    demoPreviewAvailable: true,
    turnstileSiteKey: null,
  };
}
