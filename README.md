# equation

A CAS and equation grapher.

- `lib/` — the CAS core: tokenizer, shunting-yard parser, multiset-based evaluator
  (`syntax.ts`/`ops.ts`), plus a symbolic expression path (`expr.ts`) and a
  GLSL compiler (`glsl.ts`) used for plotting.
- `web/` — the grapher. Every equation is compiled to a GLSL scalar field F whose
  zero set is the graph:
  - **2D**: fullscreen-quad fragment shader; the curve is drawn where the
    distance estimate |F|/|∇F| is under a pixel, with a two-scale consistency
    test rejecting fake lines at poles/asymptotes (e.g. `y=tan(x)`).
  - **3D** (automatic when `z` appears): raymarched implicit surface —
    sign-change detection along each ray, bisection refinement,
    finite-difference normals, `gl_FragDepth` so multiple surfaces intersect
    correctly. Equations without `z` extrude to their true locus in R³.

## Usage

```sh
pnpm web        # dev server (grapher)
pnpm dev        # CAS REPL
pnpm test       # vitest
pnpm typecheck  # lib + web
pnpm web:build  # static build to dist-web/
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

## Notes (multiset representation)

How can x^2^32 (i.e. x^4294967296) be stored?

[4294967296[1]]

### x^10000
[[1]]^10000 = [10000[1]]

base=[[1]]
exponent=10000

res = Times(multiplyPair(exponent, Singleton(base)))

2^32=4294967296

(x+y)^32
