/**
 * 2D graph rendering. Everything is a fullscreen-quad fragment shader:
 * the fragment position is mapped to math coordinates, the equation's field
 * F(x,y) is evaluated per pixel, and the curve F=0 is drawn where the
 * screen-space distance estimate |F| / |∇F| is under the line width.
 */
import { GLSL_PRELUDE } from '../lib/glsl.ts';
import { ProgramCache, QUAD_VERT } from './gl.ts';

export interface View2D {
  cx: number;
  cy: number;
  /** Math units per device pixel. */
  upp: number;
}

export interface Curve2D {
  /** GLSL expression for F(x,y) in terms of floats x, y. */
  field: string;
  color: [number, number, number];
  /** User-defined constants the field references (as u_<name> uniforms). */
  params?: string[];
}

export const paramDecls = (params: string[] = []): string =>
  params.map(p => `uniform float u_${p};`).join('\n');

export interface Ineq2D extends Curve2D {
  /** Fields whose zero sets get a solid boundary line (the <= / >= parts). */
  edges: string[];
}

/** Pick a "nice" grid spacing (1, 2, or 5 × 10^k) at least minPx pixels apart. */
export function niceSpacing(upp: number, minPx: number): { major: number; minor: number } {
  const target = upp * minPx;
  const k = Math.floor(Math.log10(target));
  const base = Math.pow(10, k);
  for (const [m, div] of [[1, 5], [2, 4], [5, 5], [10, 5]] as const) {
    if (m * base >= target) return { major: m * base, minor: (m * base) / div };
  }
  return { major: 10 * base, minor: 2 * base };
}

/** One grid family: level sets of a coordinate field c(x, y). */
export interface GridSpec {
  /** GLSL for c(x, y) (constants as u_<name> uniforms). */
  glsl: string;
  /** GLSL for ∇c in math units; absent → screen derivatives (dFdx/dFdy). */
  gradGlsl?: [string, string];
  params: string[];
  major: number;
  minor: number;
}

/**
 * The grid is itself a field renderer: each family draws the level sets
 * c = k·spacing with width from the distance estimate |c - k·s| / |∇c|,
 * fading out where lines crowd toward subpixel spacing (singularities,
 * extreme zoom). The Cartesian grid is the identity pair (x, y).
 */
function gridFrag(specs: GridSpec[]): string {
  const params = [...new Set(specs.flatMap(s => s.params))];
  const decls = specs.map((s, k) => {
    const grad = s.gradGlsl
      ? `vec2 grad${k}(float x, float y) { return vec2(${s.gradGlsl[0]}, ${s.gradGlsl[1]}); }\n`
      : '';
    return `float coord${k}(float x, float y) { return ${s.glsl}; }\n${grad}`
      + `uniform float uMajor${k};\nuniform float uMinor${k};\n`;
  }).join('');
  const blocks = specs.map((s, k) => `
  {
    float c = coord${k}(p.x, p.y);
    if (!isnan(c) && !isinf(c)) {
      float lg = ${s.gradGlsl ? `length(grad${k}(p.x, p.y)) * uUpp` : 'length(vec2(dFdx(c), dFdy(c)))'};
      minorA = max(minorA, gridLine(c, lg, uMinor${k}, 0.5));
      majorA = max(majorA, gridLine(c, lg, uMajor${k}, 0.5));
      axisA = max(axisA, 1.0 - smoothstep(0.9, 1.9, abs(c) / max(lg, 1e-24)));
    }
  }`).join('');
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform float uUpp;
uniform vec2 uRes;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
${decls}
float gridLine(float c, float lg, float spacing, float halfWidthPx) {
  float lgv = max(lg / spacing, 1e-24);  // |∇(c/spacing)| per pixel
  float v = c / spacing;
  float distPx = abs(v - round(v)) / lgv;
  float a = 1.0 - smoothstep(halfWidthPx, halfWidthPx + 1.0, distPx);
  return a * clamp((0.35 - lgv) / 0.25, 0.0, 1.0);
}
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - 0.5 * uRes) * uUpp;
  vec3 col = vec3(1.0);
  float minorA = 0.0;
  float majorA = 0.0;
  float axisA = 0.0;
