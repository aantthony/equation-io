# Mathematical objects: what renders as what

A design survey and plan. It fixes the principle that decides how a row of
notation becomes a rendered object, inventories the objects we have against
what comparable tools (Desmos, Wolfram|Alpha) render, and designs the largest
missing piece: positional objects — points, parametric curves, flows — inside
user-defined coordinate systems. Behavior claims about the current code were
verified against `classify()` as of this writing.

## 1. The principle

A row's meaning comes from its notation alone: **value type × free variables ×
top-level shape**. There are no modes, no per-row type pickers, and no hidden
state that changes what an expression denotes. Widgets (sliders, combs, "all
levels") may *style* an object or bind a constant, but never change its kind.
Everything unsupported fails loudly on its own row, never silently.

From that principle, the invariants the classifier implements (and every new
object must respect):

1. **An equation denotes its solution set; an inequality its region.** The
   solution set's dimension is ambient minus constraints, and the renderer
   follows the dimension: in 2D, one constraint → curve; in 3D, one → surface.
   (This invariant is currently truncated at one constraint; §5 extends it —
   two constraints in 2D → a point set.)
2. **A tuple is positional.** With k parametric variables (u, v) it is a
   k-dimensional parametric object: 0 → point, 1 → curve, 2 → surface. As a
   function of position (x, y) it is a vector field.
3. **`t` animates; it never changes kind.** Constants (sliders) never change
   kind either — they compile to uniforms precisely so dragging can't
   reclassify or recompile.
4. **A defined name used where a scalar fits means substitution.** Functions
   inline symbolically; coordinate fields compose with position, so
   `r = 1 + cos(theta)` *is* `sqrt(x²+y²) = 1 + cos(atan2(y,x))`.
5. **Complex is a value type, not a mode.** `i`/`w` make a subtree complex;
   `re`/`im`/`arg`/`abs` bring it back to ℝ and the result flows through the
   real paths.

## 2. Inventory: the objects we render today

| Notation (after resolution) | Object | Renderer |
|---|---|---|
| equation in x, y (incl. `y = f(x)`, field names) | implicit curve | 2D distance-estimate shader |
| `f(x,y) = c`, c a slider (+ "all levels") | level-set family | contour-stack shader |
| inequality / chain in x, y | region (+ solid edges) | fill shader |
| bare scalar in x only | graph `y = expr` | implicit curve |
| bare scalar in x, y | scalar field | density shader |
| equation/bare scalar with z | implicit surface | raymarcher |
| complex-valued expr in w | field lines + equipotentials | level-curve shader |
| `domain(f)` / `conformal(f)` / `iter(step)` | domain coloring / conformal grid / escape-time fractal | dedicated shaders |
| tuple, no free vars (t ok) | point (2D/3D) | overlay dot / billboard |
| tuple in u (`tube(…)` opt-in) | parametric curve | polyline / tube + κ/τ combs |
| 3-tuple in u, v | parametric surface | Newton raymarcher |
| 2-tuple in x, y; `dy/dx =`, `y' =`, `(x', y') =` | vector field / slope field / phase portrait | LIC + click-to-trace RK4 |
| `a = 2`, `b = a² + t` | constant (slider / computed) | widget; uniform |
| `f(x) = …` | function | inlined |
| definition using x/y (`r = sqrt(x²+y²)`) | coordinate field | grid family (level sets) |
| `X ~ Normal(m, s)` | random variable | its density curve |
| `P(X < b)` | probability | shaded area + numeric readout |

Two consequences of invariant 4 worth naming because they already answer part
of "what should render as what" in custom coordinates, and should stay:

- **Scalar contexts already work in any coordinate system.** With polar fields
  defined, `r = 2(1+cos(theta))` (curve), `r < 1 + cos(theta)` (region), and
  `sin(3 theta)` (scalar field) all classify correctly via substitution.
- **A bare tuple of field names is a vector field** (`(r, theta)` → components
  r(x,y), θ(x,y)). Surprising at first sight but exactly what invariants 2+4
  compose to; keep it.

## 3. What Desmos and Wolfram|Alpha render that we don't

Feature classes, not product snapshots. ✓ = has it, ~ = partial/indirect.

| Object / capability | Desmos | W\|A | Here | Disposition |
|---|---|---|---|---|
| points in polar / user coordinates | ~ (polar curves only) | ✓ | — | **adopt, §5** (generalized: any user chart) |
| solutions/roots marked as points (systems, complex roots) | ~ (click) | ✓ | — | **adopt, §5** (same solver) |
| intersection points of curves | ✓ | ✓ | — | **adopt, §5** (falls out of position rows) |
| ODEs / flows in non-Cartesian coordinates | — | ✓ | — | **adopt, §5** |
| named points, vector arithmetic (`A = (1,2)`, `\|A-B\|`) | ✓ | ✓ | — (defs are scalar-only) | adopt, phase 2 |
| draggable points | ✓ | — | — | adopt, phase 2 (drag writes the def, like sliders) |
| segments, polygons, circles, vectors-as-arrows | ✓ | ✓ | — | adopt, phase 2 |
| midpoint/distance/angle readouts | ✓ | ✓ | — (only `P(…)` has a readout) | adopt, phase 2 (generalize the info line) |
| domain restrictions `{a < x < b}` | ✓ | ~ | — | adopt, phase 3 (also unlocks area-under-curve shading) |
| piecewise functions | ✓ | ✓ | — | adopt, phase 3 |
| definite integrals (value + `∫₀ˣ` as a function) | ✓ | ✓ | — | adopt, phase 3 |
| distribution zoo (uniform, exponential, t, binomial, Poisson…) | ✓ | ✓ | Normal only | adopt, phase 3; discrete ones need a stem/bar renderer |
| value readout for constant rows (`2+2` → "= 4") | ✓ | ✓ | plots y = 4 | adopt, small (keep the line, add the readout) |
| complex constants as Argand points (`1+2i`, `w³ = 1` roots) | ✓ | ✓ | degenerate/error | adopt, small + §5 solver |
| complex parametric curves (image of a path under f) | ~ | ✓ | rejected by classifier | adopt, phase 4 (needs a complex CPU evaluator) |
| 3D vector fields / 3D ODE flows (Lorenz) | — | ✓ | 2D only | adopt, phase 4 (auto-seeded trajectories; click is ambiguous in 3D) |
| spherical/cylindrical coordinate systems | — | ✓ | fields reject z | adopt, phase 4 (substitution already suffices for surfaces) |
| surfaces of revolution | — | ✓ | — | adopt, phase 4 (`revolve(f)` desugars to an implicit) |
| space curves as intersections of two surfaces | — | ✓ | — | later (invariant 1 in 3D; needs a curve extractor) |
| lists / families of objects | ✓ | ~ | only level families | later, phase 5 (the multiplier feature; big) |
| sequences (stem plots), cobweb diagrams | ~ | ✓ | — | later (lists first; cobweb is a cheap teaching win) |
| tables / data / regressions | ✓ | ✓ | — | **rejected for now** (no data model; revisit with lists) |
| actions, tickers, scripting | ✓ | — | — | **rejected** (out of scope for an equation grapher) |
| a "polar mode" grid toggle | ✓ | ✓ | — | **rejected** (§7: coordinate systems are user-defined math, not app modes) |

## 4. The decision procedure, restated with the additions

Row-level forms first (they bind names): definition (`a = …`, `f(x) = …`,
field), distribution (`X ~ …`), probability (`P(…)`). Then expression rows,
top-level shape before value type:

1. ODE sugar: `dy/dx = f`, `y' = f`, `(x', y') = (P, Q)` → direction field.
   **New:** primed *field* names `(c₁', c₂') = (F, G)` → flow in that chart (§5).
2. **New:** tuple-equation with coordinate names on the left,
   `(c₁, c₂) = (a, b)` where cᵢ ∈ {x, y} ∪ fields → simultaneous system (§5).
3. Whole-expression forms: `domain` / `conformal` / `iter` / `tube`.
4. Tuples by free vars: none → point; u(,v) → parametric; x,y → vector field.
5. Inequalities → regions; equations → implicit curve/surface;
   **new:** complex equations → root point set (§5) instead of today's error.
6. Bare scalars: x → graph; x,y → scalar field; complex → field lines;
   constant → horizontal line **plus a "= value" readout** (today it plots
   silently); **new:** constant complex → Argand point.

Everything else keeps failing loudly with a suggestion.

## 5. Design: positional objects in user coordinate systems

### The gap

Coordinate fields make every *scalar* context chart-aware (§2), but tuples are
axis-bound: with polar defined, `(2, pi/4)` is the Cartesian point x=2,
y=π/4 — there is no way to write *the point r=2, θ=π/4*, nor a parametric
curve given in (r, θ), nor an ODE whose components are polar velocities.
Verified: `(r, theta) = (2, pi/4)`, `(x, y) = (2, 3)`, and
`(r', theta') = (0, 1)` are all errors today — the syntax space is free.

### The decision: name the coordinates on the left

A positional row declares its coordinate system by naming coordinates in a
tuple on the left of `=`. No global "active chart", no inference from which
fields happen to be defined, no ordering magic: the row says which functions
it pins. Axis variables x, y are themselves coordinates (the identity chart),
so Cartesian is the same syntax, not a special case. Mixed pairs like
`(r, y) = (2, 1)` are legal — any independent pair of scalar fields is a
chart. This extends the pattern `(x', y') = (P, Q)` already established.

**Position rows** — `(c₁, c₂) = (a, b)`, each cᵢ ∈ {x, y} ∪ fields, distinct:
the row denotes the solution set of the simultaneous system
{c₁(x,y) = a, c₂(x,y) = b} (invariant 1, now honest about two constraints in
2D → dimension 0):

- RHS constant (t allowed): a **solved point set**, rendered as overlay dots.
  `(r, theta) = (2, pi/4)` is the polar point; `(r, theta) = (2, t)` orbits.
  Non-injective charts render their whole preimage — with the hyperbolic
  chart `p = x y; q = (x²-y²)/2`, the row `(p, q) = (1, 0)` is *two* dots,
  which is the mathematically honest Point object in that system.
- RHS depending on x, y: still the same reading — `(x, y) = (y, -sin(x))`
  marks the **intersection points** of the curves x = y and y = -sin(x)
  (equivalently, fixed points of the map). Curve intersection — a
  long-standing Desmos affordance — falls out for free.
- RHS in u: a **parametric curve in the chart**, u ∈ (0,1) as everywhere.
  `(r, theta) = (3u, 6pi u)` is a three-turn spiral. Note this *fixes* the
  known limitation that implicit polar spirals (`r = theta + pi`) only draw
  the principal branch of atan2: the parametric form tracks θ continuously
  past ±π.

**Flow rows** — `(c₁', c₂') = (F, G)`: the ODE ċ₁ = F, ċ₂ = G in chart
coordinates. By the chain rule ċᵢ = ∇cᵢ · v, so the Cartesian field is
v = J⁻¹(F, G) with J the Jacobian of (c₁, c₂) — built *symbolically* (a 2×2
inverse via `diff()`, like the grid's gradients), then fed to the existing
LIC renderer and RK4 click-to-trace untouched. `(r', theta') = (r(1-r), 1)`
is a textbook limit cycle in one line. Where det J = 0 the field is
undefined and the LIC fades, matching how singularities already behave.

**Complex root rows** — `f(w) = c` with f complex-valued: a holomorphic
equation is a 2×2 real system, so the same engine renders `w^3 = 1` as three
dots on the Argand plane (today: an error suggesting re/im). This replaces no
behavior and completes invariant 5.

### The engine: one Newton solver

New `lib/solve.ts`: damped Newton on F: ℝ²→ℝ² with an analytic Jacobian via
`diff()` (finite-difference fallback, the `grid.ts` pattern), seeded from a
~24×24 lattice over the view (plus margin), tolerance scaled to `view.upp`,
solutions deduped by a few pixels and capped (~64). Angular fields (the
existing `GridField.angular` flag) compare residuals wrapped to (−π, π], so
`(r, theta) = (2, 9pi/4)` finds the point and grid lines/targets agree about
the branch cut. Parametric rows solve with **continuation**: warm-start each
u-sample from the previous solution, re-seed on divergence, NaN to break the
polyline (the overlay renderer already pen-lifts on NaN). Static rows solve
once per recompile/slider change; only t-dependent rows re-solve per frame,
warm-started from the previous frame's solutions (full re-seeding only on
view changes) — negligible next to the existing per-frame RK4 integral
curves.

### Implementation notes

- **Classify before substituting.** `main.ts` currently substitutes fields
  into the whole parsed row before `classify()`, which would destroy the LHS
  names. Move the substitution into `classify(parsed, defs)` (or pre-scan):
  detect the named-tuple/primed forms first, then substitute into the RHS and
  into scalar rows as today. The "second `r = …` row is a plot" rule in
  `recompileAll` is unaffected.
- New plot kinds: `{ type: 'solvedpts'; sys: [Expr, Expr]; angular: [boolean, boolean] }`
  (also carrying rhs for animation) and the flow row lowering to the existing
  `vfield2d` (both its GLSL strings and its CPU `comps` come from the same
  symbolic v = J⁻¹(F,G)). Chart-parametric curves reuse `pcurve`'s slot in the
  overlay with a solving sampler.
- **Errors are part of the design**: undefined name in an LHS tuple → "theta
  is not a coordinate — define theta = atan2(y, x)"; repeated name → "(r, r)
  does not determine a point"; mixing primed and unprimed → point at the two
  forms; symbolically dependent pairs surface at runtime as no solutions /
  degenerate J, same as other singular math.
- **Definition of done** (repo convention): `lib` tests for the classifier
  and solver; examples menu entries under *coordinates* (polar point, spiral,
  polar limit cycle, hyperbolic two-dot point); `llms.txt` row-type docs;
  about-page shot if it earns one.

## 6. Roadmap

| Phase | Contents | Size |
|---|---|---|
| 1 — coordinate objects | position rows (points, intersections, chart parametrics), flow rows, `lib/solve.ts` | M |
| 1.5 — coherence wins | complex roots `f(w)=c` via the same solver; Argand points for complex constants; "= value" readout on constant rows | S |
| 2 — geometry | tuple-valued constants + vector arithmetic (`A = (1,2)`, `\|A-B\|`), draggable named points, `segment`/`polygon`/`circle`/`vector` arrows, measurement readouts | M–L |
| 3 — analysis | restrictions `{a < x < b}`, piecewise, definite integrals (value, `∫₀ˣ` via CPU LUT texture, area shading), distribution zoo + discrete stem/bar renderer | L |
| 4 — space | fields over z (spherical/cylindrical surfaces by substitution), 3D flows with auto-seeded trajectories (Lorenz), 3D arrow fields, `revolve()` | L |
| 5 — families | lists broadcasting over any object kind; then sequences, scatter/data, cobwebs | XL |

Phase 1 first: it is the user-visible gap this document exists for, it
strengthens rather than complicates the classification model (it *completes*
invariant 1), and its solver is the foundation for 1.5 and for phase-2
intersections/measurements.

## 7. Rejected designs

- **A polar/coordinate mode or grid toggle.** Desmos's polar is a built-in
  special case. Here a coordinate system is itself a mathematical object the
  user writes down; the reward is that log-polar, hyperbolic, or any
  invertible chart is equally first-class. A mode would fork every renderer
  and break "notation alone decides".
- **Inferring "the" chart from the defined fields** (e.g. first two fields in
  definition order form the system, making bare `(2, pi/4)` polar). Order-
  sensitive spooky action; breaks Cartesian tuples the moment any field is
  defined; ambiguous with ≠2 fields. Naming the coordinates per row costs a
  few characters and is self-documenting.
- **Symbolic chart inversion** (solve (r,θ)→(x,y) in closed form). Fragile
  outside textbook charts; the numeric engine handles every chart uniformly,
  including non-injective ones, and matches the app's existing "analytic when
  possible, numeric when not" posture (gradients, Frenet frames).
- **A geometry sub-app.** Segments and polygons will be expressions
  (phase 2), not a separate tool with different semantics.
