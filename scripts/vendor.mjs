// Bereitet die Bibliotheken fürs Fenster vor (läuft nach "npm install"):
// - Shaka Player wird kopiert, so muss das fertige Programm nicht das ganze 80-MB-Paket mitschleppen.
// - googlevideo (SABR-Streaming) wird zu einer Datei gebündelt, weil das Fenster keine npm-Pakete auflösen kann.
// - Der Twitch-Werbeblocker aus Adblock GX (third_party/adblock-gx) bekommt Einstellungen und Ersatz-Stück.
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

// Twitch-Werbeblocker: läuft im Fenster vor Shaka und hängt sich in fetch ein
const TWITCH_INIT = {
  clientId: 'kimne78kx3ncx6brgo4mv6wki5h1ko',
  channel: 'gx-twitch-adblock', // BroadcastChannel für Meldungen und das Konto (Authorization)
  relay: false,
  adSpoofing: false, // Werbung nie als gesehen melden
};
const twitchSrc = fs.readFileSync(path.join(root, 'third_party/adblock-gx/twitch_worker.js'), 'utf8');
const hold = fs.readFileSync(path.join(root, 'third_party/adblock-gx/twitch_hold.ts')).toString('base64');
const twitch = path.join(vendor, 'twitch-adblock.js');
fs.writeFileSync(
  twitch,
  '// Erzeugt von scripts/vendor.mjs aus third_party/adblock-gx – nicht von Hand ändern.\n' +
    twitchSrc.replace('__AB_WORKER_INIT__', () => JSON.stringify(TWITCH_INIT)).replace('__AB_HOLD_SEGMENT__', () => JSON.stringify(hold)),
);
console.log('Twitch-Werbeblocker →', path.relative(root, twitch));
