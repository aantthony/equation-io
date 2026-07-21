import {
  type Definition,
  type Defs,
  animatedConstNames,
  buildDefs,
  constsAnimated,
  emptyDefs,
  evalConstEnv,
  resolveExpr,
  scanDefinition,
} from '../lib/defs.ts';
import { type Expr, evaluate, freeVars, parseExpr, substVars } from '../lib/expr.ts';
import { type GridField, angularSpacing, buildGridField, sampleGradMag } from '../lib/grid.ts';
import { type Classified, classify } from '../lib/plot.ts';
import { splitStatements } from '../lib/statements.ts';
import { fullscreenQuad } from './gl.ts';
import {
  type GridSpec,
  type Layers2D,
  type Overlay2D,
  Renderer2D,
  type VField2D,
  type View2D,
  drawLabels2D,
  niceSpacing,
} from './render2d.ts';
import { type Camera3D, Renderer3D, type Scene3D, drawLabels3D } from './render3d.ts';
import { initTheme, onThemeChange, theme, toggleTheme } from './theme.ts';

interface Equation {
  id: number;
  text: string;
  colorIndex: number;
  cls?: Classified;
  error?: string;
  /** Set when the row is a definition (`a = 2`, `f(x) = …`) rather than a plot. */
  def?: Definition;
  sliderMin?: number;
  sliderMax?: number;
  /** Interleaved non-editable widgets, created lazily and kept across edits. */
  sliderUI?: SliderUI;
  errorEl?: HTMLElement;
}

interface SliderUI {
  box: HTMLElement;
  min: HTMLInputElement;
  range: HTMLInputElement;
  max: HTMLInputElement;
}

function cssColor([r, g, b]: [number, number, number]): string {
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

const CURVE_SAMPLES = 400;
/** RK4 steps in each direction for a dropped integral curve. */
const ODE_STEPS = 1400;
/** Most integral-curve seeds kept at once; older seeds evict first. */
const MAX_DROPS = 12;

// --- state ---

let nextId = 1;
const equations: Equation[] = [];
let mode: '2d' | '3d' = '2d';
let defs: Defs = emptyDefs();
let defsAnimated = false;
let constEnv: Record<string, number> = {};
/** Constants used as Σ/Π bounds; their sliders snap to integer steps. */
let sumBoundNames = new Set<string>();
/** Compiled coordinate fields; non-empty replaces the Cartesian grid. */
let gridFields: GridField[] = [];
/** Click-dropped seeds for integral curves through vector fields / ODEs. */
const drops: Array<{ x: number; y: number }> = [];

const view: View2D = { cx: 0, cy: 0, upp: 0.01 };
const camera: Camera3D = { target: [0, 0, 0], radius: 14, theta: -Math.PI / 3, phi: Math.PI / 5.5 };

// --- canvas / renderers ---

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLCanvasElement;
// alpha: false — passes blend with low src alpha, and a non-opaque buffer
// would be composited over the page as premultiplied, washing fills white.
const glCtx = canvas.getContext('webgl2', { antialias: true, alpha: false });
if (!glCtx) {
  document.body.innerHTML = '<p style="padding:2em">WebGL2 is required.</p>';
  throw new Error('WebGL2 unavailable');
}
const gl = glCtx;
const quad = fullscreenQuad(gl);
const r2d = new Renderer2D(gl, quad);
const r3d = new Renderer3D(gl, quad);
const overlayCtx = overlay.getContext('2d')!;

/** True until the canvas has been measured once and the opening zoom picked. */
let awaitingFirstSize = true;

/** Point the drawing buffers at the canvas's real CSS box. Returns false while
 *  the element has no box yet (not laid out, hidden), in which case the old
 *  buffer is left alone rather than blanked. Called before every frame as well
 *  as on resize: a buffer whose aspect drifts from the box gets stretched by
 *  CSS, which is what made shared links open squashed and at a random zoom. */
function syncCanvasSize(): boolean {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (!w || !h) return false;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    overlay.width = w;
    overlay.height = h;
  }
  // The opening scale comes from the buffer we just sized, not from
  // window.innerWidth * devicePixelRatio — those agree only once the page has
  // settled, and a link opened mid-transition would otherwise keep whatever
  // zoom the guess produced.
  if (awaitingFirstSize) {
    awaitingFirstSize = false;
    view.upp = 12 / Math.min(w, h); // ~12 math units across the short edge
  }
  return true;
}

function resize() {
  syncCanvasSize();
  requestRender();
}

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  let ran = false;
  const run = () => {
    if (ran) return;
    ran = true;
    renderQueued = false;
    render();
  };
  requestAnimationFrame(run);
  // rAF stalls entirely in hidden/occluded tabs (embedded previews,
  // screenshot tooling); a timer backstop keeps frames coming there.
  setTimeout(run, 200);
}

const startTime = performance.now();

