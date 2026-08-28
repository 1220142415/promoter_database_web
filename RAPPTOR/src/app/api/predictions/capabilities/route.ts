import { predictionCapabilities } from '@/features/prediction/capabilities';

export function GET() {
  return Response.json(predictionCapabilities(), { headers: { 'Cache-Control': 'no-store' } });
}
