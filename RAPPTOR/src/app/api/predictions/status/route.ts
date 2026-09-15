import { readPredictionServerStatus } from '@/features/prediction/service-status';

export async function GET() {
  return Response.json(await readPredictionServerStatus(), {
    headers: { 'Cache-Control': 'public, max-age=5, s-maxage=10, stale-while-revalidate=30' },
  });
}
