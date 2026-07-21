import {
  type Definition,
  type Defs,
  buildDefs,
  constsAnimated,
  emptyDefs,
  evalConstEnv,
  resolveExpr,
  scanDefinition,
} from '../lib/defs.ts';
import { evaluate, freeVars, parseExpr, substVars } from '../lib/expr.ts';
import { type GridField, angularSpacing, buildGridField, sampleGradMag } from '../lib/grid.ts';
import { type Classified, classify } from '../lib/plot.ts';
import { fullscreenQuad } from './gl.ts';
import {
  type Curve2D,
  type GridSpec,
  type Ineq2D,
  type Overlay2D,
  Renderer2D,
  type View2D,
  drawLabels2D,
  niceSpacing,
} from './render2d.ts';
import { type Camera3D, Renderer3D, type Scene3D, drawLabels3D } from './render3d.ts';

const PALETTE: [number, number, number][] = [
  [0.176, 0.439, 0.702], // blue
  [0.780, 0.267, 0.251], // red
  [0.220, 0.549, 0.275], // green
  [0.376, 0.259, 0.651], // purple
  [0.980, 0.494, 0.098], // orange
  [0.000, 0.000, 0.000], // black
];

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
  /** Sync this row's error/slider UI with current state (set by rebuildList). */
  refresh?: () => void;
}

function cssColor([r, g, b]: [number, number, number]): string {
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

const CURVE_SAMPLES = 400;

// --- state ---

let nextId = 1;
const equations: Equation[] = [];
let mode: '2d' | '3d' = '2d';
let defs: Defs = emptyDefs();
let defsAnimated = false;
let constEnv: Record<string, number> = {};
/** Compiled coordinate fields; non-empty replaces the Cartesian grid. */
let gridFields: GridField[] = [];

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

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    overlay.width = w;
    overlay.height = h;
  }
  requestRender();
}

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

const startTime = performance.now();

function render() {
  const dpr = window.devicePixelRatio || 1;
  const time = (performance.now() - startTime) / 1000;
  const active = equations.filter(e => e.cls && !e.error);
  mode = active.some(e => e.cls!.needs3D) ? '3d' : '2d';

  try {
    constEnv = evalConstEnv(defs, time);
  } catch {
    constEnv = {};
  }

  gl.clearColor(1, 1, 1, 1);
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
      const color = PALETTE[eq.colorIndex];
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
        case 'ineq2d':
          break; // density/complex/region fields have no 3D locus; skipped in 3D scenes
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
    const curves: Curve2D[] = [];
    const scalars: Curve2D[] = [];
    const complexes: Curve2D[] = [];
    const ineqs: Ineq2D[] = [];
    const extras: Overlay2D = { points: [], polylines: [] };
    for (const eq of active) {
      const color = PALETTE[eq.colorIndex];
      const plot = eq.cls!.plot;
      const params = eq.cls!.params;
      switch (plot.type) {
        case 'implicit2d': curves.push({ field: plot.field, color, params }); break;
        case 'ineq2d': ineqs.push({ field: plot.field, edges: plot.edges, color, params }); break;
        case 'scalar2d': scalars.push({ field: plot.field, color, params }); break;
        case 'complex2d': complexes.push({ field: plot.field, color, params }); break;
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
    r2d.render(view, curves, scalars, complexes, ineqs, time, constEnv, gridSpecs);
    drawLabels2D(overlayCtx, view, dpr, extras, !gridFields.length);
  }

  const gridAnimated = mode === '2d'
    && gridFields.some(f => freeVars(f.expr).has('t') || (defsAnimated && f.params.length > 0));
  if (gridAnimated || active.some(e => e.cls!.animated || (defsAnimated && e.cls!.params.length > 0))) requestRender();
}

// --- equation list UI ---

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
  for (const eq of equations) {
    if (eq.def) continue;
    const text = eq.text.trim();
    if (!text) continue;
    try {
      let parsed = resolveExpr(parseExpr(text, fnNames), getFn);
      // Coordinate fields substitute in as functions of the plane, so
      // `r = 1 + cos(theta)` classifies as an implicit curve in x, y.
      if (defs.fields.size) parsed = substVars(parsed, fieldEnv);
      eq.cls = classify(parsed, constNames);
    } catch (e) {
      eq.error = e instanceof Error ? e.message : String(e);
    }
  }
}

