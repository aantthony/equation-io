/**
 * Browser tests for the panel swipe-to-dismiss gesture: `pnpm test:swipe`.
 *
 * The gesture code (web/panel-swipe.ts) is arbitration between native touch
 * behaviors — scrolling, taps, clicks — and a custom drag, so unit tests of
 * the physics (lib/fling.test.ts) cannot cover it. This drives the real app
 * in headless Chromium with CDP-synthesized *trusted* touch input: real hit
 * testing, real scrolling, real click suppression after a swipe.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { type CDPSession, type Page, chromium } from 'playwright';

const PORT = 5198;
const ORIGIN = `http://localhost:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      ${detail}` : ''}`);
}

async function scenario(label: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    check(label, false, String(err).split('\n')[0]);
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Pt {
  x: number;
  y: number;
}

/** Evenly spaced points from `a` to `b`, endpoints included. */
function path(a: Pt, b: Pt, steps: number): Pt[] {
  return Array.from({ length: steps + 1 }, (_, i) => ({
    x: a.x + ((b.x - a.x) * i) / steps,
    y: a.y + ((b.y - a.y) * i) / steps,
  }));
}

/**
 * One-finger drag through `pts`. Real time passes between moves, so release
 * velocity is (distance between points) / stepMs; `holdMs` pauses before
 * lifting, which zeroes it (the stall gate).
 */
async function swipe(cdp: CDPSession, pts: Pt[], { stepMs = 16, holdMs = 0 } = {}) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...pts[0], id: 1 }] });
  for (let i = 1; i < pts.length; i++) {
    await sleep(stepMs);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...pts[i], id: 1 }] });
  }
  if (holdMs) await sleep(holdMs);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const panelState = (page: Page) =>
  page.evaluate(() => {
    const p = document.getElementById('panel')!;
    const chip = document.getElementById('panel-chip')!;
    return {
      visibility: getComputedStyle(p).visibility,
      transform: p.style.transform,
      chipShown: !chip.hidden && chip.classList.contains('shown'),
    };
  });

const panelRect = (page: Page) =>
  page.evaluate(() => {
    const r = document.getElementById('panel')!.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });

/** Poll until the panel reports dismissed (or not); throws on timeout. */
async function waitState(page: Page, want: 'hidden' | 'home', timeout = 2500) {
  const t0 = Date.now();
  for (;;) {
    const s = await panelState(page);
    if (want === 'hidden' && s.visibility === 'hidden' && s.chipShown) return;
    if (want === 'home' && s.visibility !== 'hidden' && s.transform === '' && !s.chipShown) return;
    if (Date.now() - t0 > timeout) {
      throw new Error(`timed out waiting for ${want}: ${JSON.stringify(s)}`);
    }
    await sleep(50);
  }
}

async function load(page: Page, rows: string[]) {
  await page.goto('about:blank');
  await page.goto(ORIGIN + '/#' + rows.map(encodeURIComponent).join(';'));
  await page.waitForSelector('.eq-line');
}

const server = spawn(`${ROOT}node_modules/.bin/vite`, ['--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: 'ignore',
});
process.on('exit', () => server.kill());

for (let i = 0; ; i++) {
  try {
    if ((await fetch(ORIGIN)).ok) break;
  } catch {}
  if (i > 100) throw new Error(`vite did not come up on ${ORIGIN}`);
  await new Promise(r => setTimeout(r, 200));
}

// CHROMIUM overrides the browser binary, for containers with a system build.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ['--enable-unsafe-swiftshader'],
});
// A phone-shaped, touch-enabled page: the surface the gesture exists for.
const page = await browser.newPage({ viewport: { width: 390, height: 720 }, hasTouch: true });
const cdp = await page.context().newCDPSession(page);

