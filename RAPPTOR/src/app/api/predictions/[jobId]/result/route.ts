import { predictionErrorResponse } from '@/features/prediction/api-response';
import { PredictionProviderError } from '@/features/prediction/provider';
import { predictionProviderForJob } from '@/features/prediction/runtime';
import { accessCookieName, readCookie, validJobId } from '@/features/prediction/validation';

type RouteContext = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const { jobId } = await context.params;
    if (!validJobId(jobId)) throw new PredictionProviderError('INVALID_JOB_ID', 'Prediction job ID is invalid.', 400);
    const accessToken = readCookie(request, accessCookieName(jobId));
    if (!accessToken) throw new PredictionProviderError('MISSING_ACCESS_TOKEN', 'Prediction access token is required.', 401);
    const result = await predictionProviderForJob(jobId).getResult(jobId, accessToken);
    if (!result) throw new PredictionProviderError('JOB_NOT_FOUND', 'Prediction job was not found.', 404);
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return predictionErrorResponse(error);
  }
}
