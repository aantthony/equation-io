import { describe, expect, it } from 'vitest';
import { decodePayload, encodePayload } from './link.ts';

describe('graph-link payload codec', () => {
  it('round-trips equations', () => {
    const rows = ['f(x) = x^2 - 2x', 'a = 3', 'y = f(a) + (x - a)', 'r = 2(1 + cos(theta))'];
    expect(decodePayload(encodePayload(rows))).toEqual(rows);
  });

  it('emits no characters that break chat-app URL linkification', () => {
    const payload = encodePayload(["y = sin(x)*|x|!", "f(x) = 'x'"]);
    expect(payload).not.toMatch(/[()!'* ]/);
  });

  it('decodes legacy single-encoded payloads (raw parens, %20 spaces)', () => {
    expect(decodePayload('y%20%3D%20sin(x);a%3D2')).toEqual(['y = sin(x)', 'a=2']);
  });

  it('drops empty rows on both sides', () => {
    expect(encodePayload(['', ' y = x ', ''])).toBe('y%20%3D%20x');
    expect(decodePayload(';y%3Dx;;')).toEqual(['y=x']);
  });
});
