// Erzeugt die PNG-Symbole aus den SVGs in src/assets (einmalig, Ergebnis liegt im Repo).
// Aufruf: node scripts/make-icons.mjs  (braucht Chromium, z. B. über PLAYWRIGHT_CHROMIUM=/pfad)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = (name) => fs.readFileSync(path.join(root, 'src/assets', name), 'utf8');
const jobs = [
  { svg: 'icon.svg', out: 'build/icon.png', w: 512, h: 512 },
  { svg: 'icon.svg', out: 'src/assets/icon.png', w: 256, h: 256 },
  { svg: 'tray.svg', out: 'src/assets/tray.png', w: 32, h: 32, pad: 2 },
  { svg: 'tray.svg', out: 'src/assets/tray@2x.png', w: 64, h: 64, pad: 4 },
  { svg: 'tray.svg', out: 'src/assets/trayTemplate.png', w: 18, h: 18, pad: 1, mono: true },
  { svg: 'tray.svg', out: 'src/assets/trayTemplate@2x.png', w: 36, h: 36, pad: 2, mono: true },
];

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined });
const page = await browser.newPage();
for (const j of jobs) {
  let markup = svg(j.svg);
  if (j.mono) markup = markup.replace(/(stroke|fill)="#[0-9A-Fa-f]{6}"/g, '$1="#000000"');
  const pad = j.pad ?? 0;
  await page.setViewportSize({ width: j.w, height: j.h });
  await page.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${j.w}px;height:${j.h}px;padding:${pad}px;box-sizing:border-box;display:grid;place-items:center">${markup.replace('<svg ', '<svg style="width:100%;height:100%" ')}</div></body></html>`);
  await page.screenshot({ path: path.join(root, j.out), omitBackground: true });
  console.log('✓', j.out);
}
await browser.close();
