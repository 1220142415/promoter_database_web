import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPredictionReference } from '@/features/prediction/reference-source';

afterEach(() => vi.unstubAllGlobals());
describe('bounded reference download', () => {
  it('propagates network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    await expect(loadPredictionReference()).rejects.toThrow('unavailable');
  });
  it('rejects a corrupt gzip without supplying substitute sequence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('corrupt-reference')));
    await expect(loadPredictionReference()).rejects.toThrow();
  });
  it('cancels streaming when the compressed size limit is exceeded', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1)); }, cancel,
    }))));
    await expect(loadPredictionReference()).rejects.toThrow('size limit');
    expect(cancel).toHaveBeenCalled();
  });
});
