import { afterEach, describe, expect, it } from 'vitest';

import {
  consumePredictionTicket,
  beijingQuotaDay,
  issuePredictionTicket,
  PredictionTicketConfigurationError,
  PredictionTicketLimitError,
  readPredictionTicketSettings,
  releaseGenomeScanQuota,
  reserveGenomeScanQuota,
  serviceSecretMatches,
  type PredictionTicketSettings,
} from '@/features/prediction/tickets';

interface TicketRow {
  ticketHash: string;
  ipHash: string;
  mode: 'predict' | 'genome_scan';
  modelVersion: string;
  requestedBases: number;
  maxBases: number;
  issuedAt: string;
  expiresAt: string;
  usedAt: string | null;
}

class FakeStatement {
  bindings: Array<string | number | null> = [];

  constructor(private readonly database: FakeD1, readonly sql: string) {}

  bind(...values: Array<string | number | null>) {
    this.bindings = values;
    return this;
  }

  async first<T>() {
    return null as T;
  }

  async all<T>() {
    return { results: [] as T[], success: true, meta: {} };
  }

  async run<T>() {
    let changes = 0;
    if (this.sql.startsWith('INSERT INTO prediction_tickets')) {
      const [ticketHash, ipHash, mode, modelVersion, requestedBases, maxBases, issuedAt, expiresAt,
        , minuteCutoff, ticketsPerMinute, limitMode, , dayCutoff, billedBases, basesPerDay] = this.bindings;
      const rows = this.database.rows.filter((row) => row.ipHash === ipHash);
      const minuteTickets = rows.filter((row) => row.issuedAt >= String(minuteCutoff)).length;
      const dailyBases = rows.filter((row) => row.mode === 'genome_scan' && row.issuedAt >= String(dayCutoff))
        .reduce((total, row) => total + row.requestedBases, 0);
      if (minuteTickets < Number(ticketsPerMinute)
        && (limitMode === 'predict' || dailyBases + Number(billedBases) <= Number(basesPerDay))) {
        this.database.rows.push({
          ticketHash: String(ticketHash),
          ipHash: String(ipHash),
          mode: mode as 'predict' | 'genome_scan',
          modelVersion: String(modelVersion),
          requestedBases: Number(requestedBases),
          maxBases: Number(maxBases),
          issuedAt: String(issuedAt),
          expiresAt: String(expiresAt),
          usedAt: null,
        });
        changes = 1;
      }
    } else if (this.sql.startsWith('INSERT INTO prediction_daily_quota')) {
      const key = `${this.bindings[0]}|${this.bindings[1]}`;
      if (!this.database.quotaRows.has(key)) {
        this.database.quotaRows.add(key);
        changes = 1;
      }
    } else if (this.sql.startsWith('DELETE FROM prediction_daily_quota')) {
      changes = this.database.quotaRows.delete(`${this.bindings[0]}|${this.bindings[1]}`) ? 1 : 0;
    } else if (this.sql.startsWith('UPDATE prediction_tickets')) {
      const [usedAt, ticketHash, modelVersion, now, bases] = this.bindings;
      const row = this.database.rows.find((candidate) => (
        candidate.ticketHash === ticketHash
        && candidate.modelVersion === modelVersion
        && candidate.usedAt === null
        && candidate.expiresAt > String(now)
        && candidate.maxBases >= Number(bases)
      ));
      if (row) {
        row.usedAt = String(usedAt);
        changes = 1;
      }
    }
    return { results: [] as T[], success: true, meta: { changes } };
  }
}

class FakeD1 {
  rows: TicketRow[] = [];
  quotaRows = new Set<string>();

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch<T>() {
    return [] as D1Result<T>[];
  }
}

const settings: PredictionTicketSettings = {
  modelVersion: 'candidate-github-93cf',
  maxBases: 1_000,
  ticketsPerMinute: 2,
  basesPerDay: 2_000,
  ttlSeconds: 90,
  turnstileSecret: 'turnstile-secret',
  serviceSecret: 'service-secret',
  ipHashSecret: 'ip-hash-secret',
};

const predictionEnv = [
  'RAPPTOR_PREDICTION_ENABLED',
  'RAPPTOR_PREDICTION_MODEL_VERSION',
  'RAPPTOR_PREDICTION_MAX_BASES',
  'RAPPTOR_PREDICTION_TICKETS_PER_MINUTE',
  'RAPPTOR_PREDICTION_BASES_PER_DAY',
  'RAPPTOR_PREDICTION_TICKET_TTL_SECONDS',
  'RAPPTOR_TURNSTILE_SECRET',
  'RAPPTOR_PREDICTION_SERVICE_SECRET',
  'RAPPTOR_PREDICTION_IP_HASH_SECRET',
] as const;

const originalEnv = Object.fromEntries(predictionEnv.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of predictionEnv) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('prediction ticket settings', () => {
  it('stays disabled until every deployment limit and secret is explicit', () => {
    delete process.env.RAPPTOR_PREDICTION_ENABLED;
    expect(() => readPredictionTicketSettings()).toThrow(PredictionTicketConfigurationError);
  });

  it('accepts a complete bounded configuration', () => {
    Object.assign(process.env, {
      RAPPTOR_PREDICTION_ENABLED: 'on',
      RAPPTOR_PREDICTION_MODEL_VERSION: settings.modelVersion,
      RAPPTOR_PREDICTION_MAX_BASES: '1000',
      RAPPTOR_PREDICTION_TICKETS_PER_MINUTE: '2',
      RAPPTOR_PREDICTION_BASES_PER_DAY: '2000',
      RAPPTOR_PREDICTION_TICKET_TTL_SECONDS: '90',
      RAPPTOR_TURNSTILE_SECRET: settings.turnstileSecret,
      RAPPTOR_PREDICTION_SERVICE_SECRET: settings.serviceSecret,
      RAPPTOR_PREDICTION_IP_HASH_SECRET: settings.ipHashSecret,
    });
    expect(readPredictionTicketSettings()).toEqual(settings);
  });
});

