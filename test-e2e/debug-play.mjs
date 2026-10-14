// Fehlersuche: Video wie vom Handy abspielen und alle fehlgeschlagenen googlevideo-Anfragen zeigen.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIDEO = process.argv[2] || 'VpkqL98Ualo';
const SECONDS = Number(process.argv[3] || 60);
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-debug-'));
const app = await electron.launch({ args: [root, '--no-sandbox'], cwd: root, env: { ...process.env, GXTUBE_USER_DATA: ud, GXTUBE_PORT: '19765', GXTUBE_DISCOVERY_PORT: '19766', GXTUBE_NO_UPDATES: '1' } });
app.process().stderr.on('data', (d) => { const t = String(d); if (/Stream-Fehler|\[stream\]/.test(t)) process.stdout.write('[main] ' + t.slice(0, 600)); });
const win = await app.firstWindow();
win.on('console', (m) => { if (m.type() !== 'log') console.log('[fenster]', m.type(), m.text().slice(0, 500)); });
win.on('response', (r) => { if (r.url().includes('googlevideo') && r.status() >= 400) console.log('[http]', r.status(), r.url().replace(/\?.*?(itag=\d+).*?(range=[\d-]+)?.*/, '?$1 $2').slice(0, 160)); });
win.on('requestfailed', (r) => { if (r.url().includes('googlevideo')) console.log('[failed]', r.failure()?.errorText, 'c=' + new URL(r.url()).searchParams.get('c')); });
await win.waitForSelector('#castHero h1');
// BLOCK_CLIENT=IOS: nach 8 s alle Video-Anfragen dieses Clients abweisen (simuliert YouTubes Sperre)
if (process.env.BLOCK_CLIENT) {
  await app.evaluate(({ session }, client) => {
    const since = Date.now() + 8000;
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*.googlevideo.com/*'] }, (d, cb) => {
      cb({ cancel: Date.now() > since && new URL(d.url).searchParams.get('c') === client });
    });
  }, process.env.BLOCK_CLIENT);
  console.log('[test] blockiere', process.env.BLOCK_CLIENT, 'ab 8 s');
}
const ws = new WebSocket('ws://127.0.0.1:19765/gxtube');
await new Promise((r) => ws.once('open', r));
let last = '';
let lastPos = 0;
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type !== 'state') return;
  const line = `${m.status} ${Math.round(m.positionMs / 1000)}s/${Math.round(m.durationMs / 1000)}s buf=${Math.round(m.bufferedMs / 1000)}s ${m.error ?? ''}`;
  if (line.split(' ')[0] !== last.split(' ')[0] || m.error) console.log('[state]', line);
  if (m.status === 'playing' && Math.floor(m.positionMs / 10000) !== Math.floor(lastPos / 10000)) console.log('[pos]', Math.round(m.positionMs / 1000) + 's');
  lastPos = m.positionMs;
  last = line;
});
ws.send(JSON.stringify({ type: 'hello', name: 'Debug', protocol: 1 }));
await new Promise((r) => setTimeout(r, 500));
ws.send(JSON.stringify({ type: 'play', video: { id: VIDEO } }));
await new Promise((r) => setTimeout(r, SECONDS * 1000));
console.log('[ende]', last);
await win.screenshot({ path: path.join(root, 'test-e2e/out/debug.png') });
await app.close();
fs.rmSync(ud, { recursive: true, force: true });
