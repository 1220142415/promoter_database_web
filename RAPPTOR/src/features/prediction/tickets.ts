import 'server-only';

export interface PredictionTicketSettings {
  modelVersion: string;
  maxBases: number;
  ticketsPerMinute: number;
  basesPerDay: number;
  ttlSeconds: number;
  turnstileSecret: string;
  serviceSecret: string;
  ipHashSecret: string;
}

export class PredictionTicketConfigurationError extends Error {}
export class PredictionTicketLimitError extends Error {}
export class PredictionTicketInputError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'INPUT_TOO_LARGE', message: string) {
    super(message);
  }
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new PredictionTicketConfigurationError(`${name} is required.`);
  return value;
}

function positiveInteger(name: string) {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PredictionTicketConfigurationError(`${name} must be a positive integer.`);
  }
  return value;
}

export function readPredictionTicketSettings(): PredictionTicketSettings {
  if (process.env.RAPPTOR_PREDICTION_ENABLED?.trim().toLowerCase() !== 'on') {
    throw new PredictionTicketConfigurationError('Prediction submission is disabled.');
  }
  const settings = {
    modelVersion: required('RAPPTOR_PREDICTION_MODEL_VERSION'),
    maxBases: positiveInteger('RAPPTOR_PREDICTION_MAX_BASES'),
    ticketsPerMinute: positiveInteger('RAPPTOR_PREDICTION_TICKETS_PER_MINUTE'),
    basesPerDay: positiveInteger('RAPPTOR_PREDICTION_BASES_PER_DAY'),
    ttlSeconds: positiveInteger('RAPPTOR_PREDICTION_TICKET_TTL_SECONDS'),
    turnstileSecret: required('RAPPTOR_TURNSTILE_SECRET'),
    serviceSecret: required('RAPPTOR_PREDICTION_SERVICE_SECRET'),
    ipHashSecret: required('RAPPTOR_PREDICTION_IP_HASH_SECRET'),
  };
  if (settings.ttlSeconds < 60 || settings.ttlSeconds > 120) {
    throw new PredictionTicketConfigurationError('RAPPTOR_PREDICTION_TICKET_TTL_SECONDS must be between 60 and 120.');
  }
  if (settings.maxBases > settings.basesPerDay) {
    throw new PredictionTicketConfigurationError('Per-job bases must not exceed the daily bases limit.');
  }
  return settings;
}

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function hmac(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

function randomTicket() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function changedRows(result: { meta?: { changes?: unknown } }) {
  const changes = Number(result.meta?.changes);
  return Number.isFinite(changes) ? changes : 0;
}

export async function issuePredictionTicket(
  database: D1Database,
  settings: PredictionTicketSettings,
  input: { address: string; modelVersion: string; bases: number },
  now = new Date(),
) {
  if (input.modelVersion !== settings.modelVersion) throw new PredictionTicketInputError('INVALID_INPUT', 'Unsupported model version.');
  if (!Number.isSafeInteger(input.bases) || input.bases <= 0) {
    throw new PredictionTicketInputError('INVALID_INPUT', 'Bases must be a positive integer.');
  }
  if (input.bases > settings.maxBases) {
    throw new PredictionTicketInputError('INPUT_TOO_LARGE', 'Input exceeds the per-job base limit.');
  }

  const issuedAt = now.toISOString();
  const minuteCutoff = new Date(now.getTime() - 60_000).toISOString();
  const dayCutoff = issuedAt.slice(0, 10) + 'T00:00:00.000Z';
  const ipHash = await hmac(`${issuedAt.slice(0, 10)}|${input.address}`, settings.ipHashSecret);
  const ticket = randomTicket();
  const expiresAt = new Date(now.getTime() + settings.ttlSeconds * 1000).toISOString();
  const result = await database.prepare(`INSERT INTO prediction_tickets
      (ticket_hash, ip_hash, scope, model_version, requested_bases, max_bases, issued_at, expires_at, used_at)
    SELECT ?, ?, 'prediction', ?, ?, ?, ?, ?, NULL
    WHERE (SELECT COUNT(*) FROM prediction_tickets WHERE ip_hash = ? AND issued_at >= ?) < ?
      AND (SELECT COALESCE(SUM(requested_bases), 0) FROM prediction_tickets WHERE ip_hash = ? AND issued_at >= ?) + ? <= ?`)
    .bind(
      await sha256(ticket), ipHash, settings.modelVersion, input.bases, input.bases, issuedAt, expiresAt,
      ipHash, minuteCutoff, settings.ticketsPerMinute,
      ipHash, dayCutoff, input.bases, settings.basesPerDay,
    )
    .run();
  if (changedRows(result) !== 1) throw new PredictionTicketLimitError('Prediction ticket limit reached.');
  return {
    ticket,
    expiresAt,
    modelVersion: settings.modelVersion,
    maxBases: input.bases,
    inputRequirements: {
      completeGenomeRequired: true,
      conditioning: 'CGR_128x128',
    },
  };
}

export async function consumePredictionTicket(
  database: D1Database,
  input: { ticket: string; modelVersion: string; bases: number },
  now = new Date(),
) {
  if (!input.ticket || !input.modelVersion || !Number.isSafeInteger(input.bases) || input.bases <= 0) return false;
  const result = await database.prepare(`UPDATE prediction_tickets SET used_at = ?
    WHERE ticket_hash = ? AND scope = 'prediction' AND model_version = ?
      AND used_at IS NULL AND expires_at > ? AND max_bases >= ?`)
    .bind(now.toISOString(), await sha256(input.ticket), input.modelVersion, now.toISOString(), input.bases)
    .run();
  return changedRows(result) === 1;
}

export async function verifyTurnstile(token: string, address: string, secret: string) {
  const body = new URLSearchParams({ secret, response: token, remoteip: address });
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body,
  });
  if (!response.ok) throw new Error('Turnstile verification is unavailable.');
  const result = await response.json() as { success?: boolean };
  return result.success === true;
}

export function serviceSecretMatches(provided: string | null, expected: string) {
  if (!provided || provided.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}