function render() {
  if (!syncCanvasSize()) return;
  const dpr = window.devicePixelRatio || 1;
  const time = (performance.now() - startTime) / 1000;
  const active = equations.filter(e => e.cls && !e.error);
  mode = active.some(e => e.cls!.needs3D) ? '3d' : '2d';

  try {
    constEnv = evalConstEnv(defs, time);
  } catch {
    constEnv = {};
  }

  gl.clearColor(theme.bg[0], theme.bg[1], theme.bg[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // CPU sampling of parametric curves / points, with t bound to seconds.
  const sampleCurve = (eq: Equation, dim: 2 | 3): number[] => {
    const { comps } = eq.cls!.plot as { comps: import('../lib/expr.ts').Expr[] };
    const out: number[] = [];
    for (let k = 0; k < CURVE_SAMPLES; k++) {
      const u = k / (CURVE_SAMPLES - 1);
      for (let c = 0; c < dim; c++) {
        try {
          out.push(evaluate(comps[c], { ...constEnv, u, t: time }));
        } catch {
          out.push(NaN);
        }
      }
    }
    return out;
  };
  // RK4 streamline of the normalized field through (x0, y0), both directions.
  // Normalizing makes it a direction field: uniform arc-length steps, and the
  // same trajectories (dy/dx = f slope fields integrate as (1, f) normalized).
  const integralCurve = (comps: [Expr, Expr], x0: number, y0: number, time: number): number[] => {
    const env: Record<string, number> = { ...constEnv, t: time, x: 0, y: 0 };
    const f = (x: number, y: number): [number, number] | null => {
      env.x = x;
      env.y = y;
      let vx: number, vy: number;
      try {
        vx = evaluate(comps[0], env);
        vy = evaluate(comps[1], env);
      } catch {
        return null;
      }
      const m = Math.hypot(vx, vy);
      if (!isFinite(m) || m < 1e-12) return null;
      return [vx / m, vy / m];
    };
    const h = 2.5 * view.upp; // ~2.5 px of arc per step
    const boundW = 1.5 * gl.drawingBufferWidth * view.upp;
    const boundH = 1.5 * gl.drawingBufferHeight * view.upp;
    const side = (sgn: number): number[] => {
      const out: number[] = [];
      let x = x0;
      let y = y0;
      for (let i = 0; i < ODE_STEPS; i++) {
        const k1 = f(x, y);
        if (!k1) break;
        const k2 = f(x + sgn * (h / 2) * k1[0], y + sgn * (h / 2) * k1[1]);
        if (!k2) break;
        const k3 = f(x + sgn * (h / 2) * k2[0], y + sgn * (h / 2) * k2[1]);
        if (!k3) break;
        const k4 = f(x + sgn * h * k3[0], y + sgn * h * k3[1]);
        if (!k4) break;
        x += sgn * (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
        y += sgn * (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
        if (!isFinite(x) || !isFinite(y)) break;
        out.push(x, y);
        if (Math.abs(x - view.cx) > boundW || Math.abs(y - view.cy) > boundH) break;
      }
      return out;
    };
    const back = side(-1);
    const pts: number[] = [];
    for (let i = back.length - 2; i >= 0; i -= 2) pts.push(back[i], back[i + 1]);
    pts.push(x0, y0);
    pts.push(...side(1));
    return pts;
  };

  const samplePoint = (eq: Equation): number[] | null => {
    const { coords } = eq.cls!.plot as { coords: import('../lib/expr.ts').Expr[] };
    try {
      const p = coords.map(c => evaluate(c, { ...constEnv, t: time }));
      return p.every(isFinite) ? p : null;
    } catch {
      return null;
    }
  };

  if (mode === '3d') {
    const scene: Scene3D = { implicits: [], psurfaces: [], curves: [], points: [] };
    for (const eq of active) {
      const color = theme.palette[eq.colorIndex];
      const plot = eq.cls!.plot;
      const params = eq.cls!.params;
      switch (plot.type) {
        case 'implicit2d': // extrudes to its true locus (a vertical sheet)
          scene.implicits.push({ field: plot.field, color, params });
          break;
        case 'implicit3d':
          scene.implicits.push({ field: plot.field, grad: plot.grad, color, params });
          break;
        case 'scalar2d':
        case 'complex2d':
        case 'domain2d':
        case 'conformal2d':
        case 'fractal2d':
        case 'ineq2d':
        case 'vfield2d':
          break; // density/complex/region/flow fields have no 3D locus; skipped in 3D scenes
        case 'psurface':
          scene.psurfaces.push({ comps: plot.comps, du: plot.du, dv: plot.dv, color, params });
          break;
        case 'pcurve': {
          const flat = sampleCurve(eq, plot.dim);
          const pts = new Float32Array(CURVE_SAMPLES * 3);
          for (let k = 0; k < CURVE_SAMPLES; k++) {
            pts[k * 3] = flat[k * plot.dim];
            pts[k * 3 + 1] = flat[k * plot.dim + 1];
            pts[k * 3 + 2] = plot.dim === 3 ? flat[k * plot.dim + 2] : 0;
          }
          scene.curves.push({ pts, color });
          break;
        }
        case 'point': {
          const p = samplePoint(eq);
          if (p) scene.points.push({ pos: [p[0], p[1], p[2] ?? 0], color });
          break;
        }
      }
    }
    r3d.render(camera, scene, time, constEnv);
    drawLabels3D(overlayCtx, camera, dpr);
  } else {
    const layers: Required<Layers2D> = {
      fractals: [], domains: [], conformals: [], vfields: [],
      ineqs: [], scalars: [], complexes: [], curves: [],
    };
    const extras: Overlay2D = { points: [], polylines: [] };
    for (const eq of active) {
      const color = theme.palette[eq.colorIndex];
      const plot = eq.cls!.plot;
      const params = eq.cls!.params;
      switch (plot.type) {
        case 'implicit2d': layers.curves.push({ field: plot.field, color, params }); break;
        case 'ineq2d': layers.ineqs.push({ field: plot.field, edges: plot.edges, color, params }); break;
        case 'scalar2d': layers.scalars.push({ field: plot.field, color, params }); break;
        case 'complex2d': layers.complexes.push({ field: plot.field, color, params }); break;
        case 'domain2d': layers.domains.push({ field: plot.field, color, params }); break;
        case 'conformal2d': layers.conformals.push({ field: plot.field, color, params }); break;
        case 'fractal2d':
          layers.fractals.push({ step: plot.step, seed: plot.seed, maxIter: plot.maxIter, color, params });
          break;
        case 'vfield2d': {
          layers.vfields.push({ fx: plot.fx, fy: plot.fy, color, params });
          for (const d of drops) {
            extras.polylines.push({ pts: integralCurve(plot.comps, d.x, d.y, time), color: cssColor(color) });
            extras.points.push({ x: d.x, y: d.y, color: cssColor(color) });
          }
          break;
        }
        case 'pcurve': extras.polylines.push({ pts: sampleCurve(eq, 2), color: cssColor(color) }); break;
        case 'point': {
          const p = samplePoint(eq);
          if (p) extras.points.push({ x: p[0], y: p[1], color: cssColor(color) });
          break;
        }
      }
    }
    // Spacing per grid family: sample |∇c| around the view to convert the
    // target pixel gap into coordinate units (π-based for angles).
    let gridSpecs: GridSpec[] | undefined;
    if (gridFields.length) {
      const halfW = (gl.drawingBufferWidth / 2) * view.upp;
      const halfH = (gl.drawingBufferHeight / 2) * view.upp;
      const pts: Array<[number, number]> = [
        [view.cx, view.cy],
        [view.cx - halfW / 2, view.cy], [view.cx + halfW / 2, view.cy],
        [view.cx, view.cy - halfH / 2], [view.cx, view.cy + halfH / 2],
      ];
      const env = { ...constEnv, t: time };
      gridSpecs = gridFields.map(f => {
        const cupp = sampleGradMag(f, pts, env, view.upp * 4) * view.upp;
        const sp = f.angular ? angularSpacing(cupp, 90) : niceSpacing(cupp, 90);
        return { glsl: f.glsl, gradGlsl: f.gradGlsl, params: f.params, major: sp.major, minor: sp.minor };
      });
    }
    r2d.render(view, layers, time, constEnv, gridSpecs);
    drawLabels2D(overlayCtx, view, dpr, extras, !gridFields.length);
  }

  const gridAnimated = mode === '2d'
    && gridFields.some(f => freeVars(f.expr).has('t') || (defsAnimated && f.params.length > 0));
  if (gridAnimated || active.some(e => e.cls!.animated || (defsAnimated && e.cls!.params.length > 0))) requestRender();
}

// --- equation list UI ---
//
// One contentEditable document: each equation is a `.eq-line` div, so a whole
// system of equations can be selected, copied, and pasted as plain text.
// Sliders and error messages are `contenteditable=false` `.eq-widget` blocks
// interleaved between lines; they live outside the text model (copy/cut skip
// them) and are reconciled from state after every edit.

const listEl = document.getElementById('equations')!;

/**
 * Recompile every row: scan definitions first (they affect how every other
 * row parses), then classify the plot rows against them. Cheap enough to run
 * on every keystroke.
 */
function recompileAll() {
  const raw: Definition[] = [];
  const defRows = new Map<string, Equation>();
  const dupRows: Equation[] = [];
  for (const eq of equations) {
    eq.cls = undefined;
    eq.error = undefined;
    eq.def = undefined;
    const text = eq.text.trim();
    if (!text) continue;
    const d = scanDefinition(text);
    if (!d) continue;
    eq.def = d;
    if (defRows.has(d.name)) {
      dupRows.push(eq);
      continue;
    }
    defRows.set(d.name, eq);
    raw.push(d);
  }

  const built = buildDefs(raw);
  defs = built.defs;
  defsAnimated = constsAnimated(defs);
  sumBoundNames = built.sumBoundConsts;
  for (const [name, message] of built.errors) {
    const row = defRows.get(name);
    if (row) row.error = message;
  }

  // A second `r = …` row where r is a coordinate field is a plot in that
  // coordinate system (r = 1 + cos(theta)), not a redefinition.
  for (const eq of dupRows) {
    if (defs.fields.has(eq.def!.name)) eq.def = undefined;
    else eq.error = `${eq.def!.name} is already defined.`;
  }

  const constNames = new Set(defs.consts.keys());
  gridFields = [];
  for (const [name, e] of defs.fields) {
    try {
      gridFields.push(buildGridField(name, e, constNames));
    } catch (e) {
      const row = defRows.get(name);
      if (row && !row.error) row.error = e instanceof Error ? e.message : String(e);
    }
  }
  const fieldEnv = Object.fromEntries(defs.fields);
  const fnNames = new Set(raw.filter(d => d.kind === 'fn').map(d => d.name));
  const getFn = (name: string) => {
    const fn = defs.fns.get(name);
    if (!fn && fnNames.has(name)) throw new Error(`${name} has an error in its definition.`);
    return fn;
  };
  // Σ/Π bounds in plot rows expand against the constants' current values
  // (animated ones excluded: expansion is static, so t may not reach bounds).
  let constVals: Record<string, number> = {};
  try {
    constVals = evalConstEnv(defs, 0);
  } catch { /* a broken definition; bounds using it will report the error */ }
  for (const name of animatedConstNames(defs)) delete constVals[name];
  for (const eq of equations) {
    if (eq.def) continue;
    const text = eq.text.trim();
    if (!text) continue;
    try {
      let parsed = resolveExpr(parseExpr(text, fnNames), getFn, { consts: constVals, boundConsts: sumBoundNames });
      // Coordinate fields substitute in as functions of the plane, so
      // `r = 1 + cos(theta)` classifies as an implicit curve in x, y.
      if (defs.fields.size) parsed = substVars(parsed, fieldEnv);
      eq.cls = classify(parsed, constNames);
    } catch (e) {
      eq.error = e instanceof Error ? e.message : String(e);
    }
  }
}

function writeHash() {
  const texts = equations.map(e => e.text).filter(t => t.trim());
  history.replaceState(null, '', texts.length ? '#' + texts.map(encodeURIComponent).join(';') : '#');
}

// Browsers rate-limit replaceState (Safari: 100 per 10s) and throw once it is
// exceeded, so a fast slider drag must not write the hash on every frame.
// Leading edge writes immediately; further calls coalesce into one trailing
// write per second.
const HASH_INTERVAL = 1000;
let hashTimer: ReturnType<typeof setTimeout> | null = null;
let hashPending = false;
let hashLastWrite = 0;

function saveHash() {
  hashPending = true;
  const wait = HASH_INTERVAL - (performance.now() - hashLastWrite);
  if (wait <= 0) {
    flushHash();
    return;
  }
  if (hashTimer === null) hashTimer = setTimeout(flushHash, wait);
}

function flushHash() {
  if (hashTimer !== null) {
    clearTimeout(hashTimer);
    hashTimer = null;
  }
  if (!hashPending) return;
  hashPending = false;
  hashLastWrite = performance.now();
  writeHash();
}

// Don't lose the last edit if the page goes away mid-interval.
addEventListener('pagehide', flushHash);
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushHash();
});

function addEquation(text: string, at = equations.length): Equation {
  const eq: Equation = { id: nextId++, text, colorIndex: (nextId - 2) % theme.palette.length };
  equations.splice(at, 0, eq);
  return eq;
}

/** A slider appears when a constant's right-hand side is a plain number. */
const NUM_RE = /^\s*-?(\d+\.?\d*|\.\d+)([eE]-?\d+)?\s*$/;

const fmtNum = (v: number) => String(parseFloat(v.toPrecision(6)));

const lineEls = (): HTMLElement[] =>
  [...listEl.children].filter((el): el is HTMLElement => el.classList.contains('eq-line'));

const lineText = (line: HTMLElement): string => (line.textContent ?? '').replace(/ /g, ' ');

// --- caret mapped to (line index, character offset) ---

function caretPos(): { line: number; offset: number } | null {
  const sel = getSelection();
  if (!sel?.focusNode || !listEl.contains(sel.focusNode)) return null;
  let node: Node | null = sel.focusNode;
  while (node && node !== listEl) {
    if (node instanceof HTMLElement && node.classList.contains('eq-line')) break;
    node = node.parentNode;
  }
  if (!node || node === listEl) return null;
  const line = lineEls().indexOf(node as HTMLElement);
  if (line < 0) return null;
  const r = document.createRange();
  r.selectNodeContents(node);
  r.setEnd(sel.focusNode, sel.focusOffset);
  return { line, offset: r.toString().length };
}

function setCaret(line: number, offset: number) {
  const el = lineEls()[line];
  if (!el) return;
  const sel = getSelection()!;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let t: Node | null;
  while ((t = walker.nextNode())) {
    const len = t.textContent!.length;
    if (remaining <= len) {
      sel.setBaseAndExtent(t, remaining, t, remaining);
      return;
    }
    remaining -= len;
  }
  sel.setBaseAndExtent(el, el.childNodes.length, el, el.childNodes.length);
}

// --- undo/redo ---
//
// One snapshot stack over the whole document (texts, colors, slider bounds),
// replacing the browser's DOM-level history — programmatic re-renders (Enter,
// paste, ';' splits) would corrupt native undo, and native undo never covered
// structural changes anyway. The full document is a few dozen strings, so
// whole-state snapshots beat operation diffing on simplicity.

interface Snapshot {
  eqs: Array<Pick<Equation, 'id' | 'text' | 'colorIndex' | 'sliderMin' | 'sliderMax'>>;
  caret: { line: number; offset: number } | null;
}

const undoStack: Snapshot[] = [];
const redoStack: Snapshot[] = [];
const UNDO_LIMIT = 100;
const COALESCE_MS = 1000;
let coalesce: { key: string; time: number } | null = null;
/** Caret captured on beforeinput, so native edits snapshot their pre-edit caret. */
let pendingCaret: { line: number; offset: number } | null = null;

function takeSnapshot(caret: Snapshot['caret']): Snapshot {
  return {
    eqs: equations.map(e => ({
      id: e.id,
      text: e.text,
      colorIndex: e.colorIndex,
      sliderMin: e.sliderMin,
      sliderMax: e.sliderMax,
    })),
    caret,
  };
}

/**
 * Record pre-mutation state; call before changing `equations`. A non-null
 * `key` merges runs of the same operation (typing on one line, one slider
 * drag, cycling a color) into a single undo entry while the run continues
 * within COALESCE_MS.
 */
function pushUndo(key: string | null, caret: Snapshot['caret'] = caretPos()) {
  const now = performance.now();
  if (key && coalesce?.key === key && now - coalesce.time < COALESCE_MS) {
    coalesce.time = now;
    return;
  }
  undoStack.push(takeSnapshot(caret));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
  coalesce = key ? { key, time: now } : null;
}

function restoreSnapshot(s: Snapshot) {
  // Reuse Equation objects by id so widget elements survive the round-trip.
  const byId = new Map(equations.map(e => [e.id, e]));
  equations.length = 0;
  for (const se of s.eqs) {
    const eq = byId.get(se.id) ?? { id: se.id, text: '', colorIndex: se.colorIndex };
    Object.assign(eq, se);
    equations.push(eq);
  }
  recompileAll();
  renderAll();
  if (s.caret && s.caret.line < equations.length) {
    setCaret(s.caret.line, Math.min(s.caret.offset, equations[s.caret.line].text.length));
  }
  saveHash();
  requestRender();
}

function doUndo() {
  const s = undoStack.pop();
  if (!s) return;
  redoStack.push(takeSnapshot(caretPos()));
  coalesce = null;
  restoreSnapshot(s);
}

function doRedo() {
  const s = redoStack.pop();
  if (!s) return;
  undoStack.push(takeSnapshot(caretPos()));
  coalesce = null;
  restoreSnapshot(s);
}

// --- rendering & reconciliation ---

function makeSlider(eq: Equation): SliderUI {
  const box = document.createElement('div');
  box.className = 'eq-widget eq-slider';
  box.contentEditable = 'false';
  const min = document.createElement('input');
  min.type = 'number';
  min.className = 'eq-slider-bound';
  min.title = 'Slider minimum';
  const range = document.createElement('input');
  range.type = 'range';
  range.className = 'eq-slider-range';
  const max = document.createElement('input');
  max.type = 'number';
  max.className = 'eq-slider-bound';
  max.title = 'Slider maximum';
  box.append(min, range, max);

  range.addEventListener('input', () => {
    if (eq.def?.kind !== 'const') return;
    pushUndo(`slider:${eq.id}`);
    eq.text = `${eq.def.name} = ${fmtNum(Number(range.value))}`;
    const line = lineEls()[equations.indexOf(eq)];
    if (line) line.textContent = eq.text;
    recompileAll();
    reconcile();
    saveHash();
    requestRender();
  });
  // A drag is one undo entry: coalesced while it lasts, sealed on release.
  range.addEventListener('change', () => {
    coalesce = null;
  });
  const onBound = () => {
    const lo = Number(min.value);
    const hi = Number(max.value);
    if (isFinite(lo) && isFinite(hi) && hi > lo) {
      pushUndo(`bounds:${eq.id}`);
      eq.sliderMin = lo;
      eq.sliderMax = hi;
    }
    reconcile();
  };
  min.addEventListener('change', onBound);
  max.addEventListener('change', onBound);
  return { box, min, range, max };
}

/**
 * Sync per-line decorations (color, error state, placeholder) and the
 * interleaved widget blocks with current state. Never touches line text, so
 * it is safe to run while the user is typing (the caret stays put).
 */
function reconcile() {
  const lines = lineEls();
  lines.forEach((line, i) => {
    const eq = equations[i];
    if (!eq) return;
    line.dataset.id = String(eq.id);
    line.style.setProperty('--eq-color', cssColor(theme.palette[eq.colorIndex]));
    line.classList.toggle('invalid', !!eq.error);
    line.classList.toggle('is-def', !!eq.def);
    line.title = eq.error ?? '';
    if (equations.length === 1 && !eq.text.trim()) line.dataset.ph = 'add an equation…';
    else delete line.dataset.ph;

    const wanted: HTMLElement[] = [];
    const sliderable = eq.def?.kind === 'const' && !eq.error && NUM_RE.test(eq.def.rhs);
    if (sliderable) {
      eq.sliderUI ??= makeSlider(eq);
      const { min, range, max } = eq.sliderUI;
      const v = Number(eq.def!.rhs);
      if (eq.sliderMin === undefined || eq.sliderMax === undefined) {
        eq.sliderMin = Math.min(-10, Math.floor(v));
        eq.sliderMax = Math.max(10, Math.ceil(v));
      }
      if (v < eq.sliderMin) eq.sliderMin = v;
      if (v > eq.sliderMax) eq.sliderMax = v;
      min.value = fmtNum(eq.sliderMin);
      max.value = fmtNum(eq.sliderMax);
      range.min = String(eq.sliderMin);
      range.max = String(eq.sliderMax);
      // Σ/Π bounds are integers, so their sliders step whole terms at a time.
      range.step = sumBoundNames.has(eq.def!.name) ? '1' : String((eq.sliderMax - eq.sliderMin) / 400);
      range.value = String(v);
      wanted.push(eq.sliderUI.box);
    }
    if (eq.error) {
      eq.errorEl ??= (() => {
        const el = document.createElement('div');
        el.className = 'eq-widget eq-error';
        el.contentEditable = 'false';
        return el;
      })();
      eq.errorEl.textContent = eq.error;
      wanted.push(eq.errorEl);
    }
    // Place widgets directly after their line, then drop anything stale
    // before the next line.
    let ref: ChildNode = line;
    for (const w of wanted) {
      if (ref.nextSibling !== w) listEl.insertBefore(w, ref.nextSibling);
      ref = w;
    }
    while (ref.nextSibling && !(ref.nextSibling instanceof HTMLElement && ref.nextSibling.classList.contains('eq-line'))) {
      ref.nextSibling.remove();
    }
  });
}

/** Full rebuild of the editable DOM from state (loses caret; callers restore). */
function renderAll() {
  listEl.textContent = '';
  for (const eq of equations) {
    const line = document.createElement('div');
    line.className = 'eq-line';
    line.dataset.id = String(eq.id);
    if (eq.text) line.textContent = eq.text;
    else line.append(document.createElement('br'));
    listEl.append(line);
  }
  reconcile();
}

/**
 * Read the DOM back into `equations` after a native edit. Normalizes stray
 * nodes the browser may create (bare text at container level, unclassed divs
 * from splits), matches lines to state by data-id (first occurrence wins —
 * Chrome clones attributes when Enter splits a line), and creates/drops
 * Equation entries to mirror the document.
 */
function syncFromDOM() {
  for (const node of [...listEl.childNodes]) {
    if (node instanceof HTMLElement) {
      if (node.classList.contains('eq-line') || node.classList.contains('eq-widget')) continue;
      if (node.tagName === 'BR') node.remove();
      else node.classList.add('eq-line');
    } else if (node.nodeType === Node.TEXT_NODE && node.textContent) {
      const div = document.createElement('div');
      div.className = 'eq-line';
      listEl.insertBefore(div, node);
      div.append(node); // moving (not copying) the text node keeps the caret in it
    } else if (node.nodeType === Node.TEXT_NODE) {
      node.remove();
    }
  }
  const lines = lineEls();
  if (!lines.length) {
    equations.length = 0;
    addEquation('');
    renderAll();
    setCaret(0, 0);
    return;
  }
  const byId = new Map(equations.map(e => [String(e.id), e]));
  const seen = new Set<string>();
  const next: Equation[] = [];
  for (const line of lines) {
    const id = line.dataset.id;
    let eq = id && !seen.has(id) ? byId.get(id) : undefined;
    if (!eq) {
      eq = { id: nextId++, text: '', colorIndex: (nextId - 2) % theme.palette.length };
      line.dataset.id = String(eq.id);
    }
    seen.add(String(eq.id));
    eq.text = lineText(line);
    next.push(eq);
  }
  equations.length = 0;
  equations.push(...next);
}

/**
 * Replace the current selection with pasted/typed multi-statement text,
 * entirely in state space. Statements separate on newlines or ';' (the same
 * separator the examples menu and the URL hash use, so pasted lists and
 * copied blocks both just work).
 */
function insertStatements(text: string) {
  const sel = getSelection();
  if (!sel?.rangeCount) return;
  pushUndo(null);
  // Map both selection endpoints to (line, offset) before touching anything.
  const posOf = (node: Node, off: number): { line: number; offset: number } => {
    const lines = lineEls();
    const atEndOf = (from: Node | null): { line: number; offset: number } => {
      // Nearest line at or before `from` (walking previous siblings).
      for (let p = from; p; p = p.previousSibling) {
        if (p instanceof HTMLElement && p.classList.contains('eq-line')) {
          return { line: lines.indexOf(p), offset: lineText(p).length };
        }
      }
      return { line: 0, offset: 0 };
    };
    let el: Node | null = node;
    while (el && el !== listEl && el.parentNode !== listEl) el = el.parentNode;
    if (!el) return { line: 0, offset: 0 };
    // Container-level boundary (e.g. select-all): position sits between children.
    if (el === listEl) return atEndOf(listEl.childNodes[Math.min(off, listEl.childNodes.length) - 1] ?? null);
    if (el instanceof HTMLElement && el.classList.contains('eq-line')) {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.setEnd(node, off);
      return { line: lines.indexOf(el), offset: r.toString().length };
    }
    return atEndOf(el); // widget or stray node: attach to the line above it
  };
  const range = sel.getRangeAt(0);
  const a = posOf(range.startContainer, range.startOffset);
  const b = posOf(range.endContainer, range.endOffset);
  const [start, end] = a.line < b.line || (a.line === b.line && a.offset <= b.offset) ? [a, b] : [b, a];

  const parts = splitStatements(text);
  const before = equations[start.line]?.text.slice(0, start.offset) ?? '';
  const after = equations[end.line]?.text.slice(end.offset) ?? '';
  const first = equations[start.line] ?? addEquation('');
  const inserted: Equation[] = [first];
  first.text = before + parts[0];
  for (let i = 1; i < parts.length; i++) {
    inserted.push({ id: nextId++, text: parts[i].trim(), colorIndex: (nextId - 2) % theme.palette.length });
  }
  const caretOffset = inserted[inserted.length - 1].text.length;
  inserted[inserted.length - 1].text += after;
  equations.splice(start.line, end.line - start.line + 1, ...inserted);

  recompileAll();
  renderAll();
  setCaret(start.line + inserted.length - 1, caretOffset);
  saveHash();
  requestRender();
}

/** Selected lines as clean newline-joined text — widget content never leaks in. */
function selectionAsText(): string | null {
  const sel = getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  const parts: string[] = [];
  for (const line of lineEls()) {
    if (!r.intersectsNode(line)) continue;
    const lr = document.createRange();
    lr.selectNodeContents(line);
    // Clamp only when the boundary lies inside this line: a boundary at the
    // container level or in a widget must never widen lr past line contents.
    if (line.contains(r.startContainer) && r.compareBoundaryPoints(Range.START_TO_START, lr) > 0) {
      lr.setStart(r.startContainer, r.startOffset);
    }
    if (line.contains(r.endContainer) && r.compareBoundaryPoints(Range.END_TO_END, lr) < 0) {
      lr.setEnd(r.endContainer, r.endOffset);
    }
    parts.push(lr.toString().replace(/ /g, ' '));
  }
  return parts.length ? parts.join('\n') : null;
}

// --- editor events ---

// First beforeinput listener: route undo/redo to our stack and capture the
// pre-edit caret for the snapshot the upcoming 'input' event will push.
listEl.addEventListener('beforeinput', e => {
  if (e.inputType === 'historyUndo') {
    e.preventDefault();
    doUndo();
    return;
  }
  if (e.inputType === 'historyRedo') {
    e.preventDefault();
    doRedo();
    return;
  }
  pendingCaret = caretPos();
});

listEl.addEventListener('input', e => {
  if (e.target !== listEl) return; // slider/bound inputs bubble their 'input' here
  pushUndo(`edit:${pendingCaret?.line ?? -1}`, pendingCaret ?? caretPos());
  syncFromDOM();
  // Typing ';' splits the line into rows, matching the old per-input behavior.
  if (equations.some(eq => eq.text.includes(';'))) {
    const caret = caretPos();
    let caretLine = caret?.line ?? 0;
    let caretOff = caret?.offset ?? 0;
    for (let i = equations.length - 1; i >= 0; i--) {
      const eq = equations[i];
      if (!eq.text.includes(';')) continue;
      const parts = splitStatements(eq.text).map(s => s.trim());
      if (parts.length === 1) continue; // ';' inside brackets: not a separator
      if (i === caretLine) {
        const sepsBefore = splitStatements(eq.text.slice(0, caretOff)).length - 1;
        caretLine += sepsBefore;
        caretOff = parts[Math.min(sepsBefore, parts.length - 1)].length;
      }
      eq.text = parts[0];
      parts.slice(1).forEach((p, k) => addEquation(p, i + 1 + k));
    }
    recompileAll();
    renderAll();
    setCaret(caretLine, caretOff);
  } else {
    recompileAll();
    reconcile();
  }
  saveHash();
  requestRender();
});

// Enter splits the line in state space rather than letting the browser pick a
// DOM shape for the new paragraph (div vs br varies across engines). Undo
// shortcuts are handled here too — keydown wins over beforeinput, and some
// engines skip the historyUndo beforeinput when their native stack is empty.
listEl.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.altKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) doRedo();
    else doUndo();
    return;
  }
  if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    doRedo();
    return;
  }
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  insertStatements('\n');
});

