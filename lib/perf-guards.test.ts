/**
 * Tier-1 performance guards: deterministic, count/size-based invariants.
 * These fail exactly and only when a change alters compile *structure* —
 * no wall-clock, so they are CI-stable.
 *
 * Budgets are pinned at ~2.5x the measured value at introduction. If a test
 * fails, either a regression slipped in (fix it) or a feature legitimately
 * grew the output (raise the budget in the same PR, on purpose, in review).
 * Run with PERF_MEASURE=1 to print current actuals for re-pinning.
 */
import { describe, expect, test } from 'vitest';
import { CORPUS, compileRows, countNodes } from './perfcase.ts';
import { parseExpr } from './expr.ts';
import { diff } from './diff.ts';
import { toGLSL } from './glsl.ts';

const MEASURE = !!process.env.PERF_MEASURE;

describe('uniform parameterization (slider moves must not change compiled output)', () => {
  // The renderer caches shader programs by source; slider drags recompile
  // rows on every input event. That is only cheap because constants compile
  // to u_<name> uniforms, making the GLSL byte-identical across values.
  // A feature that bakes constant *values* into plot output turns every
  // slider tick into a shader compile — the class of regression this pins.
  for (const item of CORPUS) {
    test(item.name, () => {
      const a = compileRows(item.rows(1.25));
      const b = compileRows(item.rows(2.5));
      expect(a.errors).toEqual([]);
      expect(JSON.stringify(a.classified)).toBe(JSON.stringify(b.classified));
      expect(JSON.stringify(a.gridFields.map(g => ({ ...g, expr: null, grad: null }))))
        .toBe(JSON.stringify(b.gridFields.map(g => ({ ...g, expr: null, grad: null }))));
    });
  }
});

describe('compiled size budgets', () => {
  // GLSL source length per corpus case: catches codegen blowup (e.g. an
  // expansion pass or a pow-unrolling change exploding shader size, which
  // shows up as shader-compile hitches at runtime).
  // ~2.5x the measured length at introduction (2026-07); CPU-path plots
  // (point, pcurve) carry Exprs not GLSL, hence the small floors.
  const GLSL_BUDGET: Record<string, number> = {
    scalar2d: 130,
    implicit2d: 110,
    ineq2d: 70,
    complex2d: 160,
    pcurve3d: 50,
    psurface: 160,
    implicit3d: 380,
    point: 50,
    derivative: 210,
    userfn: 280,
    polarfield: 400,
  };

  const glslOf = (rows: string[]): string => {
    const { classified, gridFields } = compileRows(rows);
    const parts: string[] = [];
    for (const c of classified) {
      // Collect every string field of the plot — they are all GLSL or labels.
      for (const v of Object.values(c.plot)) {
        if (typeof v === 'string') parts.push(v);
        if (Array.isArray(v)) for (const s of v) if (typeof s === 'string') parts.push(s);
      }
    }
    for (const g of gridFields) {
      parts.push(g.glsl, ...(g.gradGlsl ?? []));
    }
    return parts.join('\n');
  };

  for (const item of CORPUS) {
    test(item.name, () => {
      const len = glslOf(item.rows(2)).length;
      if (MEASURE) console.log(`glsl ${item.name}: ${len}`);
      expect(len).toBeLessThanOrEqual(GLSL_BUDGET[item.name]);
    });
  }
});

describe('symbolic derivative swell budgets', () => {
  // diff() output is compiled into shaders (gradients, d/dx rows). Symbolic
  // swell here multiplies into every downstream compile.
  const CASES: { name: string; src: string; order: number; budget: number }[] = [
    { name: 'product chain', src: 'sin(x) cos(x) e^x', order: 3, budget: 550 },
    { name: 'power tower', src: 'sin(x)^8', order: 2, budget: 70 },
    { name: 'quotient', src: '(x^2 + 1)/(x^3 - x + 2)', order: 2, budget: 280 },
    { name: 'nested trig', src: 'sin(cos(tan(x)))', order: 2, budget: 190 },
  ];
  for (const c of CASES) {
    test(c.name, () => {
      let e = parseExpr(c.src);
      for (let k = 0; k < c.order; k++) e = diff(e, 'x');
      const n = countNodes(e);
      const len = toGLSL(e).length;
      if (MEASURE) console.log(`diff ${c.name}: nodes=${n} glsl=${len}`);
      expect(n).toBeLessThanOrEqual(c.budget);
    });
  }
});
