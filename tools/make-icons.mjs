// Rasterises public/icons/mark.svg into the PNG sizes a PWA install needs.
// Run after editing the mark: node tools/make-icons.mjs

import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const svg = readFileSync(new URL('../public/icons/mark.svg', import.meta.url), 'utf8');
const dir = new URL('../public/icons/', import.meta.url);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage();

async function render(file, size, { inset = 0 } = {}) {
  // Maskable icons get an inset so the mark survives an aggressive circle
  // crop; the background bleeds to the edges regardless.
  const scale = 1 - inset * 2;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`
    <style>
      html,body{margin:0;background:#0b0f13}
      .wrap{width:${size}px;height:${size}px;display:grid;place-items:center;
            background:#121820}
      svg{width:${Math.round(size * scale)}px;height:${Math.round(size * scale)}px;
          ${inset ? 'border-radius:0' : ''}}
      ${inset ? '.wrap svg rect:first-of-type{fill:transparent}' : ''}
    </style>
    <div class="wrap">${svg}</div>`);
  const buf = await page.screenshot({ omitBackground: false });
  writeFileSync(new URL(file, dir), buf);
  console.log(`  ${file}  ${size}x${size}`);
}

await render('icon-192.png', 192);
await render('icon-512.png', 512);
await render('maskable-512.png', 512, { inset: 0.14 });
await render('apple-touch-icon.png', 180);

await browser.close();
console.log('icons written');
