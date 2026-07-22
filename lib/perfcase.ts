/**
 * Shared corpus + row-compilation pipeline for the performance guard tests
 * (perf-guards.test.ts, perf-smoke.test.ts, perf.bench.ts).
 *
 * compileRows mirrors web/main.ts recompileAll: scan definition rows, build
 * defs, then resolve + classify the plot rows against them. Kept in sync by
 * hand; if recompileAll gains steps that affect compile output, add them here.
 */
import {
  type Definition,
  animatedConstNames,
  buildDefs,
  evalConstEnv,
  resolveExpr,
  scanDefinition,
} from './defs.ts';
import { parseExpr, substVars } from './expr.ts';
import { type Classified, classify } from './plot.ts';
import { buildGridField, type GridField } from './grid.ts';

export interface CompiledRows {
  classified: Classified[];
  gridFields: GridField[];
  errors: string[];
}

export function compileRows(rows: string[]): CompiledRows {
  const raw: Definition[] = [];
  const seen = new Set<string>();
  const plotTexts: string[] = [];
  for (const text0 of rows) {
    const text = text0.trim();
    if (!text) continue;
    const d = scanDefinition(text);
    if (d && !seen.has(d.name)) {
      seen.add(d.name);
      raw.push(d);
      continue;
    }
    plotTexts.push(text);
  }
  const built = buildDefs(raw);
  const errors = [...built.errors.values()];
  const constNames = new Set(built.defs.consts.keys());
  const gridFields: GridField[] = [];
  for (const [name, e] of built.defs.fields) {
    gridFields.push(buildGridField(name, e, constNames));
  }
  const fieldEnv = Object.fromEntries(built.defs.fields);
  const fnNames = new Set(raw.filter(d => d.kind === 'fn').map(d => d.name));
  const getFn = (name: string) => built.defs.fns.get(name);
  // Σ/Π bounds expand against constant *values*, so they need the same env
  // recompileAll builds (animated constants excluded).
  let constVals: Record<string, number> = {};
  try {
    constVals = evalConstEnv(built.defs, 0);
  } catch {}
  for (const name of animatedConstNames(built.defs)) delete constVals[name];
  const classified: Classified[] = [];
  for (const text of plotTexts) {
    let parsed = resolveExpr(parseExpr(text, fnNames), getFn, { consts: constVals });
    if (built.defs.fields.size) parsed = substVars(parsed, fieldEnv);
    classified.push(classify(parsed, constNames));
  }
  return { classified, gridFields, errors };
}

/**
 * Representative rows spanning every compile path, each with a slider
 * constant so uniform-parameterization can be asserted. When a new plot
 * family lands, add a case here (and a budget in perf-guards.test.ts).
 */
export const CORPUS: { name: string; rows: (c: number) => string[] }[] = [
  { name: 'scalar2d', rows: c => [`a = ${c}`, 'y = sin(a x) + x^2/4'] },
  { name: 'implicit2d', rows: c => [`c = ${c}`, 'x^2 + y^2 = c^2'] },
  { name: 'ineq2d', rows: c => [`a = ${c}`, 'y < a x^2'] },
  { name: 'complex2d', rows: c => [`a = ${c}`, 'w^2 + a'] },
  { name: 'pcurve3d', rows: c => [`k = ${c}`, '(cos(2pi k u), sin(2pi k u), u)'] },
  { name: 'psurface', rows: c => [`b = ${c}`, '(u, v, b u v)'] },
  { name: 'implicit3d', rows: c => [`b = ${c}`, 'z = sin(b x) cos(b y)'] },
  { name: 'point', rows: c => [`a = ${c}`, '(a, a^2)'] },
  { name: 'derivative', rows: c => [`a = ${c}`, 'y = d/dx (sin(a x) x^2)'] },
  { name: 'userfn', rows: c => [`a = ${c}`, 'f(x) = a x^2 + sin(x)', 'y = f(f(x))'] },
  { name: 'polarfield', rows: c => [`a = ${c}`, 'r = sqrt(x^2 + y^2)', 'r = 2a'] },
  { name: 'vfield2d', rows: c => [`a = ${c}`, '(-a y, a x)'] },
  { name: 'ode2d', rows: c => [`a = ${c}`, 'dy/dx = a x y'] },
  { name: 'domain2d', rows: c => [`a = ${c}`, 'domain((w^3 - a)/w)'] },
  { name: 'conformal2d', rows: c => [`a = ${c}`, 'conformal(w^2/a)'] },
  { name: 'fractal2d', rows: c => [`a = ${c}`, 'iter(z^2 + w/a)'] },
];

/**
 * Σ/Π is the one compile path that deliberately breaks uniform
 * parameterization: bounds expand at compile time, so the bound constant's
 * *value* is baked into the output and every step of an N slider produces
 * new GLSL — and a new shader compile. Kept out of CORPUS (which asserts the
 * invariant) and pinned separately in perf-guards.test.ts, so the cost stays
 * measured rather than forgotten.
 */
export const SUM_CASE = (n: number) => [`N = ${n}`, 'y = (4/pi) sum(k=1..N, sin((2k-1)x)/(2k-1))'];

/** Structural size of an expression tree (perf proxy for symbolic swell). */
export function countNodes(e: unknown): number {
  if (e === null || typeof e !== 'object') return 0;
  let n = 1;
  for (const v of Object.values(e)) {
    if (Array.isArray(v)) for (const item of v) n += countNodes(item);
    else if (typeof v === 'object') n += countNodes(v);
  }
  return n;
}
