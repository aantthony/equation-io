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
import { type Expr, parseExpr, substVars } from '../lib/expr.ts';
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
  error?: string;
}

export interface Analysis {
  rows: RowInfo[];
  defs: Defs;
  /** Constant values at t = 0 (for static rendering). */
  constEnv: Record<string, number>;
}

export function analyze(texts: string[]): Analysis {
  const rows: RowInfo[] = texts.map(text => ({ text: text.trim() }));

  // Pass 1: definitions. A duplicate coordinate-field row (r = 1 + cos(theta)
  // after r = sqrt(x^2+y^2)) is a plot in that coordinate system, not an error.
  const raw: Definition[] = [];
  const defNames = new Set<string>();
  const dupRows: RowInfo[] = [];
  for (const row of rows) {
    if (!row.text) continue;
    // `# label` rows are comments (collapsible group headings in the app).
    if (row.text.startsWith('#')) { row.comment = true; continue; }
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
  const seenViewKinds = new Set<string>();
  for (const row of rows) {
    if (row.def || row.comment || row.error || !row.text) continue;
    try {
      const view = parseViewRow(row.text, constEnv);
      if (view) {
        if (seenViewKinds.has(view.kind)) throw new Error(`${view.kind} is already set by another row.`);
        seenViewKinds.add(view.kind);
        row.view = view;
        continue;
      }
      const seq = scanSeqRec(row.text);
      if (seq) {
        row.cls = classifySeqRec(seq, fnNames, getFn, constNames);
        continue;
      }
      let parsed = resolveExpr(parseExpr(row.text, fnNames), getFn);
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

  return { rows, defs, constEnv };
}