function refreshAll() {
  for (const eq of equations) eq.refresh?.();
}

function saveHash() {
  const texts = equations.map(e => e.text).filter(t => t.trim());
  history.replaceState(null, '', texts.length ? '#' + texts.map(encodeURIComponent).join(';') : '#');
}

function addEquation(text: string): Equation {
  const eq: Equation = { id: nextId++, text, colorIndex: (nextId - 2) % PALETTE.length };
  equations.push(eq);
  return eq;
}

/** A slider appears when a constant's right-hand side is a plain number. */
const NUM_RE = /^\s*-?(\d+\.?\d*|\.\d+)([eE]-?\d+)?\s*$/;

const fmtNum = (v: number) => String(parseFloat(v.toPrecision(6)));

function rebuildList() {
  listEl.innerHTML = '';
  for (const eq of equations) {
    const row = document.createElement('div');
    row.className = 'eq-row';

    const dot = document.createElement('div');
    dot.className = 'eq-color';
    const paint = () => {
      const [r, g, b] = PALETTE[eq.colorIndex];
      dot.style.background = `rgb(${r * 255}, ${g * 255}, ${b * 255})`;
    };
    paint();
    dot.title = 'Change color';
    dot.addEventListener('click', () => {
      eq.colorIndex = (eq.colorIndex + 1) % PALETTE.length;
      paint();
      requestRender();
    });

    const input = document.createElement('input');
    input.className = 'eq-input';
    input.value = eq.text;
    input.placeholder = equations[equations.length - 1] === eq ? 'add an equation…' : '';
    input.spellcheck = false;
    input.autocapitalize = 'off';
    const errorEl = document.createElement('div');
    errorEl.className = 'eq-error';

    // Slider row, shown only while the equation is `name = <number>`.
    const sliderBox = document.createElement('div');
    sliderBox.className = 'eq-slider';
    const minIn = document.createElement('input');
    minIn.type = 'number';
    minIn.className = 'eq-slider-bound';
    minIn.title = 'Slider minimum';
    const range = document.createElement('input');
    range.type = 'range';
    range.className = 'eq-slider-range';
    const maxIn = document.createElement('input');
    maxIn.type = 'number';
    maxIn.className = 'eq-slider-bound';
    maxIn.title = 'Slider maximum';
    sliderBox.append(minIn, range, maxIn);
    sliderBox.style.display = 'none';

    const refresh = () => {
      input.classList.toggle('invalid', !!eq.error);
      input.title = eq.error ?? '';
      errorEl.textContent = eq.error ?? '';
      errorEl.style.display = eq.error ? 'block' : 'none';
      dot.style.visibility = eq.def ? 'hidden' : '';
      const sliderable = eq.def?.kind === 'const' && !eq.error && NUM_RE.test(eq.def.rhs);
      sliderBox.style.display = sliderable ? '' : 'none';
      if (!sliderable) return;
      const v = Number(eq.def!.rhs);
      if (eq.sliderMin === undefined || eq.sliderMax === undefined) {
        eq.sliderMin = Math.min(-10, Math.floor(v));
        eq.sliderMax = Math.max(10, Math.ceil(v));
      }
      if (v < eq.sliderMin) eq.sliderMin = v;
      if (v > eq.sliderMax) eq.sliderMax = v;
      minIn.value = fmtNum(eq.sliderMin);
      maxIn.value = fmtNum(eq.sliderMax);
      range.min = String(eq.sliderMin);
      range.max = String(eq.sliderMax);
      range.step = String((eq.sliderMax - eq.sliderMin) / 400);
      range.value = String(v);
    };
    eq.refresh = refresh;

    range.addEventListener('input', () => {
      if (eq.def?.kind !== 'const') return;
      eq.text = `${eq.def.name} = ${fmtNum(Number(range.value))}`;
      input.value = eq.text;
      recompileAll();
      refreshAll();
      saveHash();
      requestRender();
    });
    const onBound = () => {
      const lo = Number(minIn.value);
      const hi = Number(maxIn.value);
      if (isFinite(lo) && isFinite(hi) && hi > lo) {
        eq.sliderMin = lo;
        eq.sliderMax = hi;
      }
      refresh();
    };
    minIn.addEventListener('change', onBound);
    maxIn.addEventListener('change', onBound);

    input.addEventListener('input', () => {
      const wasLast = equations[equations.length - 1] === eq;
      eq.text = input.value;
      recompileAll();
      refreshAll();
      saveHash();
      requestRender();
      if (wasLast && input.value.trim()) {
        addEquation('');
        rebuildList();
        // Rebuilding replaces the input; restore focus and caret.
        const inputs = listEl.querySelectorAll<HTMLInputElement>('.eq-input');
        const mine = inputs[equations.indexOf(eq)];
        mine.focus();
        mine.selectionStart = mine.selectionEnd = input.selectionStart;
      }
    });
    refresh();

    const remove = document.createElement('button');
    remove.className = 'eq-remove';
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.addEventListener('click', () => {
      equations.splice(equations.indexOf(eq), 1);
      if (!equations.length || equations[equations.length - 1].text.trim()) addEquation('');
      recompileAll();
      saveHash();
      rebuildList();
      requestRender();
    });

    const col = document.createElement('div');
    col.className = 'eq-col';
    col.append(input, sliderBox, errorEl);
    row.append(dot, col, remove);
    listEl.append(row);
  }
}

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
  ['complex', [
    ['point charge', 'ln(w)'],
    ['dipole', 'ln(w-2) - ln(w+2)'],
    ['quadrupole', 'ln(w-2) + ln(w+2) - ln(w-2i) - ln(w+2i)'],
    ['flow past cylinder', 'w + 4/w'],
    ['orbiting charge', 'ln(w-2) - ln(w + 2e^(i t))'],
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
  // Fill the trailing empty row (or append) so existing equations stay.
  // Multi-row examples separate rows with ';' (the same separator as the hash).
  for (const part of text.split(';')) {
    let eq = equations[equations.length - 1];
    if (!eq || eq.text.trim()) eq = addEquation('');
    eq.text = part.trim();
  }
  addEquation('');
  recompileAll();
  saveHash();
  rebuildList();
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

canvas.addEventListener('pointerdown', e => {
  dragging = true;
  panning = e.button === 2 || e.shiftKey;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointermove', e => {
  if (!dragging) return;
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
canvas.addEventListener('pointerup', () => { dragging = false; });

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = Math.exp(Math.max(-60, Math.min(60, e.deltaY)) * 0.002);
  if (mode === '2d') {
    // Zoom toward the cursor.
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left - rect.width / 2) * dpr;
    const py = (rect.height / 2 - (e.clientY - rect.top)) * dpr;
    const mx = view.cx + px * view.upp;
    const my = view.cy + py * view.upp;
    view.upp *= factor;
    view.cx = mx - px * view.upp;
    view.cy = my - py * view.upp;
  } else {
    camera.radius = Math.min(1e6, Math.max(1e-4, camera.radius * factor));
  }
  requestRender();
}, { passive: false });

window.addEventListener('resize', resize);

// --- boot ---

const fromHash = decodeURIComponent(location.hash.slice(1))
  .split(';')
  .map(s => decodeURIComponent(s))
  .filter(s => s.trim());
if (fromHash.length) fromHash.forEach(addEquation);
else addEquation('y = sin(x)');
addEquation('');
recompileAll();

// Initial 2D scale: ~12 math units across the short screen edge.
view.upp = 12 / (Math.min(window.innerWidth, window.innerHeight) * (window.devicePixelRatio || 1));

rebuildList();
buildExamplesMenu();
resize();
