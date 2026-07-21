/**
 * Stateless MCP server (Streamable HTTP, JSON responses) at /mcp.
 *
 * Two tools: create_graph builds a shareable link from equation rows and
 * validates every row through the app's own parser; read_graph decodes an
 * existing link back into rows so an assistant can edit a user's graph.
 * No sessions, no SSE — each POST is a complete JSON-RPC exchange, which is
 * all these tools need and keeps the Worker stateless.
 */
import { decodePayload, encodePayload } from '../lib/link.ts';
import { analyze } from './graph.ts';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const SYNTAX_GUIDE = `Each equation is one row of the graph. Syntax:
- Operators + - * / ^, parentheses, |x| for absolute value. Multiplication is implicit: 2x, a(x-1), 2cos(t).
- Constants pi, tau, e. Functions: sin cos tan asin acos atan atan2(y,x) sinh cosh tanh sech asinh acosh atanh sqrt abs exp ln log floor ceil round min max mod sign fract re im arg conj.
- Variables: x,y = the 2D plane; z makes it 3D; t = seconds (animates); u,v in (0,1) for parametric; w = complex x+iy.
- Row types: "y = x^2" or any implicit equation (curve); inequalities incl. chains "4 <= x^2+y^2 <= 9" (region); bare expression in x,y (scalar field); expression in w (complex field plot); "(2, 3)" (point); "(2cos(2pi u), sin(4pi u))" (parametric curve, 3 components for 3D); 3 components in u AND v (parametric surface); any equation in x,y,z (3D surface).
- Definitions are rows too: "a = 2" (constant, shown as a draggable slider), "f(x) = x^3 - a x" (function), coordinate fields like "r = sqrt(x^2+y^2); theta = atan2(y,x)" (then "r = 2(1+cos(theta))" plots in polar).
- Derivatives: d/dx (...) differentiates symbolically; also d^2/dx^2 and any single-letter variable.`;

const TOOLS = [
  {
    name: 'create_graph',
    title: 'Create a graph link',
    description: `Build a link that opens the equation.io grapher with the given equations already rendered, validating every row. Send the COMPLETE list of rows the graph should show (when editing, include the unchanged rows too).

${SYNTAX_GUIDE}

Editing a user's graph: call read_graph on their link first, transform the rows, then call create_graph with the full new list. Prefer restructuring into named definitions so related objects stay linked. Example — the user has "y = x^2 - 2x" and asks for a tangent line at x = 3. Send rows: ["f(x) = x^2 - 2x", "g(x) = d/dx f(x)", "a = 3", "y = f(x)", "y = f(a) + g(a)(x - a)"] — a becomes a draggable slider, so the tangent point stays explorable.

If any row fails validation, fix it and call again before giving the user the link. Give users the share_url (it unfurls with a rendered preview image in chat apps); url is equivalent.`,
    inputSchema: {
      type: 'object',
      properties: {
        equations: {
          type: 'array',
          items: { type: 'string' },
          description: 'All rows of the graph, in display order. One equation or definition per string; no semicolons.',
        },
      },
      required: ['equations'],
    },
  },
  {
    name: 'read_graph',
    title: 'Read a graph link',
    description: 'Decode an equation.io link (either the #-fragment form or the /g/ share form) into its list of equation rows, so you can edit them and build a new link with create_graph.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'An equation.io graph URL.' },
      },
      required: ['url'],
    },
  },
];

function createGraph(origin: string, args: Record<string, unknown>) {
  const equations = args.equations;
  if (!Array.isArray(equations) || !equations.every(e => typeof e === 'string')) {
    throw new Error('equations must be an array of strings');
  }
  const texts = (equations as string[]).map(t => t.trim()).filter(Boolean);
  const bad = texts.find(t => t.includes(';'));
  if (bad) throw new Error(`Row "${bad}" contains ';' — send each equation as its own array item.`);
  const analysis = analyze(texts);
  const rows = analysis.rows.map(row => ({
    text: row.text,
    ...(row.error
      ? { status: 'error' as const, error: row.error }
      : {
          status: 'ok' as const,
          kind: row.def ? `definition (${row.def.kind})` : row.cls!.plot.type,
          ...(row.cls?.animated ? { animated: true } : {}),
        }),
  }));
  const payload = encodePayload(texts);
  return {
    valid: rows.every(row => row.status === 'ok'),
    url: `${origin}/#${payload}`,
    share_url: `${origin}/g/${payload}`,
    rows,
  };
}

function readGraph(args: Record<string, unknown>) {
  if (typeof args.url !== 'string') throw new Error('url must be a string');
  const url = new URL(args.url);
  const payload = url.hash.length > 1
    ? url.hash.slice(1)
    : url.pathname.startsWith('/g/')
      ? url.pathname.slice(3)
      : '';
  if (!payload) throw new Error('No equations found in that URL (expected /#... or /g/... form).');
  return { equations: decodePayload(payload) };
}

// --- JSON-RPC plumbing ---

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function handleRpc(req: RpcRequest, origin: string): object | null {
  const { id, method, params = {} } = req;
  const result = (r: object) => ({ jsonrpc: '2.0', id, result: r });
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

  // A notification is a request with NO id member (JSON-RPC 2.0). `id: null`
  // is a valid (if discouraged) request id and must still get a response.
  if (id === undefined) return null;

  switch (method) {
    case 'initialize': {
      const requested = (params as { protocolVersion?: string }).protocolVersion;
      return result({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested ?? '') ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'equation', title: 'equation.io grapher', version: '1.0.0' },
        instructions:
          'Graphing calculator whose entire state lives in the URL. Use create_graph to produce links that open with equations rendered, and read_graph to decode a link the user shares so you can edit their graph. Full syntax reference: ' +
          origin + '/llms.txt',
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: args = {} } = params as { name?: string; arguments?: Record<string, unknown> };
      try {
        let value: object;
        if (name === 'create_graph') value = createGraph(origin, args);
        else if (name === 'read_graph') value = readGraph(args);
        else return error(-32602, `Unknown tool: ${name}`);
        return result({
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          structuredContent: value,
        });
      } catch (e) {
        return result({
          content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        });
      }
    }
    default:
      return error(-32601, `Method not found: ${method}`);
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  // GET and DELETE return 405 today, but the MCP Streamable HTTP transport
  // uses them (GET opens a server-initiated SSE stream, DELETE ends a
  // session). Browsers cache preflight results per URL, so advertising the
  // full transport method set now means an already-cached preflight stays
  // valid if we ever add sessions — old clients won't need a cache expiry to
  // reach the new methods.
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
};

export async function handleMcp(request: Request, url: URL): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') {
    // No server-initiated streams (GET) and no sessions to delete.
    return new Response(null, { status: 405, headers: { ...CORS_HEADERS, Allow: 'POST, OPTIONS' } });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const origin = url.origin;
  const responses = (Array.isArray(body) ? body : [body])
    .map(r => handleRpc(r as RpcRequest, origin))
    .filter((r): r is object => r !== null);

  if (!responses.length) return new Response(null, { status: 202, headers: CORS_HEADERS });
  const payload = Array.isArray(body) ? responses : responses[0];
  return Response.json(payload, { headers: CORS_HEADERS });
}
