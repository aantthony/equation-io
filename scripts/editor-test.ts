/**
 * Browser tests for the contentEditable equation editor: `pnpm test:editor`.
 *
 * The editor is the app's primary input surface and its logic (caret math,
 * state/DOM sync, widget-boundary handling) can only run in a real DOM, so it
 * is invisible to the vitest suite. This drives the actual app in headless
 * Chromium and asserts behavior end to end.
 *
 * Widget-origin cases are the reason this exists: sliders and error blocks
 * live *inside* the contentEditable as contenteditable=false widgets, so their
 * inputs bubble key and clipboard events to the editor host. Without target
 * guards those events edit whatever line the caret last touched.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const PORT = 5197;
const ORIGIN = `http://localhost:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      ${detail}` : ''}`);
}

/** Run a scenario; a thrown error (e.g. a widget the bug destroyed) is a failure, not a crash. */
async function scenario(label: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    check(label, false, String(err).split('\n')[0]);
  }
}

const rowTexts = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('.eq-line')].map(l => l.textContent));

async function load(page: Page, rows: string[]) {
  // goto with only a differing hash does not reload, which would leak the
  // previous scenario's equations into the next one.
  await page.goto('about:blank');
  await page.goto(ORIGIN + '/#' + rows.map(encodeURIComponent).join(';'));
  await page.waitForSelector('.eq-line');
  await page.waitForSelector('.eq-slider input[type=range]', { timeout: 3000 }).catch(() => {});
}

/** Put the caret in a line at a character offset (mirrors user clicking). */
async function caretTo(page: Page, line: number, offset: number) {
  await page.evaluate(
    ({ line, offset }) => {
      const el = [...document.querySelectorAll('.eq-line')][line] as HTMLElement;
      el.focus();
      const node = el.firstChild ?? el;
      const r = document.createRange();
      r.setStart(node, Math.min(offset, node.textContent?.length ?? 0));
      r.collapse(true);
      const sel = getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
    },
    { line, offset },
  );
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

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });

// --- events originating in slider widgets must not edit the document ---

await load(page, ['a = 1', 'y = sin(a x)']);
await scenario('paste into slider bound', async () => {
  // Paste into a slider bound input: must reach the input, not the equations.
  const before = await rowTexts(page);
  await page.evaluate(() => {
    const min = document.querySelector<HTMLInputElement>('.eq-slider input[type=number]')!;
    min.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', '-42');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    min.dispatchEvent(ev);
    (globalThis as { __pasteDefaultPrevented?: boolean }).__pasteDefaultPrevented = ev.defaultPrevented;
  });
  const after = await rowTexts(page);
  const prevented = await page.evaluate(
    () => (globalThis as { __pasteDefaultPrevented?: boolean }).__pasteDefaultPrevented,
  );
  check(
    'paste into slider bound does not rewrite equations',
    JSON.stringify(before) === JSON.stringify(after),
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  );
  check('paste into slider bound is not preventDefaulted', prevented === false, `prevented=${prevented}`);
});

await scenario('Enter in slider bound', async () => {
  // Enter inside a bound input must not split an unrelated equation.
  await caretTo(page, 1, 4); // caret parked mid "y = sin(a x)"
  const before = await rowTexts(page);
  await page.evaluate(() => {
    const min = document.querySelector<HTMLInputElement>('.eq-slider input[type=number]')!;
    min.focus();
    min.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  const after = await rowTexts(page);
  check(
    'Enter in slider bound does not split a line',
    JSON.stringify(before) === JSON.stringify(after),
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  );
});

await scenario('undo shortcut in slider bound', async () => {
  // Cmd/Ctrl+Z inside a bound input must stay native, not pop our undo stack.
  const before = await rowTexts(page);
  await page.evaluate(() => {
    const min = document.querySelector<HTMLInputElement>('.eq-slider input[type=number]')!;
    min.focus();
    min.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }),
    );
  });
  const after = await rowTexts(page);
  check(
    'undo shortcut in slider bound does not revert equations',
    JSON.stringify(before) === JSON.stringify(after),
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  );
});

// --- normal editing still works (regression guards for the same handlers) ---

await scenario('Enter in a line splits', async () => {
  await load(page, ['a = 1', 'y = sin(a x)']);
  await caretTo(page, 1, 12); // end of "y = sin(a x)"
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#equations')!;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  const after = await rowTexts(page);
  check('Enter in a line still splits into a new row', after.length === 3, `rows=${JSON.stringify(after)}`);
});

await scenario('paste a system', async () => {
  // Pasting a system of equations into an empty document: the headline
  // capability of the unified editor.
  await load(page, ['y = x', 'y = 2x']);
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#equations')!;
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    const dt = new DataTransfer();
    dt.setData('text/plain', 'a = 2\ny = a x^2\ny = x^3');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const after = await rowTexts(page);
  check(
    'pasting a system into an empty document creates one row per statement',
    after.length === 3 && after[0] === 'a = 2' && after[1] === 'y = a x^2' && after[2] === 'y = x^3',
    `rows=${JSON.stringify(after)}`,
  );
});

await scenario('insertParagraph', async () => {
  // insertParagraph (mobile IME / dictation newline) must split like Enter.
  await load(page, ['y = x']);
  await caretTo(page, 0, 5);
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#equations')!;
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true }));
  });
  const after = await rowTexts(page);
  check('insertParagraph splits the line (IME/dictation newline)', after.length === 2, `rows=${JSON.stringify(after)}`);
});

await scenario('typing syncs', async () => {
  // Typing still syncs to state and renders.
  await load(page, ['y = x']);
  await caretTo(page, 0, 5);
  await page.evaluate(() => {
    const line = document.querySelector<HTMLElement>('.eq-line')!;
    line.textContent = 'y = x^2';
    document.querySelector<HTMLElement>('#equations')!
      .dispatchEvent(new InputEvent('input', { inputType: 'insertText', bubbles: true }));
  });
  const hash = await page.evaluate(() => location.hash);
  check('typing syncs state to the URL hash', decodeURIComponent(hash).includes('y = x^2'), `hash=${hash}`);
});

await browser.close();
server.kill();

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
