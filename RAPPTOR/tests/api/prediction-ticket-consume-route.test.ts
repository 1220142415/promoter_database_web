import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  consumeTicket: vi.fn(),
  resolveReference: vi.fn(),
  usageDatabase: vi.fn(),
  preparedReference: vi.fn(),
}));

vi.mock('@/features/usage/store', () => ({ usageDatabase: mocks.usageDatabase }));
vi.mock('@/features/prediction/tickets', () => ({
  consumePredictionTicket: mocks.consumeTicket,
  hasPreparedPredictionReference: mocks.preparedReference,
  PredictionTicketConfigurationError: class PredictionTicketConfigurationError extends Error {},
  readPredictionTicketSettings: () => ({ serviceSecret: 'shared-secret' }),
  serviceSecretMatches: (provided: string | null, expected: string) => provided === expected,
}));
vi.mock('@/features/prediction/reference-source', () => ({
  resolvePredictionReferenceSource: mocks.resolveReference,
}));

import { POST } from '@/app/api/internal/prediction-tickets/consume/route';

function request(referenceAccession: string, mode: 'predict' | 'genome_scan' = 'predict') {
  return new Request('https://rapptor.example.test/api/internal/prediction-tickets/consume', {
    method: 'POST',
    headers: { Authorization: 'Bearer shared-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ticket: 'one-time-ticket',
      modelVersion: 'candidate-github-93cf',
      bases: 100,
      mode,
      referenceAccession,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.usageDatabase.mockReturnValue({});
  mocks.consumeTicket.mockResolvedValue(true);
  mocks.preparedReference.mockResolvedValue(false);
});

describe('prediction ticket consumption', () => {
  it('returns the Worker-resolved reference only after consuming the ticket', async () => {
    const referenceSource = {
      url: 'https://huggingface.co/datasets/example/repo/resolve/main/reference.fa.gz',
      sha256: 'a'.repeat(64),
    };
    mocks.resolveReference.mockResolvedValue(referenceSource);

    const response = await POST(request('GCF_000005845.1'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ allowed: true, referenceSource });
    expect(mocks.consumeTicket).toHaveBeenCalledWith({}, {
      ticket: 'one-time-ticket',
      modelVersion: 'candidate-github-93cf',
      bases: 100,
      mode: 'predict',
      referenceAccession: 'GCF_000005845.1',
    });
  });

  it('rejects an accession without a trusted cached reference', async () => {
    mocks.resolveReference.mockResolvedValue(null);

    const response = await POST(request('GCF_000005845.1'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      allowed: false,
      errorCode: 'REFERENCE_CGR_NOT_FOUND',
    });
    expect(mocks.consumeTicket).not.toHaveBeenCalled();
  });

  it('accepts an external reference only when prepared for this ticket', async () => {
    mocks.resolveReference.mockResolvedValue(null);
    mocks.preparedReference.mockResolvedValue(true);
    const response = await POST(request('GCA_000005845.2'));
    expect(await response.json()).toEqual({ allowed: true });
    expect(mocks.preparedReference).toHaveBeenCalledWith({}, 'one-time-ticket', 'GCA_000005845.2', 'predict');
    expect(mocks.consumeTicket).toHaveBeenCalledWith({}, expect.objectContaining({ referenceAccession: 'GCA_000005845.2' }));
  });

  it('checks a prepared external reference against genome-scan mode', async () => {
    mocks.resolveReference.mockResolvedValue(null);
    mocks.preparedReference.mockResolvedValue(true);
    const response = await POST(request('GCA_000005845.2', 'genome_scan'));
    expect(await response.json()).toEqual({ allowed: true });
    expect(mocks.preparedReference).toHaveBeenCalledWith({}, 'one-time-ticket', 'GCA_000005845.2', 'genome_scan');
    expect(mocks.consumeTicket).toHaveBeenCalledWith({}, expect.objectContaining({ mode: 'genome_scan' }));
  });
});
