/**
 * 2D graph rendering. Everything is a fullscreen-quad fragment shader:
 * the fragment position is mapped to math coordinates, the equation's field
 * F(x,y) is evaluated per pixel, and the curve F=0 is drawn where the
 * screen-space distance estimate |F| / |∇F| is under the line width.
 */
import { GLSL_PRELUDE } from '../lib/glsl.js';
import { ProgramCache, QUAD_VERT } from './gl.js';

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

const GRID_FRAG = `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform float uUpp;
uniform vec2 uRes;
uniform float uMajor;
uniform float uMinor;
out vec4 outColor;

float lineAlpha(float coord, float spacing, float halfWidthPx) {
  float distPx = abs(coord - spacing * round(coord / spacing)) / uUpp;
  return 1.0 - smoothstep(halfWidthPx, halfWidthPx + 1.0, distPx);
}

void main() {
  vec2 p = uCenter + (gl_FragCoord.xy - 0.5 * uRes) * uUpp;
  vec3 col = vec3(1.0);
  float minor = max(lineAlpha(p.x, uMinor, 0.5), lineAlpha(p.y, uMinor, 0.5));
  float major = max(lineAlpha(p.x, uMajor, 0.5), lineAlpha(p.y, uMajor, 0.5));
  col = mix(col, vec3(0.91), minor);
  col = mix(col, vec3(0.80), major);
  float axis = max(
    (1.0 - smoothstep(0.9, 1.9, abs(p.x) / uUpp)),
    (1.0 - smoothstep(0.9, 1.9, abs(p.y) / uUpp)));
  col = mix(col, vec3(0.25), axis);
  outColor = vec4(col, 1.0);
}
`;

function curveFrag(field: string): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform float uUpp;
uniform vec2 uRes;
uniform vec3 uColor;
uniform float t;
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

function scalarFrag(field: string): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform float uUpp;
uniform vec2 uRes;
uniform vec3 uColor;
uniform float t;
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

function complexFrag(field: string): string {
  return `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform float uUpp;
uniform vec2 uRes;
uniform vec3 uColor;
uniform float t;
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

export class Renderer2D {
  private cache: ProgramCache;
  constructor(private gl: WebGL2RenderingContext, private quad: { draw(): void }) {
    this.cache = new ProgramCache(gl);
  }

  render(view: View2D, curves: Curve2D[], scalars: Curve2D[] = [], complexes: Curve2D[] = [], time = 0): void {
    const { gl } = this;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const spacing = niceSpacing(view.upp, 90);

    const grid = this.cache.get(QUAD_VERT, GRID_FRAG);
    gl.useProgram(grid);
    gl.uniform2f(gl.getUniformLocation(grid, 'uCenter'), view.cx, view.cy);
    gl.uniform1f(gl.getUniformLocation(grid, 'uUpp'), view.upp);
    gl.uniform2f(gl.getUniformLocation(grid, 'uRes'), w, h);
    gl.uniform1f(gl.getUniformLocation(grid, 'uMajor'), spacing.major);
    gl.uniform1f(gl.getUniformLocation(grid, 'uMinor'), spacing.minor);
    this.quad.draw();

    const drawField = (field: string, color: [number, number, number], frag: (f: string) => string) => {
      let prog: WebGLProgram;
      try {
        prog = this.cache.get(QUAD_VERT, frag(field));
      } catch (e) {
        console.error(e);
        return;
      }
      gl.useProgram(prog);
      gl.uniform2f(gl.getUniformLocation(prog, 'uCenter'), view.cx, view.cy);
      gl.uniform1f(gl.getUniformLocation(prog, 'uUpp'), view.upp);
      gl.uniform2f(gl.getUniformLocation(prog, 'uRes'), w, h);
      gl.uniform3f(gl.getUniformLocation(prog, 'uColor'), ...color);
      const tLoc = gl.getUniformLocation(prog, 't');
      if (tLoc) gl.uniform1f(tLoc, time);
      this.quad.draw();
    };

    for (const s of scalars) drawField(s.field, s.color, scalarFrag);
    for (const c of complexes) drawField(c.field, c.color, complexFrag);
    for (const c of curves) drawField(c.field, c.color, curveFrag);
  }
}

export interface Overlay2D {
  points: Array<{ x: number; y: number; color: string }>;
  polylines: Array<{ pts: number[]; color: string }>;
}

/** Axis labels plus CPU-sampled geometry (points, parametric curves). */
export function drawLabels2D(ctx: CanvasRenderingContext2D, view: View2D, dpr: number, extras?: Overlay2D): void {
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
