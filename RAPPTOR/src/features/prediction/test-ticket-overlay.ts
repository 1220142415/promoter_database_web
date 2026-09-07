type Handler = (request: Request) => Response | Promise<Response>;

/** Add the internal issuer without rebuilding or replacing the deployed website. */
export function withPredictionTestTickets<Env, Context, Worker extends {
  fetch(request: Request, env: Env, context: Context): Response | Promise<Response>;
}>(worker: Worker, handlers: { GET: Handler; POST: Handler }) {
  return {
    ...worker,
    fetch(request: Request, env: Env, context: Context) {
      if (new URL(request.url).pathname !== '/api/internal/prediction-test-tickets') {
        return worker.fetch(request, env, context);
      }
      if (request.method === 'GET') return handlers.GET(request);
      if (request.method === 'POST') return handlers.POST(request);
      return new Response(null, {
        status: 405,
        headers: { Allow: 'GET, POST', 'Cache-Control': 'no-store' },
      });
    },
  };
}
