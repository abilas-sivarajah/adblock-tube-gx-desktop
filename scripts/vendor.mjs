// Bereitet die Bibliotheken fürs Fenster vor (läuft nach "npm install"):
// - Shaka Player wird kopiert, so muss das fertige Programm nicht das ganze 80-MB-Paket mitschleppen.
// - googlevideo (SABR-Streaming) wird zu einer Datei gebündelt, weil das Fenster keine npm-Pakete auflösen kann.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'src/renderer/vendor');
fs.mkdirSync(vendor, { recursive: true });

const shaka = path.join(vendor, 'shaka-player.js');
fs.copyFileSync(path.join(root, 'node_modules/shaka-player/dist/shaka-player.compiled.js'), shaka);
console.log('Shaka Player →', path.relative(root, shaka));

const googlevideo = path.join(vendor, 'googlevideo.js');
await build({
  entryPoints: [path.join(root, 'scripts/googlevideo-entry.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  minify: true,
  legalComments: 'inline',
  outfile: googlevideo,
  logLevel: 'warning',
});
console.log('googlevideo →', path.relative(root, googlevideo));
