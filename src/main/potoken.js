// PO-Token ("Proof of Origin"): YouTube will damit sehen, dass die Anfragen aus einem echten
// Browser kommen – ohne Token gibt es "Bestätige, dass du kein Bot bist" oder gesperrte Streams.
// Wie FreeTube: YouTubes BotGuard-Programm läuft in einem unsichtbaren Chromium-Fenster,
// die Netzwerkzugriffe macht der Hauptprozess.

import { BrowserWindow, net } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChallenge } from 'bgutils-js/botguard';

const here = path.dirname(fileURLToPath(import.meta.url));
// Schlüssel, den YouTubes Web-Player für BotGuard benutzt
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
const GOOG_API_KEY = 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw';
const WAA = 'https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa';

let win = null;
let windowReady = null;
let validUntil = 0;
let initPromise = null;
let failedAt = 0;

const fetchImpl = (url, init) => net.fetch(url, init);

function waaHeaders() {
  return {
    'Content-Type': 'application/json+protobuf',
    'x-goog-api-key': GOOG_API_KEY,
    'x-user-agent': 'grpc-web-javascript/0.1',
  };
}

function ensureWindow() {
  if (win && !win.isDestroyed()) return windowReady;
  win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    skipTaskbar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => {
    win = null;
    windowReady = null;
    validUntil = 0;
  });
  windowReady = win.loadFile(path.join(here, '..', 'potoken', 'index.html')).then(async () => {
    // Warten, bis das Modul geladen ist
    for (let i = 0; i < 50; i++) {
      if (await win.webContents.executeJavaScript('Boolean(window.gxPot)')) return win;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('BotGuard-Fenster lädt nicht');
  });
  return windowReady;
}

function run(w, call, arg) {
  return w.webContents.executeJavaScript(`window.gxPot.${call}(${JSON.stringify(arg)})`);
}

async function init() {
  const challenge = await getChallenge({ requestKey: REQUEST_KEY, fetchFunction: fetchImpl });
  let interpreterJs = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  const interpreterUrl = challenge.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
  if (!interpreterJs && interpreterUrl) {
    const res = await fetchImpl(interpreterUrl.startsWith('//') ? 'https:' + interpreterUrl : interpreterUrl);
    interpreterJs = await res.text();
  }
  if (!interpreterJs || !challenge.program || !challenge.globalName) throw new Error('BotGuard-Aufgabe unvollständig');

  const w = await ensureWindow();
  const botguardResponse = await run(w, 'snapshot', { interpreterJs, program: challenge.program, globalName: challenge.globalName });

  const res = await fetchImpl(`${WAA}/GenerateIT`, {
    method: 'POST',
    headers: waaHeaders(),
    body: JSON.stringify([REQUEST_KEY, botguardResponse]),
  });
  if (!res.ok) throw new Error(`Integritäts-Token abgelehnt (HTTP ${res.status})`);
  const [integrityToken, estimatedTtlSecs] = await res.json();
  if (typeof integrityToken !== 'string') throw new Error('Kein Integritäts-Token');
  await run(w, 'setIntegrityToken', integrityToken);
  // Etwas vor Ablauf erneuern
  validUntil = Date.now() + Math.max(300, (Number(estimatedTtlSecs) || 3600) - 300) * 1000;
}

/** Ist das Erzeugen gerade möglich (nicht kurz zuvor gescheitert)? */
export function available() {
  return Date.now() - failedAt > 10 * 60 * 1000;
}

/** Startet BotGuard im Hintergrund, damit das erste Video nicht warten muss. */
export function warmUp() {
  prepare().catch(() => {});
}

function prepare() {
  if (Date.now() < validUntil && win && !win.isDestroyed()) return Promise.resolve();
  if (!initPromise) {
    initPromise = init()
      .catch((err) => {
        failedAt = Date.now();
        throw err;
      })
      .finally(() => {
        initPromise = null;
      });
  }
  return initPromise;
}

/** PO-Token für eine Bindung: Visitor-ID (für die Video-Server) oder Video-ID (für die Player-Anfrage). */
export async function mint(contentBinding) {
  await prepare();
  return run(win, 'mint', String(contentBinding));
}

export function dispose() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}