await scenario('flick up dismisses', async () => {
  await load(page, ['y = sin(x)']);
  const r = await panelRect(page);
  const from = { x: r.left + r.width / 2, y: r.top + r.height * 0.6 };
  // ~160px in ~64ms: an unambiguous flick.
  await swipe(cdp, path(from, { x: from.x, y: from.y - 160 }, 4));
  await waitState(page, 'hidden');
  check('flick up hides the panel and shows the chip', true);
});

await scenario('chip tap restores', async () => {
  await page.tap('#panel-chip');
  await waitState(page, 'home');
  check('tapping the chip springs the panel back', true);
});

await scenario('short slow drag springs back', async () => {
  const r = await panelRect(page);
  const from = { x: r.left + r.width / 2, y: r.top + r.height * 0.7 };
  // A third of the panel, slowly, resting before release: short of the
  // halfway commit point, and the rest zeroes any leftover momentum.
  await swipe(cdp, path(from, { x: from.x, y: from.y - r.height * 0.35 }, 6), { stepMs: 40, holdMs: 250 });
  await waitState(page, 'home');
  check('a hesitant drag settles back home', true);
});

await scenario('slow drag past half dismisses', async () => {
  const r = await panelRect(page);
  const from = { x: r.left + r.width / 2, y: r.top + r.height * 0.8 };
  // Past half the panel with no speed at all: still a dismissal.
  await swipe(cdp, path(from, { x: from.x, y: from.y - r.height * 0.65 }, 10), { stepMs: 40, holdMs: 250 });
  await waitState(page, 'hidden');
  check('carrying the panel past halfway dismisses without a flick', true);
  await page.tap('#panel-chip');
  await waitState(page, 'home');
});

await scenario('flick left dismisses', async () => {
  const r = await panelRect(page);
  const from = { x: r.left + r.width * 0.7, y: r.top + r.height * 0.5 };
  await swipe(cdp, path(from, { x: from.x - 150, y: from.y }, 4));
  await waitState(page, 'hidden');
  check('flick left hides the panel too', true);
  await page.tap('#panel-chip');
  await waitState(page, 'home');
});

await scenario('drag the wrong way rubber-bands', async () => {
  const r = await panelRect(page);
  const from = { x: r.left + r.width / 2, y: r.top + r.height * 0.3 };
  const pts = path(from, { x: from.x + 120, y: from.y + 120 }, 8);
  // Sample the transform mid-gesture: dispatch the drag but read before lift.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...pts[0], id: 1 }] });
  for (let i = 1; i < pts.length; i++) {
    await sleep(16);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...pts[i], id: 1 }] });
  }
  const mid = await panelState(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const m = mid.transform.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px/);
  const ok = !!m && Number(m[1]) > 0 && Number(m[1]) < 60 && Number(m[2]) > 0 && Number(m[2]) < 60;
  check('120px of down-right drag yields a small resisted offset', ok, `transform=${mid.transform}`);
  await waitState(page, 'home');
});

await scenario('swipe on a scrollable list scrolls it, not the panel', async () => {
  // Enough rows that #equations overflows and owns vertical pans.
  await load(page, Array.from({ length: 40 }, (_, i) => `y = ${i + 1} x`));
  const box = await page.evaluate(() => {
    const r = document.getElementById('equations')!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await swipe(cdp, path(box, { x: box.x, y: box.y - 150 }, 6));
  // Read immediately: a claimed drag would still be translated or animating.
  const s = await panelState(page);
  const scrolled = await page.evaluate(() => document.getElementById('equations')!.scrollTop);
  check(
    'the list consumed the swipe',
    s.visibility !== 'hidden' && s.transform === '' && scrolled > 0,
    `state=${JSON.stringify(s)} scrollTop=${scrolled}`,
  );
});

await scenario('swipe from the gutter dismisses without recoloring', async () => {
  await load(page, ['y = x']);
  const line = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.eq-line')!;
    const r = el.getBoundingClientRect();
    return { x: r.left + 10, y: r.top + r.height / 2, color: el.style.getPropertyValue('--eq-color') };
  });
  await swipe(cdp, path({ x: line.x, y: line.y }, { x: line.x, y: line.y - 150 }, 4));
  await waitState(page, 'hidden');
  const after = await page.evaluate(
    () => document.querySelector<HTMLElement>('.eq-line')!.style.getPropertyValue('--eq-color'),
  );
  check('gutter-origin swipe left the row color alone', after === line.color, `${line.color} -> ${after}`);
  await page.tap('#panel-chip');
  await waitState(page, 'home');
});

