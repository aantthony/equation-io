async function handleApi(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === '/api/health') {
    return Response.json({ ok: true });
  }
  return Response.json({ error: 'not_found' }, { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, url, env);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
