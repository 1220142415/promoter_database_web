import { predictionErrorResponse } from '@/features/prediction/api-response';
import { predictionCapabilities } from '@/features/prediction/capabilities';
import { predictionAccessCookie, predictionProvider } from '@/features/prediction/runtime';
import { parsePredictionSubmission } from '@/features/prediction/validation';

export async function POST(request: Request) {
  try {
    const input = parsePredictionSubmission(await request.json(), predictionCapabilities());
    const created = await predictionProvider().createJob(input);
    return Response.json(created.job, {
      status: 201,
      headers: {
        'Cache-Control': 'no-store',
        'Set-Cookie': predictionAccessCookie(created.job.jobId, created.accessToken),
      },
    });
  } catch (error) {
    return predictionErrorResponse(error);
  }
}
