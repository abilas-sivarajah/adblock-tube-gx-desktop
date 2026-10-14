// Startet GX Tube Desktop wirklich (Electron) und steuert es wie die Android-App:
// Suche per UDP, Verbinden per WebSocket, Video abspielen, Pause, Springen, Lautstärke.
// Screenshots landen in test-e2e/out/. Unter Linux ohne Bildschirm: xvfb-run npm run smoke
import { _electron as electron } from 'playwright-core';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test-e2e/out');
fs.mkdirSync(out, { recursive: true });
const PORT = 18765;
const DISCOVERY = 18766;
const VIDEO = process.env.SMOKE_VIDEO || 'dQw4w9WgXcQ';
const offline = process.env.SMOKE_OFFLINE === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

function discover() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { sock.close(); reject(new Error('Keine Antwort auf die Suche')); }, 3000);
    sock.on('message', (buf) => { clearTimeout(timer); sock.close(); resolve(JSON.parse(buf.toString())); });
    sock.bind(0, () => sock.send(Buffer.from(JSON.stringify({ type: 'discover', protocol: 1 })), DISCOVERY, '127.0.0.1'));
  });
}

class Phone {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.messages = [];
    this.waiters = [];
    this.ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      this.messages.push(msg);
      if (msg.type === 'state') this.state = msg;
      if (msg.type === 'queue') this.queue = msg;
      this.waiters = this.waiters.filter((w) => !w(msg));
    });
  }
  open() { return new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); }); }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  waitFor(pred, ms = 30000, what = 'Nachricht') {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Zeitüberschreitung: ${what} (letzter Zustand: ${JSON.stringify(this.state)?.slice(0, 300)})`)), ms);
      const w = (m) => { if (pred(m)) { clearTimeout(timer); resolve(m); return true; } return false; };
      this.waiters.push(w);
    });
  }
  close() { this.ws.close(); }
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gxtube-smoke-'));
// SMOKE_EXECUTABLE=dist/linux-unpacked/gxtube-desktop prüft das fertig gebaute Programm
const executablePath = process.env.SMOKE_EXECUTABLE ? path.resolve(root, process.env.SMOKE_EXECUTABLE) : undefined;
const app = await electron.launch({
  executablePath,
  args: executablePath ? ['--no-sandbox'] : [root, '--no-sandbox'],
  cwd: root,
  env: { ...process.env, GXTUBE_USER_DATA: userData, GXTUBE_PORT: String(PORT), GXTUBE_DISCOVERY_PORT: String(DISCOVERY), GXTUBE_NO_UPDATES: '1' },
});
let failed = false;
try {
  const win = await app.firstWindow();
  win.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('  [fenster]', m.text().slice(0, 300)); });
  await win.waitForSelector('#castHero h1', { timeout: 20000 });
  await sleep(500);
  await win.screenshot({ path: path.join(out, '1-start.png') });
  log('Startseite:', await win.textContent('#castHero h1'));

  const found = await discover();
  log('UDP-Suche:', found.name, 'Port', found.port, 'Protokoll', found.protocol);
  if (found.port !== PORT || found.type !== 'device') throw new Error('Falsche Antwort auf die Suche');

  const phone = new Phone(`ws://127.0.0.1:${PORT}/gxtube`);
  await phone.open();
  phone.send({ type: 'hello', name: 'Test-Handy', deviceId: 'smoke', app: 'GX Tube smoke', protocol: 1 });
  const welcome = await phone.waitFor((m) => m.type === 'welcome', 5000, 'welcome');
  log('Verbunden mit', welcome.name, welcome.version);
  await win.waitForSelector('#btnCast.connected', { timeout: 5000 });

  // Browser-Webseiten dürfen nicht steuern
  const blocked = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/gxtube`, { headers: { Origin: 'https://evil.example' } });
    ws.on('open', () => { ws.close(); resolve(false); });
    ws.on('error', () => resolve(true));
  });
  if (!blocked) throw new Error('Verbindung mit Origin-Header wurde nicht abgelehnt');
  log('Webseiten-Zugriff wird abgelehnt ✓');

  if (offline) {
    log('Offline-Modus: Wiedergabe übersprungen');
  } else {
    phone.send({ type: 'play', video: { id: VIDEO, title: '', channelName: '' } });
    await phone.waitFor((m) => m.type === 'state' && m.video?.id === VIDEO && m.status === 'loading', 10000, 'loading');
    log('Lädt …');
    const playing = await phone.waitFor((m) => m.type === 'state' && m.status === 'playing' && m.positionMs > 1500, 60000, 'playing');
    log('Spielt:', playing.video.title, '–', Math.round(playing.positionMs / 1000), 's von', Math.round(playing.durationMs / 1000), 's');
    await win.screenshot({ path: path.join(out, '2-playing.png') });

    phone.send({ type: 'pause' });
    const paused = await phone.waitFor((m) => m.type === 'state' && m.status === 'paused', 5000, 'paused');
    log('Pause bei', Math.round(paused.positionMs / 1000), 's');

    phone.send({ type: 'seek', positionMs: 60000 });
    const seeked = await phone.waitFor((m) => m.type === 'state' && Math.abs(m.positionMs - 60000) < 2500, 8000, 'seek');
    log('Gesprungen auf', Math.round(seeked.positionMs / 1000), 's');

    phone.send({ type: 'volume', value: 40 });
    await phone.waitFor((m) => m.type === 'state' && m.volume === 40, 5000, 'volume');
    log('Lautstärke 40 ✓');

    phone.send({ type: 'resume' });
    await phone.waitFor((m) => m.type === 'state' && m.status === 'playing', 15000, 'resume');
    await sleep(1500);
    await win.mouse.move(640, 400);
    await sleep(300);
    await win.screenshot({ path: path.join(out, '3-controls.png') });

    // Zweites Video: dasselbe noch einmal (aus Rechenzentren sperrt YouTube schnell weitere Videos)
    const second = process.env.SMOKE_VIDEO2 || VIDEO;
    phone.send({ type: 'add', video: { id: second, title: 'Zweites Video', channelName: '' } });
    const q = await phone.waitFor((m) => m.type === 'queue' && m.items.length === 2, 5000, 'queue');
    log('Warteschlange:', q.items.map((i) => i.title || i.id).join(' | '));

    phone.send({ type: 'next' });
    const next = await phone.waitFor((m) => m.type === 'state' && m.queueIndex === 1 && m.status === 'playing', 60000, 'next');
    log('Weiter →', next.video.title, 'Index', next.queueIndex);

    // Zurück: wie bei YouTube erst an den Anfang (Video läuft schon > 5 s), dann zum vorherigen
    phone.send({ type: 'previous' });
    const first = await phone.waitFor((m) => m.type === 'state' && (m.queueIndex === 0 || m.positionMs < 4000), 10000, 'previous');
    if (first.queueIndex !== 0) {
      log('Zurück → an den Anfang');
      phone.send({ type: 'previous' });
      await phone.waitFor((m) => m.type === 'state' && m.queueIndex === 0, 10000, 'previous 2');
    }
    log('Zurück zum ersten Video ✓');

    // Mini-Player beim Stöbern
    await win.keyboard.press('Escape');
    await sleep(500);
    await win.screenshot({ path: path.join(out, '4-mini.png') });
  }

  phone.send({ type: 'stop' });
  await phone.waitFor((m) => m.type === 'state' && m.status === 'idle', 5000, 'stop');
  log('Gestoppt ✓');

  if (!offline) {
    await win.fill('#searchInput', 'lofi hip hop');
    await win.press('#searchInput', 'Enter');
    await win.waitForFunction(() => document.querySelector('#searchGrid .card') || /fehlgeschlagen|Keine/.test(document.querySelector('#searchStatus').textContent), null, { timeout: 30000 });
    await sleep(1500);
    const status = await win.textContent('#searchStatus');
    log('Suche:', await win.locator('#searchGrid .card').count(), 'Ergebnisse', status ? `(${status})` : '');
    await win.screenshot({ path: path.join(out, '5-search.png') });
  }
  await win.click('#btnSettings');
  await win.waitForSelector('#settingsForm .set-row');
  await sleep(300);
  await win.screenshot({ path: path.join(out, '6-settings.png') });
  await win.click('#btnCast');
  await sleep(300);
  await win.screenshot({ path: path.join(out, '7-devices.png') });
  phone.close();
  await sleep(500);
} catch (err) {
  failed = true;
  console.error('✗', err.message);
  try { await (await app.firstWindow()).screenshot({ path: path.join(out, 'fehler.png') }); } catch {}
} finally {
  await app.close().catch(() => {});
  fs.rmSync(userData, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log('Alles in Ordnung ✓');
