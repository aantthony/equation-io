import { describe, expect, it } from 'vitest';
import { handleMcp } from './mcp.ts';

const URL_BASE = 'https://equation.io/mcp';

async function rpc(method: string, params?: object, id: number | null = 1) {
  const request = new Request(URL_BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const res = await handleMcp(request, new URL(URL_BASE));
  const body = (res.status === 202 ? null : await res.json()) as any;
  return { res, body };
}

describe('mcp endpoint', () => {
  it('initializes with a supported protocol version', async () => {
    const { body } = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe('equation');
  });

  it('falls back to its latest version for unknown requested versions', async () => {
    const { body } = await rpc('initialize', { protocolVersion: '9999-01-01' });
    expect(body.result.protocolVersion).toBe('2025-06-18');
  });

  it('answers requests with id: null (only an ABSENT id is a notification)', async () => {
    const { body } = await rpc('ping', undefined, null);
    expect(body).toEqual({ jsonrpc: '2.0', id: null, result: {} });
  });

  it('accepts notifications with a 202 and no body', async () => {
    const request = new Request(URL_BASE, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    const res = await handleMcp(request, new URL(URL_BASE));
    expect(res.status).toBe(202);
  });

  it('lists both tools', async () => {
    const { body } = await rpc('tools/list');
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(['create_graph', 'read_graph']);
  });

  it('creates a validated graph link (tangent-line editing example)', async () => {
    const { body } = await rpc('tools/call', {
      name: 'create_graph',
      arguments: {
        equations: ['f(x) = x^2 - 2x', 'g(x) = d/dx f(x)', 'a = 3', 'y = f(x)', 'y = f(a) + g(a)(x - a)'],
      },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(true);
    expect(out.url).toMatch(/^https:\/\/equation\.io\/#/);
    expect(out.share_url).toMatch(/^https:\/\/equation\.io\/g\//);
    // Chat-app linkifiers cut URLs at bare parens; the codec must escape them.
    expect(out.share_url).not.toMatch(/[()!'*]/);
    expect(out.url).not.toMatch(/[()!'*]/);
    expect(out.rows.map((r: { kind?: string }) => r.kind)).toEqual([
      'definition (fn)', 'definition (fn)', 'definition (const)', 'implicit2d', 'implicit2d',
    ]);
  });

  it('reports per-row errors without failing the call', async () => {
    const { body } = await rpc('tools/call', {
      name: 'create_graph',
      arguments: { equations: ['y = x^2', 'y = florb(x)'] },
    });
    const out = body.result.structuredContent;
    expect(out.valid).toBe(false);
    expect(out.rows[0].status).toBe('ok');
    expect(out.rows[1].status).toBe('error');
  });

  it('round-trips a link through read_graph (both URL forms)', async () => {
    const { body: created } = await rpc('tools/call', {
      name: 'create_graph',
      arguments: { equations: ['a = 2', 'y = sin(a x)/a'] },
    });
    for (const key of ['url', 'share_url'] as const) {
      const { body } = await rpc('tools/call', {
        name: 'read_graph',
        arguments: { url: created.result.structuredContent[key] },
      });
      expect(body.result.structuredContent.equations).toEqual(['a = 2', 'y = sin(a x)/a']);
    }
  });

  it('names the expected argument when a caller guesses wrong', async () => {
    // "rows" is the guess to expect: the tool's own result calls the
    // per-equation validation "rows", so a caller can reasonably reach for it.
    const { body } = await rpc('tools/call', {
      name: 'create_graph',
      arguments: { rows: ['y = x^2'] },
    });
    const text = body.result.content[0].text;
    expect(text).toContain('"equations"');
    expect(text).toContain('"rows"'); // says what arrived, not just what was wanted
    expect(text).toContain('{"equations": ["y = x^2", "y = sin(x)"]}'); // a copyable example
  });

  it('describes the argument it actually takes', async () => {
    const { body } = await rpc('tools/list');
    const create = body.result.tools.find((t: { name: string }) => t.name === 'create_graph');
    expect(Object.keys(create.inputSchema.properties)).toEqual(['equations']);
    expect(create.inputSchema.required).toEqual(['equations']);
    // The prose must not tell a caller to send "rows:" — the schema says
    // equations, and a description that disagrees is what caused the misuse.
    expect(create.description).not.toMatch(/send rows|rows:\s*\[/i);
    expect(create.description).toContain('"equations"');
  });

  it('feeds read_graph output straight back into create_graph', async () => {
    const rows = ['a = 2', 'y = sin(a x)'];
    const made = await rpc('tools/call', { name: 'create_graph', arguments: { equations: rows } });
    const url = JSON.parse(made.body.result.content[0].text).share_url;
    const read = await rpc('tools/call', { name: 'read_graph', arguments: { url } });
    // read_graph returns "equations", the exact key create_graph consumes.
    expect(JSON.parse(read.body.result.content[0].text)).toEqual({ equations: rows });
  });

  it('answers preflights with a long-lived cacheable policy', async () => {
    const res = await handleMcp(new Request(URL_BASE, { method: 'OPTIONS' }), new URL(URL_BASE));
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('rejects unknown methods and non-POST requests', async () => {
    const { body } = await rpc('bogus/method');
    expect(body.error.code).toBe(-32601);
    const res = await handleMcp(new Request(URL_BASE, { method: 'GET' }), new URL(URL_BASE));
    expect(res.status).toBe(405);
  });
});
