// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBrowserFasta } from '@/features/prediction/prototype/browser-references';

afterEach(() => vi.unstubAllGlobals());

describe('browser reference cache', () => {
  it('reuses a validated FASTA without downloading or reporting progress again', async () => {
    const stored = new Map<string, Response>();
    vi.stubGlobal('caches', {
      open: vi.fn(async () => ({
        match: async (key: string) => stored.get(key)?.clone(),
        put: async (key: string, response: Response) => { stored.set(key, response.clone()); },
      })),
    });
    const fetchMock = vi.fn(async () => new Response('>sequence\nACGT\n', {
      headers: { 'content-length': '15', 'content-type': 'text/plain' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const progress = vi.fn();
    const url = 'https://huggingface.co/example/reference.fna';

    expect(await downloadBrowserFasta(url, progress)).toBe('>sequence\nACGT\n');
    expect(progress).toHaveBeenCalled();
    progress.mockClear();
    expect(await downloadBrowserFasta(url, progress)).toBe('>sequence\nACGT\n');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(progress).not.toHaveBeenCalled();
  });
});
