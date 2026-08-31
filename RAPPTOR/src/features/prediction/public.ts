import 'server-only';

export function predictionPublicEnabled(value = process.env.RAPPTOR_PREDICTION_ENABLED) {
  return value?.trim().toLowerCase() === 'on';
}