await scenario('gutter tap still recolors', async () => {
  const line = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.eq-line')!;
    const r = el.getBoundingClientRect();
    return { x: r.left + 10, y: r.top + r.height / 2, color: el.style.getPropertyValue('--eq-color') };
  });
  await page.touchscreen.tap(line.x, line.y);
  await sleep(100);
  const after = await page.evaluate(
    () => document.querySelector<HTMLElement>('.eq-line')!.style.getPropertyValue('--eq-color'),
  );
  check('a plain touch tap on the dot cycles the color', after !== line.color, `stuck at ${after}`);
});

await scenario('dragging the chip pulls the panel back in', async () => {
  await load(page, ['y = sin(x)']);
  const r = await panelRect(page);
  await swipe(cdp, path({ x: r.left + r.width / 2, y: r.top + r.height * 0.6 }, { x: r.left + r.width / 2, y: r.top + r.height * 0.6 - 160 }, 4));
  await waitState(page, 'hidden');
  const chip = await page.evaluate(() => {
    const c = document.getElementById('panel-chip')!.getBoundingClientRect();
    return { x: c.left + c.width / 2, y: c.top + c.height / 2 };
  });
  // Pull well past the parked distance: the panel must follow and open.
  await swipe(cdp, path(chip, { x: chip.x, y: chip.y + 200 }, 8), { stepMs: 24 });
  await waitState(page, 'home');
  check('a pull on the chip brings the panel home', true);

  // Dismiss again and pull only a little: it must park again, chip back.
  const r2 = await panelRect(page);
  await swipe(cdp, path({ x: r2.left + r2.width / 2, y: r2.top + r2.height * 0.6 }, { x: r2.left + r2.width / 2, y: r2.top + r2.height * 0.6 - 160 }, 4));
  await waitState(page, 'hidden');
  await swipe(cdp, path(chip, { x: chip.x, y: chip.y + 25 }, 5), { stepMs: 40, holdMs: 250 });
  await waitState(page, 'hidden');
  check('a timid pull lets the panel park again', true);
  await page.tap('#panel-chip');
  await waitState(page, 'home');
});

await scenario('the panel can be caught mid-flight', async () => {
  // A tall panel makes for a long flight — long enough to intercept.
  await load(page, Array.from({ length: 8 }, (_, i) => `y = x + ${i}`));
  const r = await panelRect(page);
  const from = { x: r.left + r.width / 2, y: r.top + r.height * 0.7 };
  // A modest flick: enough to commit the dismissal, slow enough to catch.
  await swipe(cdp, path(from, { x: from.x, y: from.y - 100 }, 6), { stepMs: 24 });
  await sleep(80); // it is now flying off, partly off-screen
  const mid = await panelRect(page);
  if (mid.top + mid.height < 40) throw new Error(`nothing left to catch: ${JSON.stringify(mid)}`);
  const grab = { x: mid.left + mid.width / 2, y: mid.top + mid.height - 25 };
  // Catch the visible sliver and shove it back down well past home (the
  // overshoot rubber-bands away), rest, release: it must settle home.
  await swipe(cdp, path(grab, { x: grab.x, y: grab.y + 400 }, 10), { holdMs: 250 });
  await waitState(page, 'home');
  check('a touch during the exit catches the panel and can put it back', true);
});

await browser.close();
server.kill();

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
