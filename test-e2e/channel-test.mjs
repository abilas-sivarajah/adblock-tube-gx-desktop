// Kanäle und Abos durchspielen (braucht Internet):
// Suche → Kanalseite → mehr Videos laden → abonnieren → Startseite "Neu von deinen Abos"
// → Video abspielen → Kanalname im Player öffnet den Kanal → Abo beenden
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-channel-'));
const shots = process.env.SHOTS_DIR;
const shot = async (win, name) => shots && win.screenshot({ path: path.join(shots, name) });

const app = await electron.launch({
  args: [root, '--no-sandbox'],
  cwd: root,
  env: { ...process.env, GXTUBE_USER_DATA: ud, GXTUBE_PORT: '19875', GXTUBE_DISCOVERY_PORT: '19876', GXTUBE_NO_UPDATES: '1' },
});
const win = await app.firstWindow();
await win.waitForSelector('#castHero h1');

// Suche → Kanal
await win.fill('#searchInput', 'Rick Astley');
await win.press('#searchInput', 'Enter');
await win.waitForSelector('#searchGrid .card', { timeout: 30_000 });
if (await win.locator('#searchGrid .card.channel').count()) {
  await win.locator('#searchGrid .card.channel .card-title').first().click();
} else {
  await win.locator('#searchGrid .card-channel').first().click();
}
await win.waitForSelector('#view-channel.active #channelGrid .card', { timeout: 30_000 });
const name = await win.locator('#channelHead h1').textContent();
const meta = await win.locator('#channelHead .channel-meta').textContent().catch(() => '');
const first = await win.locator('#channelGrid .card').count();
console.log('[kanal]', name, '|', meta, '|', first, 'Videos');
await win.waitForFunction(() => [...document.querySelectorAll('#channelHead img')].every((i) => i.complete), null, { timeout: 15_000 }).catch(() => {});
assert.ok(name && name !== 'Kanal');
assert.ok(first > 5);
await shot(win, 'channel.png');

// Weiter unten: mehr Videos
await win.evaluate(() => {
  const v = document.getElementById('view-channel');
  v.scrollTop = v.scrollHeight;
});
await win.waitForFunction((n) => document.querySelectorAll('#channelGrid .card').length > n, first, { timeout: 30_000 });
console.log('[mehr]', await win.locator('#channelGrid .card').count(), 'Videos');
await win.evaluate(() => (document.getElementById('view-channel').scrollTop = 0));

// Abonnieren
const sub = win.locator('#channelHead .sub-btn');
assert.equal(await sub.textContent(), 'Abonnieren');
await sub.click();
await win.waitForFunction(() => document.querySelector('#channelHead .sub-btn')?.textContent === 'Abonniert');
console.log('[abo]', await win.locator('.toast').last().textContent());

// Startseite: neue Videos der Abos
await win.click('#btnHome');
await win.waitForSelector('#shelfSubs:not([hidden]) #subsGrid .card', { timeout: 30_000 });
await win.waitForFunction(() => [...document.querySelectorAll('#subsGrid img')].slice(0, 3).every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15_000 }).catch(() => {});
console.log('[startseite]', await win.locator('#subChips .sub-chip').count(), 'Kanal,', await win.locator('#subsGrid .card').count(), 'neue Videos');
await shot(win, 'home-subs.png');

// Video abspielen → Kanalname im Player führt zum Kanal
await win.evaluate(() => window.gx.play({ id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', channelName: '', thumbnail: null, durationSec: 213, isLive: false }));
await win.waitForSelector('#vChannel.link', { timeout: 60_000 });
await shot(win, 'player.png');
await win.click('#vChannel');
await win.waitForSelector('#view-channel.active #channelGrid .card', { timeout: 30_000 });
assert.equal(await win.evaluate(() => document.getElementById('watch').classList.contains('mini')), true, 'Video läuft im Mini-Player weiter');
console.log('[aus dem Player]', await win.locator('#channelHead h1').textContent());
await shot(win, 'channel-from-player.png');

// Abo beenden
await win.locator('#channelHead .sub-btn').click();
await win.waitForFunction(() => document.querySelector('#channelHead .sub-btn')?.textContent === 'Abonnieren');
await win.click('#btnHome');
await win.waitForSelector('#shelfSubs', { state: 'hidden' });

await app.close();
console.log('Kanal-Test bestanden');
