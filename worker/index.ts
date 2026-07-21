import { decodeEquations } from './graph.ts';
import { handleMcp } from './mcp.ts';
import { OG_HEIGHT, OG_WIDTH, renderOgPng } from './og.ts';

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * /g/<payload>: the share form of a graph link. Serves the app shell with
 * og:/twitter: meta tags injected so the link unfurls with a rendered preview
 * (crawlers never see URL fragments, which is why this form exists). The web
 * app itself reads the payload from the path and normalizes back to /#....
 */
async function handleShare(request: Request, url: URL, env: Env): Promise<Response> {
  const payload = url.pathname.slice('/g/'.length);
  let equations: string[] = [];
  try {
    equations = decodeEquations(payload);
  } catch {
    // Undecodable payload — serve the plain app.
  }
  const shell = await env.ASSETS.fetch(new Request(new URL('/', url), request));
  if (!equations.length || !shell.headers.get('content-type')?.includes('text/html')) return shell;

  const title = `${equations[0]}${equations.length > 1 ? ' …' : ''} — equation.io`;
  const description = equations.length > 1
    ? `Interactive graph of ${equations.length} equations: ${equations.join('; ')}`
    : 'Interactive graph — opens rendered in the browser, no account needed.';
  const meta = [
    ['og:title', title],
    ['og:description', description],
    ['og:type', 'website'],
    ['og:url', `${url.origin}/g/${payload}`],
    ['og:image', `${url.origin}/api/og/${payload}`],
    ['og:image:width', String(OG_WIDTH)],
    ['og:image:height', String(OG_HEIGHT)],
    ['twitter:card', 'summary_large_image'],
    ['twitter:image', `${url.origin}/api/og/${payload}`],
  ];
  const tags = meta
    .map(([p, c]) => `<meta ${p.startsWith('twitter:') ? 'name' : 'property'}="${p}" content="${escapeAttr(c)}">`)
    .join('\n  ');
  return new HTMLRewriter()
    .on('head', {
      element(el) {
        el.append(`${tags}\n  `, { html: true });
      },
    })
    .on('title', {
      element(el) {
        el.setInnerContent(title);
      },
    })
    .transform(shell);
}

async function handleOgImage(url: URL): Promise<Response> {
  const payload = url.pathname.slice('/api/og/'.length);
  let equations: string[] = [];
  try {
    equations = decodeEquations(payload);
  } catch {
    return Response.json({ error: 'bad_payload' }, { status: 400 });
  }
  const png = await renderOgPng(equations);
  return new Response(png as unknown as BodyInit, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

async function handleApi(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === '/api/health') {
    return Response.json({ ok: true });
  }
  if (url.pathname.startsWith('/api/og/')) {
    return handleOgImage(url);
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
    if (url.pathname === '/mcp') {
      return handleMcp(request, url);
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, url, env);
    }
    if (url.pathname.startsWith('/g/')) {
      return handleShare(request, url, env);
    }
    return withCharset(await env.ASSETS.fetch(request));
  },
} satisfies ExportedHandler<Env>;
