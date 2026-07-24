import { describe, expect, it } from 'vitest';
import { fitView2D, formatCameraRow, formatViewRow, parseViewRow } from './view.ts';

const parse = (text: string, env: Record<string, number> = {}) => parseViewRow(text, env);

describe('parseViewRow', () => {
  it('parses both axes, one axis, and constant bounds', () => {
    expect(parse('view(x = -5..5, y = -2..2)')).toEqual({ kind: 'view', x: [-5, 5], y: [-2, 2] });
    expect(parse('view(y = 0..10)')).toEqual({ kind: 'view', y: [0, 10] });
    expect(parse('view(x = -pi..pi)')).toEqual({ kind: 'view', x: [-Math.PI, Math.PI] });
    expect(parse('view(x = -a..a)', { a: 2 })).toEqual({ kind: 'view', x: [-2, 2] });
  });

  it('parses camera angles with optional radius and target in either order', () => {
    expect(parse('camera(-pi/3, 0.6)')).toEqual({ kind: 'camera', theta: -Math.PI / 3, phi: 0.6 });
    expect(parse('camera(0, 1, 7)')).toEqual({ kind: 'camera', theta: 0, phi: 1, radius: 7 });
    expect(parse('camera(0, 1, 7, (1, 0, 2))')).toEqual({
      kind: 'camera', theta: 0, phi: 1, radius: 7, target: [1, 0, 2],
    });
    expect(parse('camera(0, 1, (1, 0, 2))')).toEqual({
      kind: 'camera', theta: 0, phi: 1, target: [1, 0, 2],
    });
  });

  it('returns null for rows that are not viewport rows', () => {
    expect(parse('y = x^2')).toBeNull();
    expect(parse('viewer(x = 1..2)')).toBeNull(); // prefix only — no false claim
    expect(parse('a = 2')).toBeNull();
    expect(parse('view(x = 1..2) + 1')).toBeNull(); // not the whole row
  });

  it('gives row-friendly errors for malformed viewport rows', () => {
    expect(() => parse('view()')).toThrow(/Expected view/);
    expect(() => parse('view(z = 1..2)')).toThrow(/x and y/);
    expect(() => parse('view(x = 5..-5)')).toThrow(/lo < hi/);
    expect(() => parse('view(x = 1..2, x = 3..4)')).toThrow(/twice/);
    expect(() => parse('view(x = 1)')).toThrow(/Expected view/);
    expect(() => parse('view(x = q..2)')).toThrow(/lower bound/);
    expect(() => parse('camera(1)')).toThrow(/Expected camera/);
    expect(() => parse('camera(0, 1, -3)')).toThrow(/positive/);
    expect(() => parse('camera(0, 1, (1, 2))')).toThrow(/3 components/);
  });
});

describe('fitView2D', () => {
  it('fits the whole box at uniform scale, centered', () => {
    // A 10×4 box in a 100×100 viewport: x is the binding axis.
    const v = fitView2D({ kind: 'view', x: [0, 10], y: [-2, 2] }, 100, 100);
    expect(v).toEqual({ cx: 5, cy: 0, upp: 0.1 });
    // Same box in a wide viewport: y binds instead.
    const w = fitView2D({ kind: 'view', x: [0, 10], y: [-2, 2] }, 1000, 10);
    expect(w.upp).toBeCloseTo(0.4);
  });

  it('centers a missing axis at 0', () => {
    const v = fitView2D({ kind: 'view', x: [90, 110] }, 200, 100);
    expect(v).toEqual({ cx: 100, cy: 0, upp: 0.1 });
  });
});

describe('writeback round-trip', () => {
  it('view row text survives format -> parse', () => {
    const text = formatViewRow(-4.133333, 5.87, -2.4, 2.4);
    expect(parse(text)).toEqual({ kind: 'view', x: [-4.13333, 5.87], y: [-2.4, 2.4] });
  });

  it('camera row text survives format -> parse, dropping an origin target', () => {
    const noTarget = formatCameraRow({ theta: -1.0471975, phi: 0.5711986, radius: 14, target: [0, 0, 0] });
    expect(noTarget).toBe('camera(-1.0472, 0.571199, 14)');
    expect(parse(noTarget)).toEqual({ kind: 'camera', theta: -1.0472, phi: 0.571199, radius: 14 });
    const withTarget = formatCameraRow({ theta: 0, phi: 1, radius: 7, target: [1.25, 0, -2] });
    expect(parse(withTarget)).toEqual({ kind: 'camera', theta: 0, phi: 1, radius: 7, target: [1.25, 0, -2] });
  });
});
