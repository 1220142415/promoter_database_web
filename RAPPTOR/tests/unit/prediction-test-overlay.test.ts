import { describe, expect, it, vi } from 'vitest';
import { withPredictionTestTickets } from '@/features/prediction/test-ticket-overlay';

describe('additive Worker ticket endpoint', () => {
  it('preserves requests, responses, bindings and scheduled handlers for existing routes', async () => {
    const response = new Response('existing website', { status: 202 });
    const worker = { fetch: vi.fn(() => response), scheduled: vi.fn() };
    const handlers = { GET: vi.fn(), POST: vi.fn() };
    const wrapped = withPredictionTestTickets(worker, handlers);
    const request = new Request('https://example.test/api/predictions/jobs', { method: 'POST', body: 'unchanged' });
    const env = { existing: 'binding' };
    const context = { waitUntil: vi.fn() };
    expect(await wrapped.fetch(request, env, context)).toBe(response);
    expect(worker.fetch).toHaveBeenCalledWith(request, env, context);
    expect(wrapped.scheduled).toBe(worker.scheduled);
    expect(handlers.GET).not.toHaveBeenCalled();
    expect(handlers.POST).not.toHaveBeenCalled();
  });
  it.each(['GET', 'POST'] as const)('dispatches only the exact internal path to the guarded %s handler', async (method) => {
    const worker = { fetch: vi.fn() };
    const response = new Response('protected', { status: 401 });
    const handlers = { GET: vi.fn(() => response), POST: vi.fn(() => response) };
    const wrapped = withPredictionTestTickets(worker, handlers);
    const request = new Request('https://example.test/api/internal/prediction-test-tickets', { method });
    expect(await wrapped.fetch(request, {}, {})).toBe(response);
    expect(handlers[method]).toHaveBeenCalledWith(request);
    expect(worker.fetch).not.toHaveBeenCalled();
  });
  it('rejects unsupported methods and leaves similarly named routes untouched', async () => {
    const worker = { fetch: vi.fn(() => new Response('original')) };
    const handlers = { GET: vi.fn(), POST: vi.fn() };
    const wrapped = withPredictionTestTickets(worker, handlers);
    const response = await wrapped.fetch(new Request('https://example.test/api/internal/prediction-test-tickets', { method: 'DELETE' }), {}, {});
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, POST');
    await wrapped.fetch(new Request('https://example.test/api/internal/prediction-test-tickets-extra'), {}, {});
    expect(worker.fetch).toHaveBeenCalledOnce();
  });
});
