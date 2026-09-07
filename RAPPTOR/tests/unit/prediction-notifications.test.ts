import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerPredictionNotification, sendPredictionNotification } from '@/features/email-system/prediction-notifications';

afterEach(() => vi.unstubAllGlobals());

describe('prediction completion email', () => {
  it('encrypts access at rest and sends a branded capability link', async () => {
    const jobId = '0123456789abcdef0123456789abcdef';
    const accessToken = 'shared_access_token_1234567890abcdef';
    const tokenSecret = 'notification-secret-with-at-least-32-characters';
    let ciphertext = '';
    const database = {
      prepare: vi.fn((sql: string) => ({
        bind: (...values: unknown[]) => ({
          run: async () => {
            if (sql.includes('INSERT INTO prediction_job_notifications')) ciphertext = String(values[4]);
            return { success: true };
          },
          first: async () => ({
            job_id: jobId,
            email: 'person@example.test',
            task_kind: 'genome_scan',
            outcome: 'succeeded',
            artifacts_expires_at: '2026-09-08T00:00:00.000Z',
            access_token_ciphertext: ciphertext,
            reference_name: 'chr1',
            attempts: 1,
          }),
        }),
      })),
    };
    const provider = vi.fn().mockResolvedValue(Response.json({ id: 'message-id' }));
    vi.stubGlobal('fetch', provider);

    await registerPredictionNotification(database as unknown as D1Database, jobId, {
      id: 'user-1', email: 'person@example.test', emailConfirmed: true,
    }, 'genome_scan', { token: accessToken, tokenSecret, referenceName: 'chr1' });
    expect(ciphertext).not.toContain(accessToken);

    await sendPredictionNotification(database as unknown as D1Database, jobId, {
      apiKey: 're_test',
      siteUrl: 'https://rapptor.example.test/',
      tokenSecret,
    });

    const body = JSON.parse(String(provider.mock.calls[0]![1]?.body));
    expect(body.text).toContain(`https://rapptor.example.test/predict/task/${jobId}#access=${accessToken}&ref=chr1`);
    expect(body.text).toContain('Anyone with this temporary link can view the result');
    expect(body.html).toContain('Open genome browser');
    expect(body.html).toContain(`#access=${accessToken}&amp;ref=chr1`);
  });
});
