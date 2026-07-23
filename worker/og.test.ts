import { describe, expect, it } from 'vitest';
import { OG_HEIGHT, OG_WIDTH, encodePng, renderRaster } from './og.ts';

/** Fraction of pixels in a raster that differ from the white background. */
function inkFraction(r: { w: number; h: number; px: Uint8ClampedArray }): number {
  let ink = 0;
  for (let i = 0; i < r.px.length; i += 3) {
    if (r.px[i] < 250 || r.px[i + 1] < 250 || r.px[i + 2] < 250) ink++;
  }
  return ink / (r.w * r.h);
}

function pixel(r: { w: number; px: Uint8ClampedArray }, x: number, y: number) {
  const i = (y * r.w + x) * 3;
  return [r.px[i], r.px[i + 1], r.px[i + 2]];
}

describe('og raster renderer', () => {
  it('draws an implicit curve where expected', () => {
    const r = renderRaster(['y = x'], 100, 100);
    // y = x passes through the center; screen y grows downward so the curve
    // crosses (50, 50) and heads to the upper right.
    const [red, green, blue] = pixel(r, 50, 50);
    expect(red).toBeLessThan(200);
    expect(blue).toBeGreaterThan(red); // first palette color is blue
    expect(green).toBeLessThan(blue);
    // Far off the curve stays background/grid (near white).
    expect(pixel(r, 80, 80)[0]).toBeGreaterThan(200);
  });

  it('fills regions for inequalities, including chains', () => {
    const grid = inkFraction(renderRaster([], 100, 100));
    const disc = inkFraction(renderRaster(['x^2 + y^2 <= 25'], 100, 100));
    expect(disc).toBeGreaterThan(grid + 0.1);
    const annulus = renderRaster(['9 <= x^2 + y^2 <= 25'], 100, 100);
    // Near the center (off the axis gridlines) is outside the annulus.
    const [cr, cg, cb] = pixel(annulus, 53, 53);
    expect(Math.min(cr, cg, cb)).toBeGreaterThan(230);
  });

  it('renders definitions + slider constants (tangent-line graph)', () => {
    const rows = ['f(x) = x^2 - 2x', 'g(x) = d/dx f(x)', 'a = 3', 'y = f(x)', 'y = f(a) + g(a)(x - a)'];
    expect(inkFraction(renderRaster(rows, 120, 120))).toBeGreaterThan(0.02);
  });

  it('renders 3D rows as wireframes without throwing', () => {
    const torus = ['(cos(2pi u)(2+cos(2pi v)), sin(2pi u)(2+cos(2pi v)), sin(2pi v))'];
    expect(inkFraction(renderRaster(torus, 120, 120))).toBeGreaterThan(0.03);
    const height = renderRaster(['z = sin(x)cos(y)'], 120, 120);
    expect(inkFraction(height)).toBeGreaterThan(0.03);
  });

  it('grows the shared eval stack for deep expressions', () => {
    // y = 0+(0+(...x...)) needs stack depth > the initial 64; a dropped or
    // clipped stack would render garbage instead of the y = x diagonal.
    const deep = 'y = ' + '0+('.repeat(80) + 'x' + ')'.repeat(80);
    const r = renderRaster([deep], 100, 100);
    expect(pixel(r, 50, 50)[0]).toBeLessThan(200);
    expect(pixel(r, 80, 80)[0]).toBeGreaterThan(200);
  });

  it('survives invalid rows and renders the rest', () => {
    const r = renderRaster(['y = florb(x)', 'y = x'], 100, 100);
    expect(pixel(r, 50, 50)[0]).toBeLessThan(220);
  });

  it('frames 2D plots through a view(...) row', () => {
    // A parabola living near x = 100: invisible in the default ±6 window,
    // fully in frame once the row asks for it. Grid and axes are gray, so
    // only curve pixels count — total ink would be swamped by gridlines.
    const colored = (r: { w: number; h: number; px: Uint8ClampedArray }) => {
      let n = 0;
      for (let i = 0; i < r.px.length; i += 3) {
        if (Math.abs(r.px[i] - r.px[i + 1]) > 25) n++;
      }
      return n / (r.w * r.h);
    };
    const rows = ['y = (x - 100)^2'];
    expect(colored(renderRaster(rows, 100, 100))).toBeLessThan(0.002);
    expect(colored(renderRaster(['view(x = 98..102, y = 0..4)', ...rows], 100, 100))).toBeGreaterThan(0.01);
  });

  it('drops the unit grid when a view row zooms far out, keeping the axes', () => {
    const r = renderRaster(['view(x = -100000..100000)', 'y = x'], 100, 100);
    // One vertical axis + one horizontal axis + the diagonal — not a line per
    // unit, which would paint every column of the raster.
    expect(inkFraction(r)).toBeLessThan(0.2);
    expect(pixel(r, 50, 50)[0]).toBeLessThan(220); // the curve still shows
  });

  it('aims the 3D wireframe through a camera(...) row', () => {
    const rows = ['z = x^2 - y^2'];
    const def = renderRaster(rows, 120, 120);
    const aimed = renderRaster(['camera(0.8, 0.9, 7)', ...rows], 120, 120);
    expect(inkFraction(aimed)).toBeGreaterThan(0.02);
    expect(aimed.px).not.toEqual(def.px); // the camera actually moved
    const shifted = renderRaster(['camera(0.8, 0.9, 7, (0, 0, 20))', ...rows], 120, 120);
    // Target 20 units up: the surface (and grid) leave the frame almost fully.
    expect(inkFraction(shifted)).toBeLessThan(inkFraction(aimed) / 2);
  });

  it('encodes a spec-shaped PNG', async () => {
    const png = await encodePng(renderRaster(['y = sin(x)'], OG_WIDTH, OG_HEIGHT));
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(png.buffer, png.byteOffset);
    expect(dv.getUint32(16)).toBe(OG_WIDTH); // IHDR width
    expect(dv.getUint32(20)).toBe(OG_HEIGHT); // IHDR height
    expect(new TextDecoder().decode(png.slice(png.length - 8, png.length - 4))).toBe('IEND');
  });
});