${blocks}
  col = mix(col, vec3(0.91), minorA);
  col = mix(col, vec3(0.80), majorA);
  col = mix(col, vec3(0.25), axisA);
  outColor = vec4(col, 1.0);
}
`;
}

function curveFrag(field: string, params?: string[]): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform float uUpp;
uniform vec2 uRes;
uniform vec3 uColor;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
float F(float x, float y) { return ${field}; }
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - 0.5 * uRes) * uUpp;
  float v = F(p.x, p.y);
  if (isnan(v) || isinf(v)) discard;

  // Distance estimate |F| / |grad F| in pixels, from central differences at
  // two step sizes. For a genuine zero crossing the two estimates agree; near
  // a pole (y=tan(x) asymptotes, y=1/x at x=0) the first-order estimate is a
  // lie that varies with step size, so disagreement rejects the fake line.
  float h = uUpp;
  vec2 g1 = vec2(F(p.x + h, p.y) - F(p.x - h, p.y),
                 F(p.x, p.y + h) - F(p.x, p.y - h)) / (2.0 * h);
  vec2 g2 = vec2(F(p.x + 0.5 * h, p.y) - F(p.x - 0.5 * h, p.y),
                 F(p.x, p.y + 0.5 * h) - F(p.x, p.y - 0.5 * h)) / h;
  float e1 = abs(v) / max(length(g1) * h, 1e-24);
  float e2 = abs(v) / max(length(g2) * h, 1e-24);

  float distPx;
  if (isnan(e1) || isinf(e1) || isnan(e2) || isinf(e2)) {
    // Domain edges (sqrt, log): fall back to screen-space derivatives.
    float va = atan(v);
    vec2 g = vec2(dFdx(va), dFdy(va));
    distPx = abs(va) / max(length(g), 1e-24);
  } else {
    if (e2 > 1.6 * e1 || e1 > 1.6 * e2) discard;
    distPx = max(e1, e2);
  }

  float alpha = 1.0 - smoothstep(1.1, 2.1, distPx);
  if (alpha <= 0.0) discard;
  outColor = vec4(uColor, alpha);
}
`;
}

function scalarFrag(field: string, params?: string[]): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform float uUpp;
uniform vec2 uRes;
uniform vec3 uColor;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
float F(float x, float y) { return ${field}; }
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - 0.5 * uRes) * uUpp;
  float v = F(p.x, p.y);
  if (isnan(v) || isinf(v)) discard;
  // Density map: positive values fade the color in, like the old scalar2.
  float a = 0.62 * clamp(v, 0.0, 1.0);
  if (a < 0.004) discard;
  outColor = vec4(uColor, a);
}
`;
}

function complexFrag(field: string, params?: string[]): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform float uUpp;
uniform vec2 uRes;
uniform vec3 uColor;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
vec2 F(float x, float y) { return ${field}; }

// Contour lines of val at multiples of S, antialiased via screen derivatives.
// Spacing 2pi/16 divides the 2pi jump of ln branch cuts exactly, so cuts of
// complex potentials never show as spurious lines.
float contour(float val, float S) {
  float v = val / S;
  vec2 g = vec2(dFdx(v), dFdy(v));
  float lg = length(g);
  float d = abs(v - round(v)) / max(lg, 1e-12);
  float a = 1.0 - smoothstep(0.7, 1.8, d);
  // Fade before contours become subpixel-dense (near singularities).
  a *= clamp((0.4 - lg) / 0.15, 0.0, 1.0);
  return a;
}

void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - 0.5 * uRes) * uUpp;
  vec2 f = F(p.x, p.y);
  if (any(isnan(f)) || any(isinf(f))) discard;
  const float S = ${(Math.PI / 8).toFixed(8)};
  float fieldLines = contour(f.y, S);   // im = field lines
  float equipot = contour(f.x, S);      // re = equipotentials
  float a = max(fieldLines, equipot * 0.65);
  if (a < 0.01) discard;
  outColor = vec4(uColor, a);
}
`;
}

