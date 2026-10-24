// Twitch durchspielen (braucht Internet):
// Umschalter → Twitch-Startseite → Live-Stream mit Werbeblocker und Chat → Qualität → Kategorie
// → Suche → Kanal folgen → VOD abspielen → Anmeldung per Code (ohne echtes Konto)
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-twitch-'));
const shots = process.env.SHOTS_DIR;
const shot = async (win, name) => shots && win.screenshot({ path: path.join(shots, name) });

const app = await electron.launch({
  args: [root, '--no-sandbox'],
  cwd: root,
  env: { ...process.env, GXTUBE_USER_DATA: ud, GXTUBE_PORT: '19885', GXTUBE_DISCOVERY_PORT: '19886', GXTUBE_NO_UPDATES: '1' },
});
const logs = [];
app.process().stderr.on('data', (d) => logs.push(String(d)));
app.process().stdout.on('data', (d) => logs.push(String(d)));
const win = await app.firstWindow();
win.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[fenster] ${m.text()}`);
});
await win.waitForSelector('#castHero h1');
try {
  // Werbeblocker ist vor Shaka geladen
  assert.equal(await win.evaluate(() => window.__abTwitchWorker === true), true, 'Werbeblocker nicht geladen');

  // ---- Startseite
  await win.click('#platformSwitch [data-platform="twitch"]');
  await win.waitForSelector('#view-twhome.active #twPopularGrid .tw-card', { timeout: 30_000 });
  await win.waitForSelector('#twGamesGrid .tw-game-card');
  const popular = await win.locator('#twPopularGrid .tw-card').count();
  console.log('[startseite]', popular, 'Streams,', await win.locator('#twGamesGrid .tw-game-card').count(), 'Kategorien');
  assert.ok(popular >= 10);
  await win.waitForFunction(() => [...document.querySelectorAll('#twPopularGrid img')].slice(0, 4).every((i) => i.complete), null, { timeout: 15_000 }).catch(() => {});
  await shot(win, 'twitch-home.png');
  // Merkt sich die Wahl
  assert.equal((await win.evaluate(() => window.gx.settings())).platform, 'twitch');

  // ---- Live-Stream
  const first = win.locator('#twPopularGrid .tw-card').first();
  const login = (await first.getAttribute('data-id')).slice(7);
  await first.locator('.thumb').click();
  await win.waitForFunction(() => document.getElementById('video').currentTime > 3, null, { timeout: 60_000 });
  const v = await win.evaluate(() => ({ h: document.getElementById('video').videoHeight, t: document.getElementById('video').currentTime }));
  console.log('[live]', login, v, '|', await win.locator('#vChannel').textContent());
  assert.ok(v.h >= 360, 'kein Bild');
  // Chat liest mit
  await win.waitForSelector('#chatPanel:not([hidden])');
  await win.waitForFunction(() => document.querySelectorAll('#chatList .chat-line:not(.system)').length >= 3, null, { timeout: 45_000 }).catch(() => {});
  const lines = await win.locator('#chatList .chat-line:not(.system)').count();
  console.log('[chat]', lines, 'Nachrichten,', await win.locator('#chatList .chat-emote').count(), 'Emotes |', await win.locator('#chatSub').textContent());
  assert.ok(lines >= 1, 'Chat zeigt nichts');
  assert.equal(await win.locator('#chatLogin').isVisible(), true, 'Ohne Konto: Hinweis zum Anmelden');
  await shot(win, 'twitch-live.png');
  // Qualität: Twitch-Stufen, ohne "nur Ton"
  await win.mouse.move(400, 400);
  await win.click('#btnQuality');
  const quality = await win.locator('#menu button').allTextContents();
  const note = await win.locator('#menu .menu-note').textContent();
  console.log('[qualität]', quality.join(' | '), '|', note.replace(/\n/g, ' / '));
  assert.ok(quality.some((q) => /^.?\d{3,4}p/.test(q)));
  assert.ok(/Werbeblocker aktiv/.test(note));
  await shot(win, 'twitch-quality.png');
  await win.keyboard.press('Escape');
  // Chat ein-/ausblenden
  await win.keyboard.press('c');
  assert.equal(await win.locator('#chatPanel').isHidden(), true);
  await win.keyboard.press('c');
  assert.equal(await win.locator('#chatPanel').isVisible(), true);

  // ---- Kanalname im Player → Kanalseite, folgen
  await win.click('#vChannel');
  await win.waitForSelector('#view-twchannel.active #twChannelHead h1', { timeout: 30_000 });
  await win.waitForSelector('#twChannelLive .tw-card', { timeout: 30_000 });
  console.log('[kanal]', await win.locator('#twChannelHead h1').textContent(), '|', await win.locator('#twChannelHead .channel-meta').textContent(), '|', await win.locator('#twChannelGrid .tw-card').count(), 'VODs');
  assert.equal(await win.evaluate(() => document.getElementById('watch').classList.contains('mini')), true, 'Stream läuft im Mini-Player weiter');
  await win.locator('#twChannelHead .tw-follow').click();
  await win.waitForFunction(() => document.querySelector('#twChannelHead .tw-follow')?.textContent === 'Folge ich');
  await shot(win, 'twitch-channel.png');
  await win.click('#btnHome');
  await win.waitForSelector('#twShelfFollowed:not([hidden]) #twFollowedGrid .tw-card', { timeout: 30_000 });
  console.log('[gefolgt]', await win.locator('#twFollowedHint').textContent());

  // ---- Kategorie
  await win.locator('#twGamesGrid .tw-game-card').first().click();
  await win.waitForSelector('#view-twcategory.active #twCategoryGrid .tw-card', { timeout: 30_000 });
  const inCat = await win.locator('#twCategoryGrid .tw-card').count();
  await win.evaluate(() => {
    const v = document.getElementById('view-twcategory');
    v.scrollTop = v.scrollHeight;
  });
  await win.waitForFunction((n) => document.querySelectorAll('#twCategoryGrid .tw-card').length > n, inCat, { timeout: 20_000 }).catch(() => {});
  console.log('[kategorie]', await win.locator('#twCategoryHead h1').textContent(), inCat, '→', await win.locator('#twCategoryGrid .tw-card').count(), 'Streams');
  await shot(win, 'twitch-category.png');

  // ---- Suche
  await win.fill('#searchInput', 'montanablack88');
  await win.press('#searchInput', 'Enter');
  await win.waitForSelector('#view-twsearch.active #twSearchChannels .card', { timeout: 30_000 });
  console.log('[suche]', (await win.locator('#twSearchChannels .card-title').allTextContents()).slice(0, 4).join(', '));
  await shot(win, 'twitch-search.png');

  // ---- VOD: Kanal mit Videos öffnen und eins abspielen
  await win.locator('#twSearchChannels .card', { hasText: 'MontanaBlack88' }).first().click();
  await win.waitForSelector('#view-twchannel.active #twChannelGrid .tw-card', { timeout: 30_000 });
  const vodCard = win.locator('#twChannelGrid .tw-card').first();
  const vodTitle = await vodCard.locator('.card-title').textContent();
  await vodCard.locator('.thumb').click();
  // Erst wenn das VOD wirklich läuft (vorher spielt noch der Live-Stream im Mini-Player)
  await win.waitForFunction(
    (t) => {
      const v = document.getElementById('video');
      return document.getElementById('vTitle').textContent === t && v.currentTime > 2 && Number.isFinite(v.duration) && v.duration < 1e6 && !v.paused;
    },
    vodTitle,
    { timeout: 60_000 },
  );
  const before = await win.evaluate(() => document.getElementById('video').currentTime);
  // Spulen geht
  await win.keyboard.press('l');
  await win.waitForTimeout(1500);
  const vod = await win.evaluate(() => ({ t: Math.round(document.getElementById('video').currentTime), d: Math.round(document.getElementById('video').duration), h: document.getElementById('video').videoHeight }));
  console.log('[vod]', vod, '| Chat:', await win.locator('#chatPanel').isVisible() ? 'an' : 'aus');
  assert.ok(vod.d > 60 && vod.t >= before + 8 && vod.t < 120, 'VOD läuft nicht von vorne oder spult nicht');
  assert.equal(await win.locator('#seek').isVisible(), true, 'Spulleiste fehlt');
  await shot(win, 'twitch-vod.png');
  await win.evaluate(() => window.gx.stop());

  // ---- Vom Handy streamen (GX-Protokoll): Twitch-Stream an den PC schicken
  const phone = new WebSocket('ws://127.0.0.1:19885/gxtube');
  const states = [];
  await new Promise((resolve, reject) => {
    phone.once('open', resolve);
    phone.once('error', reject);
  });
  phone.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.type === 'state') states.push(m);
  });
  phone.send(JSON.stringify({ type: 'hello', name: 'Test-Handy', deviceId: 'twitch-test', app: 'test', protocol: 1 }));
  phone.send(JSON.stringify({ type: 'play', video: { id: `twitch:${login}`, title: '', channelName: '' } }));
  await win.waitForFunction(() => document.getElementById('video').currentTime > 2 && document.getElementById('watch').classList.contains('full'), null, { timeout: 60_000 });
  for (let i = 0; i < 20 && !states.some((m) => m.status === 'playing' && m.video?.platform === 'twitch'); i++) await new Promise((r) => setTimeout(r, 500));
  const st = states.findLast((m) => m.video?.platform === 'twitch');
  console.log('[handy]', st?.status, st?.video?.id, st?.video?.title?.slice(0, 40), '| live:', st?.isLive);
  assert.equal(st?.isLive, true);
  assert.ok(st.video.title, 'Titel fürs Handy nachgetragen');
  phone.send(JSON.stringify({ type: 'stop' }));
  phone.close();

  // ---- Anmeldung per Code
  await win.click('#btnSettings');
  await win.waitForSelector('#twitchAccountRow');
  const row = win.locator('#twitchAccountRow');
  assert.match(await row.textContent(), /Nicht angemeldet/);
  await row.locator('button', { hasText: 'Mit dem Handy anmelden' }).click();
  await win.waitForSelector('#twitchDialog:not([hidden]) .device-code', { timeout: 30_000 });
  const code = (await win.locator('#twitchDialog .device-code').textContent()).trim();
  console.log('[code]', code.replace(/[A-Z0-9]/g, 'X'), '|', await win.locator('#twitchBody ol').first().textContent());
  assert.match(code, /^[A-Z0-9]{6,10}$/);
  await shot(win, 'twitch-code.png');
  // Lieber im Fenster: twitch.tv/activate mit vorausgefülltem Code
  await win.locator('#twitchBody button', { hasText: 'Lieber hier am PC anmelden' }).click();
  let page = null;
  for (let i = 0; i < 100 && !page; i++) {
    page = app.windows().find((p) => /twitch\.tv\/activate/.test(p.url())) ?? null;
    if (!page) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(page, 'Anmeldefenster nicht gefunden');
  console.log('[fenster]', page.url().replace(code, 'CODE'));
  assert.ok(page.url().includes(`device-code=${code}`));
  await page.waitForTimeout(4000);
  if (shots) await page.screenshot({ path: path.join(shots, 'twitch-activate.png') }).catch(() => {});
  await win.locator('#twitchBody button', { hasText: 'Abbrechen' }).click();
  await win.waitForSelector('#twitchDialog', { state: 'hidden' });
  await win.waitForFunction(() => true);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(app.windows().some((p) => /twitch\.tv/.test(p.url())), false, 'Anmeldefenster bleibt offen');

  // Zurück zu YouTube
  await win.click('#platformSwitch [data-platform="youtube"]');
  await win.waitForSelector('#view-home.active');
  console.log('Twitch-Test bestanden');
} catch (err) {
  console.log(logs.join('').split('\n').filter((l) => /twitch|Twitch|fenster|Fehler|error/i.test(l)).slice(-40).join('\n'));
  await shot(win, 'twitch-failure.png').catch(() => {});
  throw err;
} finally {
  await app.close();
}
