# equation

An equation grapher, deployed as a Cloudflare Worker.

- `lib/` — tokenizer, shunting-yard parser, symbolic expression core (`expr.ts`),
  and a GLSL compiler (`glsl.ts`) used for plotting.
- `web/` — the grapher. Every equation is compiled to a GLSL scalar field F whose
  zero set is the graph:
  - **2D**: fullscreen-quad fragment shader; the curve is drawn where the
    distance estimate |F|/|∇F| is under a pixel, with a two-scale consistency
    test rejecting fake lines at poles/asymptotes (e.g. `y=tan(x)`).
  - **3D** (automatic when `z` appears): raymarched implicit surface —
    sign-change detection along each ray, bisection refinement,
    finite-difference normals, `gl_FragDepth` so multiple surfaces intersect
    correctly. Equations without `z` extrude to their true locus in R³.

The whole graph state lives in the URL fragment (`#eq1;eq2;…`, each equation
percent-encoded), so any set of equations is linkable.
[`web/public/llms.txt`](web/public/llms.txt) (served at `/llms.txt`) documents
the link format and expression syntax for LLMs/agents.

## Usage

```sh
pnpm web        # dev server (grapher + worker API)
pnpm test       # vitest
pnpm typecheck  # lib + web + worker
pnpm web:build  # build to dist-web/ (client + worker)
pnpm deploy     # build and deploy to Cloudflare
```

Try: `y = x^2` · `x^2+y^2=4` · `y = tan(x)` · `z = sin(x)cos(y)` · `x^2+y^2+z^2=9`
· `a = 2` (a named constant with a slider; other equations can use `a`, and it
  compiles to a uniform so dragging never rebuilds a shader; `b = a^2 + t`
  defines a computed/animated constant)
· `y < x/2 + 1` (inequalities shade their region; strict `<`/`>` have no
  border, `<=`/`>=` draw the boundary line, and chains like
  `4 <= x^2 + y^2 <= 9` intersect with an edge per non-strict bound)
· `f(x) = x^3 - a x` (user-defined functions, inlined symbolically)
· `y = d/dx f(x)` / `d^2/dx^2 (x^4)` (symbolic Leibniz derivatives — works for
  any single-letter variable, nests, and flows through function definitions:
  `g(x) = d/dx f(x)` then `y = f(a) + g(a)(x - a)` is a live tangent line)
· `sin(x)cos(y)` (2D scalar/density field) · `(2, 3)` / `(3, 12, 0)` (points)
· `(-y, x)` (a tuple depending on x, y is a vector field, rendered as animated
  streamlines via GPU line-integral convolution; `t` works too: `(cos(t)-y, x)`)
· `dy/dx = x y` / `y' = sin(x) - y` (ODEs plot the slope/direction field
  `(1, f)`; click the canvas to drop an RK4 integral curve through that point,
  double-click to clear) · `(x', y') = (y, -sin(x))` (a system plots its
  phase portrait, with the same click-to-trace trajectories)
· `(2cos(t), 2sin(t))` (t = seconds since load → animated)
· `(2cos(2pi u), 2sin(2pi u), 3u)` (parametric curve, u ∈ (0,1))
· `(cos(2pi u)(2+cos(2pi v)), sin(2pi u)(2+cos(2pi v)), sin(2pi v))`
  (parametric surface, u,v ∈ (0,1) — per-fragment Newton ray/surface
  intersection with a glossy specular material)
· `ln(w-2) - ln(w+2)` (complex analysis: `i` is the imaginary unit and
  `w = x + iy`; a complex-valued expression renders the level curves of its
  imaginary part — field lines — and real part — equipotentials — so complex
  potentials draw electrostatics directly. `re`/`im`/`arg`/`abs`/`conj` bring
  values back to ℝ, e.g. `im(ln(w)) = 1` plots as an ordinary implicit curve).

Equations persist in the URL hash. Drag to pan/orbit, wheel to zoom,
right-drag (or shift) to pan in 3D, click a color dot to cycle colors.

`worker/` — the Cloudflare Worker entry: serves the built app and handles
`/api/*` routes.