function ineqFrag(field: string, edges: string[], params?: string[]): string {
  // Each non-strict comparison draws its boundary with the same two-scale
  // distance estimate as curveFrag, gated to the region's edge so a chain's
  // bound lines stop where the other comparisons cut them off.
  const edgeBlocks = edges.map((_, i) => `
  {
    float ev = E${i}(p.x, p.y);
    if (!isnan(ev) && !isinf(ev) && v < 2.5 * aa) {
      vec2 g1 = vec2(E${i}(p.x + h, p.y) - E${i}(p.x - h, p.y),
                     E${i}(p.x, p.y + h) - E${i}(p.x, p.y - h)) / (2.0 * h);
      vec2 g2 = vec2(E${i}(p.x + 0.5 * h, p.y) - E${i}(p.x - 0.5 * h, p.y),
                     E${i}(p.x, p.y + 0.5 * h) - E${i}(p.x, p.y - 0.5 * h)) / h;
      float e1 = abs(ev) / max(length(g1) * h, 1e-24);
      float e2 = abs(ev) / max(length(g2) * h, 1e-24);
      if (!(isnan(e1) || isinf(e1) || isnan(e2) || isinf(e2))
        && !(e2 > 1.6 * e1 || e1 > 1.6 * e2)) {
        edge = max(edge, 1.0 - smoothstep(1.1, 2.1, max(e1, e2)));
      }
    }
  }`).join('');
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform float uUpp;
uniform vec2 uRes;
uniform vec3 uColor;
uniform float t;
${paramDecls(params)}
out vec4 outColor;
${GLSL_PRELUDE}
float F(float x, float y) { return ${field}; }
${edges.map((e, i) => `float E${i}(float x, float y) { return ${e}; }`).join('\n')}
void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - 0.5 * uRes) * uUpp;
  float v = F(p.x, p.y);
  if (isnan(v) || isinf(v)) discard;
  float aa = max(fwidth(v), 1e-24);
  float fill = (1.0 - smoothstep(-aa, aa, v)) * 0.22;
  float edge = 0.0;
  float h = uUpp;