// Backspace/Delete at a widget boundary: the browser would delete the widget
// block (it reappears on reconcile — an infinite wall). Merge the adjacent
// lines in state instead.
listEl.addEventListener('beforeinput', e => {
  if (e.inputType !== 'deleteContentBackward' && e.inputType !== 'deleteContentForward') return;
  const sel = getSelection();
  if (!sel?.isCollapsed) return;
  const pos = caretPos();
  if (!pos) return;
  const lines = lineEls();
  const back = e.inputType === 'deleteContentBackward';
  const from = back ? pos.line : pos.line + 1;
  if (back && (pos.offset !== 0 || pos.line === 0)) return;
  if (!back && (pos.offset !== equations[pos.line].text.length || pos.line === lines.length - 1)) return;
  if (lines[from - 1].nextElementSibling === lines[from]) return; // no widget between: native merge is fine
  e.preventDefault();
  pushUndo(null);
  const offset = equations[from - 1].text.length;
  equations[from - 1].text += equations[from].text;
  equations.splice(from, 1);
  recompileAll();
  renderAll();
  setCaret(from - 1, offset);
  saveHash();
  requestRender();
});

listEl.addEventListener('paste', e => {
  e.preventDefault();
  insertStatements(e.clipboardData?.getData('text/plain') ?? '');
});

