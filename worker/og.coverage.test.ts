/**
 * The og renderer is a second backend for lib/plot.ts, so it drifts: a type
 * added for the GPU app draws nothing here, and a preview of an empty grid
 * reads as a broken graph.
 *
 * Coverage itself is enforced by the compiler — OG_COVERAGE is a total Record
 * over Plot['type'], so a new plot family fails `pnpm typecheck` until it is
 * classified. These tests cover what types cannot: that the classification is
 * honest, and that callers act on it.
 */
import { describe, expect, it } from 'vitest';
import { OG_COVERAGE, canRenderOg } from './og.ts';

describe('og renderer coverage', () => {
  it('draws the everyday 2D and 3D families', () => {
    for (const t of ['implicit2d', 'ineq2d', 'scalar2d', 'point', 'pcurve', 'psurface', 'implicit3d'] as const) {
      expect(OG_COVERAGE[t], t).toBe('draws');
    }
  });

  it('falls back for every shader-only family', () => {
    for (const t of ['complex2d', 'domain2d', 'conformal2d', 'fractal2d', 'vfield2d'] as const) {
      expect(OG_COVERAGE[t], t).toBe('fallback');
    }
  });
});

describe('canRenderOg', () => {
  it('accepts graphs built only from drawable rows', () => {
    expect(canRenderOg(['y = sin(x)'])).toBe(true);
    expect(canRenderOg(['x^2 + y^2 = 9', 'y < cos(x)'])).toBe(true);
    expect(canRenderOg(['z = sin(x) cos(y)'])).toBe(true);
    expect(canRenderOg(['(cos(2pi u), sin(2pi u), u)'])).toBe(true);
    expect(canRenderOg(['a = 2', 'y = sin(a x)'])).toBe(true); // definition + plot
  });

  it('rejects graphs whose preview would be misleading', () => {
    expect(canRenderOg(['domain((w^3 - 1)/w)'])).toBe(false);
    expect(canRenderOg(['iter(z^2 + w)'])).toBe(false);
    expect(canRenderOg(['conformal(w^2/4)'])).toBe(false);
    expect(canRenderOg(['(-y, x)'])).toBe(false);
    expect(canRenderOg(['ln(w-2) - ln(w+2)'])).toBe(false);
    // One unsupported row poisons the graph: a partial picture is still wrong.
    expect(canRenderOg(['y = sin(x)', 'iter(z^2 + w)'])).toBe(false);
  });

  it('rejects graphs with nothing to draw', () => {
    expect(canRenderOg([])).toBe(false);
    expect(canRenderOg(['a = 2'])).toBe(false); // definitions only
    expect(canRenderOg(['y = ('])).toBe(false); // parse error
  });
});
