import { _electron as electron } from 'playwright-core';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import WebSocket from 'ws';
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-p-'));
const app = await electron.launch({ args: [process.cwd(), '--no-sandbox'], env: { ...process.env, GXTUBE_USER_DATA: ud, GXTUBE_PORT: '19785', GXTUBE_DISCOVERY_PORT: '19786', GXTUBE_NO_UPDATES: '1' } });
const win = await app.firstWindow();
await win.waitForSelector('#castHero h1');
// Zweiter Bildschirm rechts daneben (Testserver hat nur einen)
await app.evaluate(({ screen }) => {
  const real = screen.getAllDisplays()[0];
  const second = { ...real, id: 999, label: 'Test-Monitor 2', bounds: { x: 1280, y: 0, width: 1280, height: 900 }, workArea: { x: 1280, y: 0, width: 1280, height: 900 }, size: { width: 1280, height: 900 } };
  const first = { ...real, bounds: { x: 0, y: 0, width: 1280, height: 900 }, workArea: { x: 0, y: 0, width: 1280, height: 900 }, size: { width: 1280, height: 900 } };
  screen.getAllDisplays = () => [first, second];
  screen.getDisplayMatching = (b) => (b.x + b.width / 2 >= 1280 ? second : first);
});
const ws = new WebSocket('ws://127.0.0.1:19785/gxtube');
await new Promise((r) => ws.once('open', r));
let state = null;
ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'state') state = m; });
ws.send(JSON.stringify({ type: 'hello', name: 'Probe', protocol: 1 }));
await new Promise((r) => setTimeout(r, 800));
console.log('displays', JSON.stringify(state.displays), 'aktuell', state.displayId, 'vollbild', state.fullscreen);
ws.send(JSON.stringify({ type: 'fullscreen' }));
await new Promise((r) => setTimeout(r, 1500));
console.log('nach fullscreen:', state.fullscreen, await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible())?.isFullScreen()));
if (state.displays.length > 1) {
  const other = state.displays.find((d) => d.id !== state.displayId);
  ws.send(JSON.stringify({ type: 'display', id: other.id }));
  await new Promise((r) => setTimeout(r, 2500));
  console.log('nach display:', state.displayId, '(Ziel', other.id + ')', 'vollbild', state.fullscreen);
  console.log('bounds', JSON.stringify(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible())?.getBounds())));
}
ws.send(JSON.stringify({ type: 'fullscreen', on: false }));
await new Promise((r) => setTimeout(r, 1500));
console.log('nach aus:', state.fullscreen);
await app.close(); ws.close();
