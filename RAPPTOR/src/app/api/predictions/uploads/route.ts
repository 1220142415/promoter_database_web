import { predictionErrorResponse } from '@/features/prediction/api-response';
import { predictionCapabilities } from '@/features/prediction/capabilities';
import { predictionProvider } from '@/features/prediction/runtime';
import { parseUploadRequest } from '@/features/prediction/validation';
import { requirePredictionAuth } from '@/features/auth/supabase';

export async function POST(request: Request) {
  const auth = await requirePredictionAuth(request);
  if (auth instanceof Response) return auth;
  try {
    const input = parseUploadRequest(await request.json(), predictionCapabilities());
    return Response.json(await predictionProvider().createUpload(input), { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return predictionErrorResponse(error);
  }
}
