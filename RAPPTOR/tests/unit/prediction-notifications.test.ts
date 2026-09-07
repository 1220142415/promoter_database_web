import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendPredictionNotification } from '@/features/email-system/prediction-notifications';

afterEach(() => vi.unstubAllGlobals());

describe('prediction completion email', () => {
  it('includes an exact task link without an access token', async () => {
    const jobId = '0123456789abcdef0123456789abcdef';
    const database = {
      prepare: vi.fn()
        .mockReturnValueOnce({ bind: () => ({ first: async () => ({
          job_id: jobId,
          email: 'person@example.test',
          task_kind: 'predict',
          outcome: 'succeeded',
          artifacts_expires_at: '2026-09-08T00:00:00.000Z',
          attempts: 1,
        }) }) })
        .mockReturnValueOnce({ bind: () => ({ run: async () => ({ success: true }) }) }),
    };
    const provider = vi.fn().mockResolvedValue(Response.json({ id: 'message-id' }));
    vi.stubGlobal('fetch', provider);

    await sendPredictionNotification(database as unknown as D1Database, jobId, {
      apiKey: 're_test',
      siteUrl: 'https://rapptor.example.test/',
    });

    const body = JSON.parse(String(provider.mock.calls[0]![1]?.body));
    expect(body.text).toContain(`https://rapptor.example.test/predict/task/${jobId}`);
    expect(body.html).toContain(`href="https://rapptor.example.test/predict/task/${jobId}"`);
    expect(body.text).not.toContain('access_token');
    expect(body.html).not.toContain('access_token');
  });
});