listEl.addEventListener('copy', e => {
  const text = selectionAsText();
  if (text === null) return;
  e.preventDefault();
  e.clipboardData?.setData('text/plain', text);
});

listEl.addEventListener('cut', e => {
  const text = selectionAsText();
  if (text === null) return;
  e.preventDefault();
  e.clipboardData?.setData('text/plain', text);
  insertStatements('');
});

// Click on a line's color dot (the ::before in the left gutter) cycles color.
listEl.addEventListener('pointerdown', e => {
  const line = e.target instanceof HTMLElement ? e.target.closest('.eq-line') : null;
  if (!line) return;
  if (e.clientX - line.getBoundingClientRect().left > 22) return;
  const eq = equations[lineEls().indexOf(line as HTMLElement)];
  if (!eq || eq.def) return;
  e.preventDefault();
  pushUndo(`color:${eq.id}`);
  eq.colorIndex = (eq.colorIndex + 1) % theme.palette.length;
  reconcile();
  requestRender();
});

// Highlight the line holding the caret (no per-line focus to key off).
document.addEventListener('selectionchange', () => {
  const pos = caretPos();
  lineEls().forEach((line, i) => line.classList.toggle('focused', i === pos?.line));
});

// --- examples menu ---

const EXAMPLES: Array<[string, Array<[string, string]>]> = [
  ['curves', [
    ['parabola', 'y = x^2'],
    ['circle', 'x^2 + y^2 = 4'],
    ['tangent', 'y = tan(x)'],
    ['lemniscate', '(x^2+y^2)^2 = 8(x^2-y^2)'],
    ['traveling wave', 'y = sin(x - 2t)'],
  ]],
  ['fields', [
    ['interference', 'sin(x)cos(y)'],
    ['ripples', 'sin(x^2 + y^2 - 4t)/2'],
  ]],
  ['vector fields', [
    ['rotation', '(-y, x)'],
    ['saddle', '(x, -y)'],
    ['shear + swirl', '(sin(y), sin(x))'],
  ]],
  ['odes (click to trace)', [
    ['slope field', "y' = x - y"],
    ['logistic growth', "dy/dx = y(1 - y/4)"],
    ['pendulum phase portrait', "(x', y') = (y, -sin(x))"],
    ['van der pol', "(x', y') = (y, (1 - x^2)y - x)"],
  ]],
  ['complex', [
    ['point charge', 'ln(w)'],
    ['dipole', 'ln(w-2) - ln(w+2)'],
    ['quadrupole', 'ln(w-2) + ln(w+2) - ln(w-2i) - ln(w+2i)'],
    ['flow past cylinder', 'w + 4/w'],
    ['orbiting charge', 'ln(w-2) - ln(w + 2e^(i t))'],
    ['domain coloring', 'domain((w^3 - 1)/w)'],
    ['conformal map', 'conformal(w^2/4)'],
    ['joukowski airfoil', 'conformal(w + 1/w)'],
  ]],
  ['fractals', [
    ['mandelbrot set', 'iter(z^2 + w)'],
    ['julia set', 'iter(z^2 - 0.7269 + 0.1889i)'],
    ['julia orbit', 'iter(z^2 + 0.7885e^(i t/8))'],
    ['burning ship', 'iter((|re(z)| - i |im(z)|)^2 + w)'],
  ]],
  ['coordinates', [
    ['polar grid', 'r = sqrt(x^2 + y^2); theta = atan2(y, x)'],
    ['cardioid in polar', 'r = sqrt(x^2 + y^2); theta = atan2(y, x); r = 2(1 + cos(theta))'],
    ['polar spiral', 'r = sqrt(x^2 + y^2); theta = atan2(y, x); r = theta + pi'],
    ['log-polar', 'rho = ln(x^2 + y^2)/2; theta = atan2(y, x)'],
    ['hyperbolic grid', 'p = x y; q = (x^2 - y^2)/2'],
    ['spinning polar', 'r = sqrt(x^2 + y^2); theta = atan2(y, x) + t/4'],
  ]],
  ['regions', [
    ['open half-plane', 'y < x/2 + 1'],
    ['closed disc', 'x^2 + y^2 <= 4'],
    ['annulus', '4 <= x^2 + y^2 <= 9'],
    ['band under a wave', '-1 <= y - sin(x) < 1'],
  ]],
  ['sliders + calculus', [
    ['slider', 'a = 2; y = sin(a x)/a'],
    ['function', 'f(x) = x^3 - 3x; y = f(x)'],
    ['derivative', 'y = d/dx (x^3 - 3x)'],
    ['tangent line', 'f(x) = x^3 - 2x; g(x) = d/dx f(x); a = 1; y = f(x); y = f(a) + g(a)(x - a)'],
    ['orbiting charge', 'r = 2 + sin(t); ln(w - r) - ln(w + r)'],
  ]],
  ['series', [
    ['fourier square wave', 'N = 3; y = (4/pi) sum(n=1..N, sin((2n-1)x)/(2n-1))'],
    ['fourier sawtooth', 'N = 5; y = 2 sum[n=1..N] (-1)^(n+1) sin(n x)/n'],
    ['taylor cosine', 'N = 2; y = sum(n=0..N, (-1)^n x^(2n)/prod(k=1..2n, k)); y = cos(x)'],
  ]],
  ['points + motion', [
    ['a point', '(2, 3)'],
    ['orbit', '(2cos(t), 2sin(t))'],
    ['lissajous', '(2cos(2pi u), sin(4pi u))'],
    ['spiral', '(u cos(6pi u) 3, u sin(6pi u) 3)'],
  ]],
  ['3d surfaces', [
    ['waves', 'z = sin(x)cos(y)'],
    ['sphere', 'x^2 + y^2 + z^2 = 9'],
    ['saddle', 'z = (x^2 - y^2)/4'],
    ['gyroid', 'sin(x)cos(y) + sin(y)cos(z) + sin(z)cos(x) = 0'],
  ]],
  ['parametric 3d', [
    ['helix', '(2cos(6pi u), 2sin(6pi u), 4u - 2)'],
    ['torus', '(cos(2pi u)(2+cos(2pi v)), sin(2pi u)(2+cos(2pi v)), sin(2pi v))'],
    ['sphere (u,v)', '(2sin(pi v)cos(2pi u), 2sin(pi v)sin(2pi u), 2cos(pi v))'],
    ['breathing torus', '(cos(2pi u)(2+cos(2pi v+t)), sin(2pi u)(2+cos(2pi v+t)), sin(2pi v+t))'],
  ]],
];

