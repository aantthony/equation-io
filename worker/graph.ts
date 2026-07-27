/**
 * Shared graph analysis for the MCP server and OG-image renderer.
 *
 * Mirrors the web app's recompile pipeline (web/main.ts): scan definition
 * rows, build defs, then parse/resolve/classify each plot row. Kept in sync
 * by using the exact same lib functions.
 */
import {
  buildDefs,
  compsOf,
  defKey,
  evalConstEnv,
  resolveExpr,
  scanDefinition,
  type Definition,
  type Defs,
} from '../lib/defs.ts';
import {
  RVSystem,
  buildRVSystem,
  checkDerived,
  densityExpr,
  matchProbability,
  probabilityValue,
  regionExpr,
  scanRandomRows,
  toProbability,
} from '../lib/dist.ts';
import { type Expr, freeVars, parseExpr, substVars } from '../lib/expr.ts';
import { lowerGeom } from '../lib/geom.ts';
import { type Classified, classify } from '../lib/plot.ts';
import { classifySeqRec, scanSeqRec } from '../lib/seq.ts';
import { buildStateSystem, initialState } from '../lib/state.ts';
import { type ViewSpec, parseViewRow } from '../lib/view.ts';

export interface RowInfo {
  text: string;
  /** Set for definition rows (constants, functions, coordinate fields). */
  def?: Definition;
  /** Set for viewport rows (view(...) / camera(...)). */
  view?: ViewSpec;
  /** Set for plot rows that classified successfully. */
  cls?: Classified;
  /** The fully resolved expression a plot row renders (fields substituted). */
  expr?: Expr;
  /** Set for `# label` comment rows (group headings in the app; not plotted). */
  comment?: boolean;
  /** Set for probability rows: `X ~ …` plots a density, `P(…)` a shaded area. */
  dist?: 'density' | 'probability';
  /** Readout shown under the row in the app (the numeric value of a P(…) row). */
  info?: string;
  error?: string;
}

export interface Analysis {
  rows: RowInfo[];
  defs: Defs;
  /** Constant values at t = 0 (for static rendering). */
  constEnv: Record<string, number>;
  /** Declared random variables (density/prob rows sample through this). */
  rvs: RVSystem;
}