${edgeBlocks}
  float alpha = max(fill, edge * 0.9);
  if (alpha < 0.004) discard;
  outColor = vec4(uColor, alpha);
}
`;
}

export class Renderer2D {
  private cache: ProgramCache;
  constructor(private gl: WebGL2RenderingContext, private quad: { draw(): void }) {
    this.cache = new ProgramCache(gl);
  }

  render(
    view: View2D,
    curves: Curve2D[],
    scalars: Curve2D[] = [],
    complexes: Curve2D[] = [],
    ineqs: Ineq2D[] = [],
    time = 0,
    env: Record<string, number> = {},
    gridSpecs?: GridSpec[],
  ): void {
    const { gl } = this;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    let specs = gridSpecs;
    if (!specs?.length) {
      const spacing = niceSpacing(view.upp, 90);
      specs = [
        { glsl: 'x', gradGlsl: ['1.0', '0.0'], params: [], major: spacing.major, minor: spacing.minor },
        { glsl: 'y', gradGlsl: ['0.0', '1.0'], params: [], major: spacing.major, minor: spacing.minor },
      ];
    }
    try {
      const grid = this.cache.get(QUAD_VERT, gridFrag(specs));
      gl.useProgram(grid);
      gl.uniform2f(gl.getUniformLocation(grid, 'uCenter'), view.cx, view.cy);
      gl.uniform1f(gl.getUniformLocation(grid, 'uUpp'), view.upp);
      gl.uniform2f(gl.getUniformLocation(grid, 'uRes'), w, h);
      const tLoc = gl.getUniformLocation(grid, 't');
      if (tLoc) gl.uniform1f(tLoc, time);
      specs.forEach((s, k) => {
        gl.uniform1f(gl.getUniformLocation(grid, `uMajor${k}`), s.major);
        gl.uniform1f(gl.getUniformLocation(grid, `uMinor${k}`), s.minor);
        for (const p of s.params) {
          const loc = gl.getUniformLocation(grid, 'u_' + p);
          if (loc) gl.uniform1f(loc, env[p] ?? 0);
        }
      });
      this.quad.draw();
    } catch (e) {
      console.error(e);
    }

    const drawField = (item: Curve2D, frag: (f: string, params?: string[]) => string) => {
      let prog: WebGLProgram;
      try {
        prog = this.cache.get(QUAD_VERT, frag(item.field, item.params));
      } catch (e) {
        console.error(e);
        return;
      }
      gl.useProgram(prog);
      gl.uniform2f(gl.getUniformLocation(prog, 'uCenter'), view.cx, view.cy);
      gl.uniform1f(gl.getUniformLocation(prog, 'uUpp'), view.upp);
      gl.uniform2f(gl.getUniformLocation(prog, 'uRes'), w, h);
      gl.uniform3f(gl.getUniformLocation(prog, 'uColor'), ...item.color);
      const tLoc = gl.getUniformLocation(prog, 't');
      if (tLoc) gl.uniform1f(tLoc, time);
      for (const p of item.params ?? []) {
        const loc = gl.getUniformLocation(prog, 'u_' + p);
        if (loc) gl.uniform1f(loc, env[p] ?? 0);
      }
      this.quad.draw();
    };

    for (const q of ineqs) drawField(q, (f, ps) => ineqFrag(f, q.edges, ps));
    for (const s of scalars) drawField(s, scalarFrag);
    for (const c of complexes) drawField(c, complexFrag);
    for (const c of curves) drawField(c, curveFrag);
  }
}

export interface Overlay2D {
  points: Array<{ x: number; y: number; color: string }>;
  polylines: Array<{ pts: number[]; color: string }>;
}

/** Axis labels plus CPU-sampled geometry (points, parametric curves).
 *  numbers=false skips the axis numerals (custom coordinate grids have no
 *  straight axes to label them along). */
export function drawLabels2D(ctx: CanvasRenderingContext2D, view: View2D, dpr: number, extras?: Overlay2D, numbers = true): void {
  const w = ctx.canvas.width / dpr;
  const h = ctx.canvas.height / dpr;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px ui-sans-serif, system-ui';
  ctx.fillStyle = '#555';

  const upp = view.upp * dpr; // math units per CSS pixel
  const { major } = niceSpacing(view.upp, 90);
  const toScreenX = (x: number) => (x - view.cx) / upp + w / 2;
  const toScreenY = (y: number) => h / 2 - (y - view.cy) / upp;

  const fmt = (v: number) => {
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e5 || a < 1e-4) return v.toExponential(0).replace('e+', 'e');
    return String(parseFloat(v.toPrecision(10)));
  };

  if (numbers) {
    const axisY = Math.min(Math.max(toScreenY(0), 12), h - 6);
    const axisX = Math.min(Math.max(toScreenX(0), 4), w - 30);

    const x0 = Math.ceil((view.cx - (w / 2) * upp) / major) * major;
    const x1 = view.cx + (w / 2) * upp;
    for (let x = x0; x <= x1; x += major) {
      if (Math.abs(x) < major / 2) continue;
      ctx.fillText(fmt(x), toScreenX(x) + 2, axisY + 13 <= h ? axisY + 13 : axisY - 4);
    }
    const y0 = Math.ceil((view.cy - (h / 2) * upp) / major) * major;
    const y1 = view.cy + (h / 2) * upp;
    for (let y = y0; y <= y1; y += major) {
      if (Math.abs(y) < major / 2) continue;
      ctx.fillText(fmt(y), axisX + 4, toScreenY(y) - 3);
    }
  }

  if (extras) {
    for (const line of extras.polylines) {
      ctx.strokeStyle = line.color;
      ctx.lineWidth = 2.25;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i + 1 < line.pts.length; i += 2) {
        const sx = toScreenX(line.pts[i]);
        const sy = toScreenY(line.pts[i + 1]);
        if (!isFinite(sx) || !isFinite(sy)) { pen = false; continue; }
        if (pen) ctx.lineTo(sx, sy);
        else { ctx.moveTo(sx, sy); pen = true; }
      }
      ctx.stroke();
    }
    for (const pt of extras.points) {
      const sx = toScreenX(pt.x);
      const sy = toScreenY(pt.y);
      if (!isFinite(sx) || !isFinite(sy)) continue;
      ctx.beginPath();
      ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.fillStyle = pt.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
  }
  ctx.restore();
}