function insertExample(text: string) {
  pushUndo(null);
  // Fill the trailing empty line (or append) so existing equations stay.
  // Multi-row examples separate rows with ';' (the same separator as the hash).
  for (const part of splitStatements(text)) {
    let eq = equations[equations.length - 1];
    if (!eq || eq.text.trim()) eq = addEquation('');
    eq.text = part.trim();
  }
  recompileAll();
  saveHash();
  renderAll();
  requestRender();
}

function buildExamplesMenu() {
  const list = document.getElementById('examples-list')!;
  for (const [category, items] of EXAMPLES) {
    const group = document.createElement('details');
    const label = document.createElement('summary');
    label.textContent = category;
    group.append(label);
    for (const [name, text] of items) {
      const item = document.createElement('button');
      item.className = 'ex-item';
      item.textContent = name;
      const code = document.createElement('code');
      code.textContent = text;
      item.append(code);
      item.addEventListener('click', () => insertExample(text));
      group.append(item);
    }
    list.append(group);
  }
}

// --- interaction ---

let dragging = false;
let lastX = 0;
let lastY = 0;
let panning = false;
const pointers = new Map<number, { x: number; y: number }>();
let pinchDist = 0;
let downX = 0;
let downY = 0;
let dragMoved = false;

/** Zoom by `factor` keeping the math point under (clientX, clientY) fixed. */
function zoomAt(clientX: number, clientY: number, factor: number) {
  if (mode === '2d') {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const px = (clientX - rect.left - rect.width / 2) * dpr;
    const py = (rect.height / 2 - (clientY - rect.top)) * dpr;
    const mx = view.cx + px * view.upp;
    const my = view.cy + py * view.upp;
    view.upp *= factor;
    view.cx = mx - px * view.upp;
    view.cy = my - py * view.upp;
  } else {
    camera.radius = Math.min(1e6, Math.max(1e-4, camera.radius * factor));
  }
  requestRender();
}

