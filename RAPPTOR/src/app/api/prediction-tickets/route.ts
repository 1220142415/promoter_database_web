import { predictionErrorResponse } from '@/features/prediction/api-response';
import { predictionCapabilities } from '@/features/prediction/capabilities';
import { PredictionProviderError } from '@/features/prediction/provider';
import { predictionClientIp, predictionProvider, verifyPredictionTurnstile } from '@/features/prediction/runtime';
import { parseTicketRequest } from '@/features/prediction/validation';

export async function POST(request: Request) {
  try {
    const capabilities = predictionCapabilities();
    if (!capabilities.available) {
      throw new PredictionProviderError('PREDICTION_UNAVAILABLE', capabilities.unavailableReason || 'Prediction is unavailable.', 503, true);
    }
    const input = parseTicketRequest(await request.json(), capabilities);
    if (!await verifyPredictionTurnstile(input.turnstileToken, predictionClientIp(request))) {
      throw new PredictionProviderError('INVALID_TURNSTILE', 'Turnstile verification failed.', 401);
    }
    return Response.json(await predictionProvider().issueTicket(input), { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return predictionErrorResponse(error);
  }
}
