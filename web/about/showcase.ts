/**
 * The curated gallery shown on /about/, shared with scripts/screenshots.ts so
 * every image on the page is rendered by the app itself and clicking a card
 * opens exactly what the screenshot shows.
 */

export interface ShowcaseItem {
  /** Filename stem for the rendered screenshot in web/public/shots/. */
  slug: string;
  title: string;
  blurb: string;
  /** Equation rows, in the same form the URL hash and the input rows use. */
  eqs: string[];
  group: string;
  /** Seconds to let `t` advance before capturing (animated scenes). */
  settle?: number;
  /**
   * Canvas clicks (viewport-fraction coordinates) made before capturing —
   * used to drop integral-curve seeds on vector fields / ODEs. The card's
   * link still opens just the equations; visitors click to trace their own.
   */
  clicks?: Array<[number, number]>;
}

/** The app URL that loads these equations (the same format saveHash writes). */
export function hashUrl(eqs: string[]): string {
  return '/#' + eqs.map(encodeURIComponent).join(';');
}

/** Full-app screenshot at the top of the page, panel included. */
export const HERO: ShowcaseItem = {
  slug: 'hero',
  title: 'Equation.io',
  blurb: 'Type an equation. See it instantly.',
  eqs: ['x^2 + y^2 = 4', 'y = sin(x - 2t)', '-1 <= y - x/2 < 1'],
  group: 'hero',
  settle: 1.1,
};

export const SHOWCASE: ShowcaseItem[] = [
  {
    slug: 'lemniscate',
    title: 'Any implicit curve',
    blurb: 'No solving for y — write the equation as-is and it plots.',
    eqs: ['(x^2+y^2)^2 = 8(x^2-y^2)'],
    group: 'Curves & regions',
  },
  {
    slug: 'moire',
    title: 'However tangled',
    blurb: 'Equations compile to shaders, so even wild loci stay smooth.',
    eqs: ['sin(x^2 + y^2) = cos(x y)'],
    group: 'Curves & regions',
  },
  {
    slug: 'annulus',
    title: 'Inequalities shade regions',
    blurb: 'Chained comparisons carve out exactly the region you wrote.',
    eqs: ['4 <= x^2 + y^2 <= 9', 'y > x'],
    group: 'Curves & regions',
  },
  {
    slug: 'wave-band',
    title: 'Regions follow curves',
    blurb: 'Strict edges dash, inclusive edges stay solid.',
    eqs: ['-1 <= y - sin(x) < 1'],
    group: 'Curves & regions',
  },
  {
    slug: 'ripples',
    title: 'Scalar fields as height maps',
    blurb: 'A bare expression in x and y renders as a shaded field — with t, it moves.',
    eqs: ['sin(x^2 + y^2 - 4t)/2'],
    group: 'Fields & complex maps',
    settle: 1.3,
  },
  {
    slug: 'flow-cylinder',
    title: 'Complex functions, domain-colored',
    blurb: 'Write f(w) and watch streamlines and equipotentials appear.',
    eqs: ['w + 4/w'],
    group: 'Fields & complex maps',
  },
  {
    slug: 'quadrupole',
    title: 'Fields with structure',
    blurb: 'A quadrupole from four logarithms.',
    eqs: ['ln(w-2) + ln(w+2) - ln(w-2i) - ln(w+2i)'],
    group: 'Fields & complex maps',
  },
  {
    slug: 'orbiting-charge',
    title: 'Live physics',
    blurb: 'Definitions can depend on time — the whole field follows.',
    eqs: ['r = 2 + sin(t)', 'ln(w - r) - ln(w + r)'],
    group: 'Fields & complex maps',
    settle: 0.9,
  },
  {
    slug: 'pendulum-phase',
    title: 'ODEs and phase portraits',
    blurb: "Write (x′, y′) = (P, Q) and the flow appears — click to trace an orbit.",
    eqs: ["(x', y') = (y, -sin(x))"],
    group: 'Vector fields & ODEs',
    settle: 0.8,
    clicks: [[0.55, 0.40], [0.50, 0.14]],
  },
  {
    slug: 'slope-field',
    title: 'Slope fields from dy/dx',
    blurb: 'An equation in dy/dx or y′ paints its direction field; clicked solutions follow it.',
    eqs: ["y' = x - y"],
    group: 'Vector fields & ODEs',
    settle: 0.8,
    clicks: [[0.42, 0.25], [0.56, 0.78]],
  },
  {
    slug: 'vector-swirl',
    title: 'Vector fields as flow',
    blurb: 'A tuple in x and y is a vector field, rendered as animated streamlines.',
    eqs: ['(sin(y), sin(x))'],
    group: 'Vector fields & ODEs',
    settle: 0.8,
  },
  {
    slug: 'cardioid-polar',
    title: 'Define your own coordinates',
    blurb: 'Declare r and θ, and the grid itself becomes polar.',
    eqs: ['r = sqrt(x^2 + y^2)', 'theta = atan2(y, x)', 'r = 2(1 + cos(theta))'],
    group: 'Coordinate systems',
  },
  {
    slug: 'log-polar',
    title: 'Any chart you like',
    blurb: 'Log-polar, hyperbolic, or anything you can write down.',
    eqs: ['rho = ln(x^2 + y^2)/2', 'theta = atan2(y, x)'],
    group: 'Coordinate systems',
  },
  {
    slug: 'hyperbolic-grid',
    title: 'Grids from level sets',
    blurb: 'The gridlines are the level curves of your coordinate functions.',
    eqs: ['p = x y', 'q = (x^2 - y^2)/2'],
    group: 'Coordinate systems',
  },
  {
    slug: 'tangent-line',
    title: 'Calculus built in',
    blurb: 'd/dx is symbolic — drag the slider for a to slide the tangent point.',
    eqs: ['f(x) = x^3 - 2x', 'g(x) = d/dx f(x)', 'a = 1', 'y = f(x)', 'y = f(a) + g(a)(x - a)'],
    group: 'Calculus & sliders',
  },
  {
    slug: 'fourier-series',
    title: 'Sums and series',
    blurb: 'Σ expands symbolically before compiling — drag N to add harmonics.',
    eqs: ['N = 8', 'y = 2 sum[n=1..N] (-1)^(n+1) sin(n x)/n'],
    group: 'Calculus & sliders',
  },
  {
    slug: 'lissajous',
    title: 'Parametric motion',
    blurb: 'Curves in u, moving points in t — on the same axes.',
    eqs: ['(2cos(2pi u), sin(4pi u))', '(2cos(t), sin(2t))'],
    group: 'Calculus & sliders',
    settle: 2.6,
  },
  {
    slug: 'blob',
    title: 'Implicit surfaces in 3D',
    blurb: 'Add a z and the same equation ray-marches on the GPU.',
    eqs: ['x^2 + y^2 + z^2 + sin(2x)sin(2y)sin(2z) = 4'],
    group: 'The third dimension',
  },
  {
    slug: 'torus',
    title: 'Parametric surfaces',
    blurb: 'Three components in u and v make a surface.',
    eqs: ['(cos(2pi u)(2+cos(2pi v)), sin(2pi u)(2+cos(2pi v)), sin(2pi v))'],
    group: 'The third dimension',
  },
  {
    slug: 'sphere-helix',
    title: 'Mix and match',
    blurb: 'Surfaces, curves and points share one scene.',
    eqs: ['x^2 + y^2 + z^2 = 4', '(2cos(6pi u), 2sin(6pi u), 4u - 2)'],
    group: 'The third dimension',
  },
];