canvas.addEventListener('pointerdown', e => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {} // synthetic events have no active pointer to capture
  if (pointers.size === 1) {
    dragging = true;
    panning = e.button === 2 || e.shiftKey;
    lastX = e.clientX;
    lastY = e.clientY;
    downX = e.clientX;
    downY = e.clientY;
    dragMoved = false;
  } else if (pointers.size === 2) {
    // Second finger: switch from drag to pinch, anchored at the midpoint.
    dragging = false;
    dragMoved = true; // a pinch is never a seed-dropping click
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    lastX = (a.x + b.x) / 2;
    lastY = (a.y + b.y) / 2;
  }
});
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointermove', e => {
  const p = pointers.get(e.pointerId);
  if (p) {
    p.x = e.clientX;
    p.y = e.clientY;
  }
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = mx - lastX;
    const dy = my - lastY;
    const dpr = window.devicePixelRatio || 1;
    if (mode === '2d') {
      view.cx -= dx * dpr * view.upp;
      view.cy += dy * dpr * view.upp;
    }
    if (dist > 0 && pinchDist > 0) zoomAt(mx, my, pinchDist / dist);
    pinchDist = dist;
    lastX = mx;
    lastY = my;
    requestRender();
    return;
  }
  if (!dragging) return;
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 3) dragMoved = true;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  const dpr = window.devicePixelRatio || 1;
  if (mode === '2d') {
    view.cx -= dx * dpr * view.upp;
    view.cy += dy * dpr * view.upp;
  } else if (panning) {
    // Pan the target in the camera's screen plane.
    const s = camera.radius * 0.0022;
    const ct = Math.cos(camera.theta), st = Math.sin(camera.theta);
    const sp = Math.sin(camera.phi), cp = Math.cos(camera.phi);
    // right = (-sinθ, cosθ, 0); up = (-cosθ·sinφ, -sinθ·sinφ, cosφ)
    camera.target[0] += (st * dx + ct * sp * dy) * s;
    camera.target[1] += (-ct * dx + st * sp * dy) * s;
    camera.target[2] += cp * dy * s;
  } else {
    camera.theta -= dx * 0.008;
    camera.phi = Math.min(Math.PI / 2 - 0.01, Math.max(-Math.PI / 2 + 0.01, camera.phi + dy * 0.008));
  }
  requestRender();
});
const endPointer = (e: PointerEvent) => {
  pointers.delete(e.pointerId);
  if (pointers.size === 1) {
    // Pinch ended with one finger still down: resume dragging from it.
    const [p] = pointers.values();
    dragging = true;
    panning = false;
    lastX = p.x;
    lastY = p.y;
  } else if (pointers.size === 0) {
    dragging = false;
  }
};
canvas.addEventListener('pointerup', e => {
  endPointer(e);
  // A motionless primary-button click in 2D drops an integral-curve seed on
  // vector fields; right/shift clicks are pan gestures, not seeds.
  if (dragMoved || pointers.size || mode !== '2d' || e.button !== 0 || e.shiftKey) return;
  if (!equations.some(q => !q.error && q.cls?.plot.type === 'vfield2d')) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left - rect.width / 2) * dpr;
  const py = (rect.height / 2 - (e.clientY - rect.top)) * dpr;
  // Each seed costs an RK4 integration per field per frame; keep the newest.
  if (drops.length >= MAX_DROPS) drops.shift();
  drops.push({ x: view.cx + px * view.upp, y: view.cy + py * view.upp });
  requestRender();
});
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('dblclick', () => {
  if (!drops.length) return;
  drops.length = 0;
  requestRender();
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = Math.exp(Math.max(-60, Math.min(60, e.deltaY)) * 0.002);
  zoomAt(e.clientX, e.clientY, factor);
}, { passive: false });

