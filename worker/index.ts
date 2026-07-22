async function handleApi(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === '/api/health') {
    return Response.json({ ok: true });
  }
  return Response.json({ error: 'not_found' }, { status: 404 });
}

// Static assets are served without a charset, so browsers decode text/* as
// windows-1252 and mangle the em dashes in llms.txt. Tag them as UTF-8.
function withCharset(response: Response): Response {
  const type = response.headers.get('content-type');
  if (!type || !type.startsWith('text/') || type.includes('charset=')) {
    return response;
  }
  const patched = new Response(response.body, response);
  patched.headers.set('content-type', `${type}; charset=utf-8`);
  return patched;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, url, env);
    }
    return withCharset(await env.ASSETS.fetch(request));
  },
} satisfies ExportedHandler<Env>;
