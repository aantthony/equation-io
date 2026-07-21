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

  it('rejects unknown methods and non-POST requests', async () => {
    const { body } = await rpc('bogus/method');
    expect(body.error.code).toBe(-32601);
    const res = await handleMcp(new Request(URL_BASE, { method: 'GET' }), new URL(URL_BASE));
    expect(res.status).toBe(405);
  });
});