export function analyze(texts: string[]): Analysis {
  const rows: RowInfo[] = texts.map(text => ({ text: text.trim() }));

  // Random-variable rows (`X ~ …`, and `Y = X^2` referencing one) resolve
  // outside the definition system — mirror of web/main.ts recompileAll.
  const rvScan = scanRandomRows(rows.map(r =>
    !r.text || r.text.startsWith('#') || scanSeqRec(r.text) ? null : r.text));
  const rvRowIdx = new Set([...rvScan.base.keys(), ...rvScan.derived.keys()]);

  // Pass 1: definitions. A duplicate coordinate-field row (r = 1 + cos(theta)
  // after r = sqrt(x^2+y^2)) is a plot in that coordinate system, not an error.
  const raw: Definition[] = [];
  const defNames = new Set<string>();
  const dupRows: RowInfo[] = [];
  for (const [i, row] of rows.entries()) {
    if (!row.text) continue;
    // `# label` rows are comments (collapsible group headings in the app).
    if (row.text.startsWith('#')) { row.comment = true; continue; }
    if (rvRowIdx.has(i)) continue;
    // Sequence/recurrence rows (a_n = …, a_{n+1} = …) are plots, not definitions.
    if (scanSeqRec(row.text)) continue;
    const d = scanDefinition(row.text);
    if (!d) continue;
    row.def = d;
    if (defNames.has(defKey(d))) { dupRows.push(row); continue; }
    defNames.add(defKey(d));
    raw.push(d);
  }

  const built = buildDefs(raw);
  const defs = built.defs;
  for (const [key, message] of built.errors) {
    const row = rows.find(r => r.def && defKey(r.def) === key);
    if (row) row.error = message;
  }
  for (const row of dupRows) {
    if (defs.fields.has(row.def!.name)) row.def = undefined;
    else row.error = `${defKey(row.def!)} is already defined.`;
  }

  // Constants at t = 0, needed by pass 2: viewport-row bounds may use them.
  // States are seeded at their `a(0)` values, so the static render shows the
  // simulation's first frame (constants like the pendulum's D resolve too).
  const sys = buildStateSystem(defs);
  const stateVals = sys ? initialState(defs, sys) : {};
  let constEnv: Record<string, number> = {};
  try {
    constEnv = evalConstEnv(defs, 0, stateVals);
  } catch {
    // A broken constant already carries a row error; rendering treats it as 0.
    constEnv = { ...stateVals };
  }

  // Pass 2: viewport rows and plots. States are constants to every consumer.
  const constNames = new Set([...defs.consts.keys(), ...defs.states.keys()]);
  const fieldEnv = Object.fromEntries(defs.fields);
  const fnNames = new Set(raw.filter(d => d.kind === 'fn').map(d => d.name));
  const getFn = (name: string) => {
    const fn = defs.fns.get(name);
    if (!fn && fnNames.has(name)) throw new Error(`${name} has an error in its definition.`);
    return fn;
  };

  // Random variables next, so P(…) and bare-expression rows can reference
  // them regardless of row order.
  const rvs = new RVSystem();
  const builtRVs = buildRVSystem(rvs, rvScan, {
    fnNames,
    getFn,
    constNames,
    taken: n => defs.consts.has(n) || defs.fns.has(n) || defs.fields.has(n)
      || defs.states.has(n) || defs.points.has(n) || defs.mats.has(n),
  });
  const rvNames = builtRVs.names;
  const densityCls = (name: string): Classified => {
    const ps = rvs.paramsOf(name);
    return {
      plot: { type: 'density', rv: name },
      animated: ps.has('t'),
      needs3D: false,
      params: [...ps].filter(p => p !== 't'),
    };
  };
  for (const [i, name] of builtRVs.rowRV) {
    const row = rows[i];
    const message = builtRVs.errors.get(i);
    if (message) {
      row.error = message;
      continue;
    }
    row.dist = 'density';
    const rv = rvs.get(name)!;
    // Base declarations and derived variables with a closed form (affine in
    // normal bases) draw the exact pdf; the rest estimate from samples.
    const exact = rv.kind === 'base' ? rv.dist : rvs.exactDist(name);
    if (exact) {
      const density = densityExpr(exact);
      row.cls = classify(density, constNames);
      row.expr = density;
    } else {
      row.cls = densityCls(name);
    }
  }

  const seenViewKinds = new Set<string>();
  for (const [ri, row] of rows.entries()) {
    if (row.def || row.comment || row.error || row.cls || !row.text) continue;
    try {
      const view = parseViewRow(row.text, constEnv);
      if (view) {
        if (seenViewKinds.has(view.kind)) throw new Error(`${view.kind} is already set by another row.`);
        seenViewKinds.add(view.kind);
        row.view = view;
        continue;
      }
      // `P(…)` shades an area under a declared density — unless the user has
      // defined P themselves, in which case the row is theirs.
      const probBody = defs.consts.has('P') || defs.fns.has('P') ? null : matchProbability(row.text);
      if (probBody !== null) {
        if (!rvNames.size) throw new Error('Define a random variable first, e.g. X ~ Normal(0, 1).');
        const p = toProbability(resolveExpr(parseExpr(probBody, fnNames), getFn), rvNames);
        for (const name of p.rvs) {
          if (!rvs.has(name)) throw new Error(`${name} has an error in its definition.`);
        }
        row.dist = 'probability';
        // Inline bounded expressions become anonymous derived variables, so
        // shading and exact laws apply — mirror of web/main.ts.
        let single = p.single;
        if (!single && p.inline) {
          checkDerived(p.inline.e, rvNames, constNames);
          const anon = `@P${ri}`;
          rvs.add({ name: anon, kind: 'derived', expr: p.inline.e });
          single = { rv: anon, lo: p.inline.lo, hi: p.inline.hi };
        }
        // Constant bounds on one variable with a closed form get the exact
        // CDF and the shader-drawn region; the rest estimate over samples.
        const exact = single ? rvs.exactDist(single.rv) : null;
        if (single && exact) {
          const region = regionExpr(exact, single.lo, single.hi);
          row.cls = classify(region, constNames);
          row.expr = region;
          try {
            const value = probabilityValue(exact, single.lo, single.hi, constEnv);
            if (isFinite(value)) row.info = `≈ ${value.toFixed(4)}`;
          } catch {
            // Not numerically computable at t = 0 (e.g. animated); no readout.
          }
        } else {
          const ps = rvs.bodyParams(p.body);
          row.cls = {
            plot: { type: 'prob', body: p.body, shade: single },
            animated: ps.has('t'),
            needs3D: false,
            params: [...ps].filter(v => v !== 't'),
          };
          try {
            // A uniform-sum law still gets its exact value (mirror of the
            // app's readout); everything else estimates over joint samples.
            const value = single
              ? rvs.exactProbability(single.rv, single.lo, single.hi, constEnv)
              : null;
            if (value !== null) {
              if (isFinite(value)) row.info = `≈ ${value.toFixed(4)}`;
            } else {
              const mc = rvs.probability(p.body, constEnv);
              if (isFinite(mc)) row.info = `≈ ${mc.toFixed(3)}`;
            }
          } catch { /* animated or broken: no readout */ }
        }
        continue;
      }
      const seq = scanSeqRec(row.text);
      if (seq) {
        row.cls = classifySeqRec(seq, fnNames, getFn, constNames);
        continue;
      }
      let parsed = resolveExpr(parseExpr(row.text, fnNames), getFn);
      // A bare expression in random variables plots that derived density.
      const rvRefs = [...freeVars(parsed)].filter(n => rvNames.has(n));
      if (rvRefs.length) {
        for (const n of rvRefs) {
          if (!rvs.has(n)) throw new Error(`${n} has an error in its definition.`);
        }
        if (parsed.kind === 'ineq') {
          throw new Error(`An inequality in random variables is a probability: try P(${row.text}).`);
        }
        checkDerived(parsed, rvNames, constNames);
        row.dist = 'density';
        const name = `@${ri}`;
        rvs.add({ name, kind: 'derived', expr: parsed });
        const exactAnon = rvs.exactDist(name);
        if (exactAnon) {
          const density = densityExpr(exactAnon);
          row.cls = classify(density, constNames);
          row.expr = density;
        } else {
          row.cls = densityCls(name);
        }
        continue;
      }
      // Expand point arithmetic and geometry statements (segment, polygon, …)
      // into scalar expressions; a point name A becomes (A_x, A_y).
      parsed = lowerGeom(parsed, n => compsOf(defs, n), n => defs.mats.get(n) ?? null);
      if (defs.fields.size) parsed = substVars(parsed, fieldEnv);
      row.cls = classify(parsed, constNames);
      row.expr = parsed;
    } catch (e) {
      row.error = e instanceof Error ? e.message : String(e);
    }
  }

  return { rows, defs, constEnv, rvs };
}
