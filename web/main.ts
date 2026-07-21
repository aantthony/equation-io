import { evaluate, parseExpr } from '../lib/expr.ts';
import { type Classified, classify } from '../lib/plot.ts';
import { fullscreenQuad } from './gl.ts';
import { type Curve2D, type Overlay2D, Renderer2D, type View2D, drawLabels2D } from './render2d.ts';
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
}

function cssColor([r, g, b]: [number, number, number]): string {
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

const CURVE_SAMPLES = 400;

// --- state ---

let nextId = 1;
const equations: Equation[] = [];
let mode: '2d' | '3d' = '2d';

const view: View2D = { cx: 0, cy: 0, upp: 0.01 };
const camera: Camera3D = { target: [0, 0, 0], radius: 14, theta: -Math.PI / 3, phi: Math.PI / 5.5 };

// --- canvas / renderers ---

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLCanvasElement;
const glCtx = canvas.getContext('webgl2', { antialias: true });
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
          out.push(evaluate(comps[c], { u, t: time }));
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
      const p = coords.map(c => evaluate(c, { t: time }));
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
      switch (plot.type) {
        case 'implicit2d': // extrudes to its true locus (a vertical sheet)
          scene.implicits.push({ field: plot.field, color });
          break;
        case 'implicit3d':
          scene.implicits.push({ field: plot.field, grad: plot.grad, color });
          break;
        case 'scalar2d':
        case 'complex2d':
          break; // density/complex fields have no 3D locus; skipped in 3D scenes
        case 'psurface':
          scene.psurfaces.push({ comps: plot.comps, du: plot.du, dv: plot.dv, color });
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
    r3d.render(camera, scene, time);
    drawLabels3D(overlayCtx, camera, dpr);
  } else {
    const curves: Curve2D[] = [];
    const scalars: Curve2D[] = [];
    const complexes: Curve2D[] = [];
    const extras: Overlay2D = { points: [], polylines: [] };
    for (const eq of active) {
      const color = PALETTE[eq.colorIndex];
      const plot = eq.cls!.plot;
      switch (plot.type) {
        case 'implicit2d': curves.push({ field: plot.field, color }); break;
        case 'scalar2d': scalars.push({ field: plot.field, color }); break;
        case 'complex2d': complexes.push({ field: plot.field, color }); break;
        case 'pcurve': extras.polylines.push({ pts: sampleCurve(eq, 2), color: cssColor(color) }); break;
        case 'point': {
          const p = samplePoint(eq);
          if (p) extras.points.push({ x: p[0], y: p[1], color: cssColor(color) });
          break;
        }
      }
    }
    r2d.render(view, curves, scalars, complexes, time);
    drawLabels2D(overlayCtx, view, dpr, extras);
  }

  if (active.some(e => e.cls!.animated)) requestRender();
}

// --- equation list UI ---

const listEl = document.getElementById('equations')!;

function compile(eq: Equation) {
  eq.cls = undefined;
  eq.error = undefined;
  const text = eq.text.trim();
  if (!text) return;
  try {
    eq.cls = classify(parseExpr(text));
  } catch (e) {
    eq.error = e instanceof Error ? e.message : String(e);
  }
}

function saveHash() {
  const texts = equations.map(e => e.text).filter(t => t.trim());
  history.replaceState(null, '', texts.length ? '#' + texts.map(encodeURIComponent).join(';') : '#');
}

function addEquation(text: string): Equation {
  const eq: Equation = { id: nextId++, text, colorIndex: (nextId - 2) % PALETTE.length };
  equations.push(eq);
  compile(eq);
  return eq;
}

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
    const showError = () => {
      input.classList.toggle('invalid', !!eq.error);
      input.title = eq.error ?? '';
      errorEl.textContent = eq.error ?? '';
      errorEl.style.display = eq.error ? 'block' : 'none';
    };
    input.addEventListener('input', () => {
      const wasLast = equations[equations.length - 1] === eq;
      eq.text = input.value;
      compile(eq);
      showError();
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
    showError();

    const remove = document.createElement('button');
    remove.className = 'eq-remove';
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.addEventListener('click', () => {
      equations.splice(equations.indexOf(eq), 1);
      if (!equations.length || equations[equations.length - 1].text.trim()) addEquation('');
      saveHash();
      rebuildList();
      requestRender();
    });

    const col = document.createElement('div');
    col.className = 'eq-col';
    col.append(input, errorEl);
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
  let eq = equations[equations.length - 1];
  if (!eq || eq.text.trim()) eq = addEquation('');
  eq.text = text;
  compile(eq);
  addEquation('');
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

// Initial 2D scale: ~12 math units across the short screen edge.
view.upp = 12 / (Math.min(window.innerWidth, window.innerHeight) * (window.devicePixelRatio || 1));

rebuildList();
buildExamplesMenu();
resize();
