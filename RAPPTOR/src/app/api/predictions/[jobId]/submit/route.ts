import { predictionErrorResponse } from '@/features/prediction/api-response';
import { PredictionProviderError } from '@/features/prediction/provider';
import { predictionProviderForJob } from '@/features/prediction/runtime';
import { accessCookieName, readCookie, validJobId } from '@/features/prediction/validation';
import { requirePredictionAuth } from '@/features/auth/supabase';

type RouteContext = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = await requirePredictionAuth(request);
  if (auth instanceof Response) return auth;
  try {
    const { jobId } = await context.params;
    if (!validJobId(jobId)) throw new PredictionProviderError('INVALID_JOB_ID', 'Prediction job ID is invalid.', 400);
    const accessToken = readCookie(request, accessCookieName(jobId));
    if (!accessToken) throw new PredictionProviderError('MISSING_ACCESS_TOKEN', 'Prediction access token is required.', 401);
    const job = await predictionProviderForJob(jobId).submitJob(jobId, accessToken);
    return Response.json(job, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return predictionErrorResponse(error);
  }
}
