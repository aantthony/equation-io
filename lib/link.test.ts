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

  it('separates rows whether the separator arrives raw or encoded', () => {
    // Copying a /g/ link out of the address bar can hand the separator back as
    // %3B. A payload that stops separating becomes one row containing a ';',
    // which then fails to parse with "Invalid character".
    const expected = ['y = sin(x)', 'y=x'];
    expect(decodePayload('y%20%3D%20sin%28x%29;y%3Dx')).toEqual(expected); // as emitted
    expect(decodePayload('y = sin(x);y=x')).toEqual(expected); // fully decoded
    expect(decodePayload('y%20=%20sin(x);y=x')).toEqual(expected); // partly decoded
    expect(decodePayload('y%20=%20sin(x)%3By=x')).toEqual(expected); // separator encoded
    expect(decodePayload('y%20%3D%20sin%28x%29%3By%3Dx')).toEqual(expected); // fully encoded
    expect(decodePayload('y%20=%20sin(x)%3by=x')).toEqual(expected); // lowercase %3b
  });

  it('round-trips comment rows (# group headings)', () => {
    const rows = ['# Lines', 'y=x', 'y=x^2', '# Another group'];
    expect(decodePayload(encodePayload(rows))).toEqual(rows);
  });

  it('keeps a single row whole', () => {
    expect(decodePayload('y%20%3D%20sin%28x%29')).toEqual(['y = sin(x)']);
    expect(decodePayload('(cos(2pi u), sin(2pi u), u)')).toEqual(['(cos(2pi u), sin(2pi u), u)']);
  });
});
