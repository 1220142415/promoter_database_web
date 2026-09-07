export type PredictionAccessMode = 'email' | 'ip';

export function predictionAccessMode(value = process.env.RAPPTOR_PREDICTION_ACCESS_MODE): PredictionAccessMode {
  return value?.trim().toLowerCase() === 'ip' ? 'ip' : 'email';
}
