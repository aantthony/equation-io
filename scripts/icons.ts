/**
 * Rasterises web/public/icon.svg into the PNG sizes the install prompts need:
 * `pnpm icons`. Rerun after editing icon.svg.
 *
 * iOS reads apple-touch-icon.png (180) for Home Screen web apps; Android reads
 * the manifest's 192/512. The maskable variant insets the artwork into the
 * safe circle Android crops to, so the sine curve survives a round mask.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = fileURLToPath(new URL('../web/public/', import.meta.url));
const svg = readFileSync(DIR + 'icon.svg', 'utf8');

/** The icon's own backdrop, extended to fill the padding on maskable renders. */
const BG = '#171a1f';

const TARGETS = [
  { file: 'apple-touch-icon.png', size: 180, inset: 0 },
  { file: 'icon-192.png', size: 192, inset: 0 },
  { file: 'icon-512.png', size: 512, inset: 0 },
  // Android crops maskable icons to a circle inscribed in the middle 80%.
  { file: 'icon-maskable-512.png', size: 512, inset: 0.14 },
];

const browser = await chromium.launch();
try {
  for (const { file, size, inset } of TARGETS) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    const pad = Math.round(size * inset);
    await page.setContent(
      `<style>html,body{margin:0;background:${BG}}
       #a{width:${size}px;height:${size}px;display:grid;place-items:center}
       svg{width:${size - 2 * pad}px;height:${size - 2 * pad}px}</style>
       <div id="a">${svg}</div>`,
    );
    writeFileSync(DIR + file, await page.screenshot({ omitBackground: false }));
    await page.close();
    console.log(`${file} ${size}x${size}`);
  }
} finally {
  await browser.close();
}
