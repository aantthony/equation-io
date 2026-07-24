/** End-to-end route behaviour for /g/ and /api/og, exercised through fetch(). */
import { describe, expect, it } from 'vitest';
import worker, { shareMeta } from './index.ts';
import { decodePayload, encodePayload } from '../lib/link.ts';

const SHELL = '<!doctype html><html><head><title>Equation.io</title></head><body></body></html>';

const env = {
  ASSETS: { fetch: async () => new Response(SHELL, { headers: { 'content-type': 'text/html' } }) },
} as unknown as Env;

const get = (path: string) => worker.fetch(new Request('https://equation.io' + path), env);

describe('share meta tags', () => {
  const keys = (rows: string[]) =>
    shareMeta(rows, encodePayload(rows), 'https://equation.io').meta.map(([k]) => k);

  it('advertises a rendered preview for a drawable graph', () => {
    const k = keys(['y = sin(x)']);
    expect(k).toContain('og:image');
    expect(k).toContain('twitter:card');
    expect(k).toContain('og:image:width');
  });

  it('omits image tags for a shader-only graph so the site card survives', () => {
    const k = keys(['iter(z^2 + w)']);
    expect(k).not.toContain('og:image');
    expect(k).not.toContain('twitter:image');
    // Title and description stay: they are accurate regardless.
    expect(k).toContain('og:title');
    expect(k).toContain('og:description');
  });

  it('titles the card with the first equation', () => {
    expect(shareMeta(['y = sin(x)'], 'p', 'https://equation.io').title).toBe('y = sin(x) — equation.io');
    expect(shareMeta(['y = x', 'y = 2x'], 'p', 'https://equation.io').title).toBe('y = x … — equation.io');
  });
});

describe('/api/og images', () => {
  it('renders a PNG for a drawable graph', async () => {
    const res = await get('/api/og/' + encodePayload(['x^2 + y^2 = 9']));
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic
  });

  it('redirects to the static card rather than drawing an empty grid', async () => {
    const res = await get('/api/og/' + encodePayload(['domain((w^3 - 1)/w)']));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/shots/hero.png');
  });

  it('redirects for a general implicit 3D surface the renderer would draw as nothing', async () => {
    const res = await get('/api/og/' + encodePayload(['x^2 + y^2 + z^2 = 9']));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/shots/hero.png');
  });

  it('rejects an undecodable payload', async () => {
    expect((await get('/api/og/%E0%A4%A')).status).toBe(400);
  });
});

describe('payload round-trip', () => {
  it('survives equations containing parens', () => {
    const rows = ['f(x) = x^3 - 2x', 'y = f(x)', 'a = 2'];
    expect(decodePayload(encodePayload(rows))).toEqual(rows);
  });

  it('treats ; as a separator in either spelling, never as content', () => {
    // The documented contract (llms.txt): ';' is only the row separator and
    // never appears inside an equation. That is what lets a payload survive
    // its separator coming back encoded — the far more common case, since
    // copying a /g/ link out of the address bar can do exactly that.
    expect(decodePayload(encodePayload(['y = 1', 'z']))).toEqual(['y = 1', 'z']);
    expect(decodePayload('y%20%3D%201%3Bz')).toEqual(['y = 1', 'z']);
  });
});
