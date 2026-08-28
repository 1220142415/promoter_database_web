import { PredictionProviderError } from './provider';
import { PredictionValidationError } from './validation';

export function predictionErrorResponse(error: unknown) {
  if (error instanceof PredictionValidationError) {
    return Response.json({ error: { code: error.code, message: error.message, retryable: false } }, { status: 400 });
  }
  if (error instanceof PredictionProviderError) {
    return Response.json({ error: { code: error.code, message: error.message, retryable: error.retryable } }, { status: error.status });
  }
  return Response.json({ error: { code: 'PREDICTION_ERROR', message: 'Prediction request failed.', retryable: false } }, { status: 500 });
}
