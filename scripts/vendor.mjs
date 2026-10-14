// Kopiert den Shaka Player ins Fenster-Verzeichnis (läuft nach "npm install").
// So muss das fertige Programm nicht das ganze 80-MB-Paket mitschleppen.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules/shaka-player/dist/shaka-player.compiled.js');
const dest = path.join(root, 'src/renderer/vendor/shaka-player.js');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
console.log('Shaka Player →', path.relative(root, dest));