describe('one-time prediction tickets', () => {
  it('stores only hashes and can be consumed exactly once', async () => {
    const database = new FakeD1();
    const now = new Date('2026-08-27T08:00:00.000Z');
    const issued = await issuePredictionTicket(database as unknown as D1Database, settings, {
      address: '203.0.113.8',
      modelVersion: settings.modelVersion,
      bases: 500,
      mode: 'predict',
    }, now);

    expect(database.rows).toHaveLength(1);
    expect(issued.inputRequirements).toEqual({ completeGenomeRequired: true, conditioning: 'CGR_128x128' });
    expect(JSON.stringify(database.rows)).not.toContain('203.0.113.8');
    expect(JSON.stringify(database.rows)).not.toContain(issued.ticket);
    await expect(consumePredictionTicket(database as unknown as D1Database, {
      ticket: issued.ticket,
      modelVersion: settings.modelVersion,
      bases: 500,
    }, now)).resolves.toBe(true);
    await expect(consumePredictionTicket(database as unknown as D1Database, {
      ticket: issued.ticket,
      modelVersion: settings.modelVersion,
      bases: 500,
    }, now)).resolves.toBe(false);
  });

  it('rejects expired, oversized, and wrong-model consumption', async () => {
    const database = new FakeD1();
    const now = new Date('2026-08-27T08:00:00.000Z');
    const issued = await issuePredictionTicket(database as unknown as D1Database, settings, {
      address: '203.0.113.8', modelVersion: settings.modelVersion, bases: 500, mode: 'predict',
    }, now);
    await expect(consumePredictionTicket(database as unknown as D1Database, {
      ticket: issued.ticket, modelVersion: 'wrong', bases: 500,
    }, now)).resolves.toBe(false);
    await expect(consumePredictionTicket(database as unknown as D1Database, {
      ticket: issued.ticket, modelVersion: settings.modelVersion, bases: 501,
    }, now)).resolves.toBe(false);
    await expect(consumePredictionTicket(database as unknown as D1Database, {
      ticket: issued.ticket, modelVersion: settings.modelVersion, bases: 500,
    }, new Date('2026-08-27T08:02:00.000Z'))).resolves.toBe(false);
  });

  it('enforces configured ticket and base limits', async () => {
    const database = new FakeD1();
    const now = new Date('2026-08-27T08:00:00.000Z');
    const input = { address: '203.0.113.8', modelVersion: settings.modelVersion, bases: 700, mode: 'genome_scan' as const };
    await issuePredictionTicket(database as unknown as D1Database, settings, input, now);
    await issuePredictionTicket(database as unknown as D1Database, settings, input, now);
    await expect(issuePredictionTicket(database as unknown as D1Database, settings, input, now))
      .rejects.toThrow(PredictionTicketLimitError);
  });

  it('separates invalid and oversized inputs from quota failures', async () => {
    const database = new FakeD1();
    const now = new Date('2026-08-27T08:00:00.000Z');
    await expect(issuePredictionTicket(database as unknown as D1Database, settings, {
      address: '203.0.113.8', modelVersion: 'wrong', bases: 1, mode: 'predict',
    }, now)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(issuePredictionTicket(database as unknown as D1Database, settings, {
      address: '203.0.113.8', modelVersion: settings.modelVersion, bases: 1_001, mode: 'predict',
    }, now)).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' });
  });

  it('compares the server credential without accepting prefixes', () => {
    expect(serviceSecretMatches('service-secret', 'service-secret')).toBe(true);
    expect(serviceSecretMatches('service', 'service-secret')).toBe(false);
  });

  it('does not apply the daily base cap to short-sequence tickets', async () => {
    const database = new FakeD1();
    for (let minute = 0; minute < 4; minute += 1) {
      await issuePredictionTicket(database as unknown as D1Database, settings, {
        address: '203.0.113.8', modelVersion: settings.modelVersion, bases: 700, mode: 'predict',
      }, new Date(`2026-08-27T08:0${minute}:00.000Z`));
    }
    expect(database.rows).toHaveLength(4);
  });

  it('resets one whole-genome scan per user at Beijing midnight', async () => {
    const database = new FakeD1();
    const beforeMidnight = new Date('2026-08-27T15:59:59.000Z');
    const afterMidnight = new Date('2026-08-27T16:00:00.000Z');
    expect(beijingQuotaDay(beforeMidnight)).toBe('2026-08-27');
    await expect(reserveGenomeScanQuota(database as unknown as D1Database, 'user-1', beforeMidnight)).resolves.toBe(true);
    await expect(reserveGenomeScanQuota(database as unknown as D1Database, 'user-1', beforeMidnight)).resolves.toBe(false);
    await expect(reserveGenomeScanQuota(database as unknown as D1Database, 'user-1', afterMidnight)).resolves.toBe(true);
    await releaseGenomeScanQuota(database as unknown as D1Database, 'user-1', afterMidnight);
    await expect(reserveGenomeScanQuota(database as unknown as D1Database, 'user-1', afterMidnight)).resolves.toBe(true);
  });
});