// The canvas box changes without a window resize event on mobile (URL bar
// collapsing, safe-area shifts, an in-app browser animating to full height),
// so observe the element itself. The window listener stays for devicePixelRatio
// changes, which move no box at all.
window.addEventListener('resize', resize);
new ResizeObserver(resize).observe(canvas);

// --- theme ---

const themeToggle = document.getElementById('theme-toggle') as HTMLButtonElement | null;
function syncThemeToggle() {
  if (!themeToggle) return;
  themeToggle.textContent = theme.dark ? '☀' : '☾';
  const next = theme.dark ? 'light' : 'dark';
  themeToggle.setAttribute('aria-label', `Switch to ${next} mode`);
  themeToggle.title = `Switch to ${next} mode`;
}
initTheme();
// Color dots and every WebGL pass read `theme` live; redraw both on a switch.
onThemeChange(() => {
  syncThemeToggle();
  reconcile();
  requestRender();
});
syncThemeToggle();
themeToggle?.addEventListener('click', toggleTheme);

// --- boot ---

const fromHash = splitStatements(decodeURIComponent(location.hash.slice(1)))
  .map(s => decodeURIComponent(s))
  .filter(s => s.trim());
if (fromHash.length) fromHash.forEach(t => addEquation(t));
else addEquation('y = sin(x)');
recompileAll();

// Size the canvas (which also picks the opening zoom) before the first frame.
resize();
renderAll();
buildExamplesMenu();

// Dev-only handle for driving/inspecting the view in automated tests.
if (import.meta.env.DEV) (window as any).__eq = { view, camera };
