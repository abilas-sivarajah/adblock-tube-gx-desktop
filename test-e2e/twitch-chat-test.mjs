// Twitch-Chat und Clips im Fenster (braucht Internet): Chat mit Verlauf, Abzeichen, Profilkarte,
// /-Vorschläge und @-Ergänzung, Clips-Reiter auf der Kanalseite, Clip abspielen, Chat-Wiedergabe beim VOD.
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-twchat-'));
const shots = process.env.SHOTS_DIR;
const shot = async (win, name) => shots && win.screenshot({ path: path.join(shots, name) });

const app = await electron.launch({
  args: [root, '--no-sandbox'],
  cwd: root,
  env: { ...process.env, GXTUBE_USER_DATA: ud, GXTUBE_PORT: '19895', GXTUBE_DISCOVERY_PORT: '19896', GXTUBE_NO_UPDATES: '1' },
});
const logs = [];
app.process().stderr.on('data', (d) => logs.push(String(d)));
app.process().stdout.on('data', (d) => logs.push(String(d)));
const win = await app.firstWindow();
win.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[fenster] ${m.text()}`);
});
win.on('pageerror', (e) => logs.push(`[fehler] ${e.message}`));
/** Bilder, die nicht geladen werden konnten (Adressen). */
const brokenImages = (w, sel) => w.evaluate((s) => [...document.querySelectorAll(`${s} img`)].filter((i) => i.complete && i.naturalWidth === 0 && i.src).map((i) => i.src.slice(0, 90)), sel);
await win.setViewportSize({ width: 1400, height: 860 }).catch(() => {});
await win.waitForSelector('#castHero h1');
try {
  await win.click('#platformSwitch [data-platform="twitch"]');
  await win.waitForSelector('#view-twhome.active #twPopularGrid .tw-card', { timeout: 30_000 });

  // ---- Live-Stream: Chat mit Verlauf und Abzeichen
  const first = win.locator('#twPopularGrid .tw-card').first();
  const login = (await first.getAttribute('data-id')).slice(7);
  await first.locator('.thumb').click();
  await win.waitForTimeout(1500);
  await win.keyboard.press('c');
  await win.waitForSelector('#chatPanel:not([hidden])');
  await win.waitForFunction(() => document.querySelectorAll('#chatList .chat-line.history').length >= 10, null, { timeout: 30_000 });
  await win.waitForFunction(() => document.querySelectorAll('#chatList .chat-line:not(.system):not(.history)').length >= 2, null, { timeout: 45_000 }).catch(() => {});
  const stats = await win.evaluate(() => ({
    history: document.querySelectorAll('#chatList .chat-line.history').length,
    live: document.querySelectorAll('#chatList .chat-line:not(.system):not(.history)').length,
    badgeImgs: document.querySelectorAll('#chatList .chat-badge-img').length,
    mentions: document.querySelectorAll('#chatList .chat-mention').length,
    room: document.getElementById('chatRoom').textContent,
    sub: document.getElementById('chatSub').textContent,
  }));
  console.log('[chat]', login, stats);
  assert.ok(stats.history >= 10, 'Verlauf fehlt');
  await shot(win, 'chat-live.png');

  // ---- Profilkarte: Nachricht anklicken
  await win.locator('#chatList .chat-line[data-login]').last().click({ position: { x: 30, y: 8 } });
  await win.waitForSelector('#chatCard:not([hidden])');
  await win.waitForFunction(() => /Konto erstellt am/.test(document.querySelector('#chatCard .head small')?.textContent ?? ''), null, { timeout: 20_000 });
  const card = await win.evaluate(() => ({ head: document.querySelector('#chatCard .head').textContent, actions: [...document.querySelectorAll('#chatCard .actions button')].map((b) => b.textContent) }));
  console.log('[profilkarte]', card);
  assert.ok(card.actions.includes('Kanal öffnen'));
  await shot(win, 'chat-card.png');
  await win.click('#chatCard .close');
  assert.equal(await win.locator('#chatCard').isHidden(), true);

  // ---- Eingabe (ohne Konto ausgeblendet – für den Test einblenden): /-Vorschläge und @-Ergänzung
  await win.evaluate(() => (document.getElementById('chatForm').hidden = false));
  await win.click('#chatInput');
  await win.keyboard.type('/');
  await win.waitForSelector('#chatSuggest:not([hidden]) li');
  const cmds = await win.locator('#chatSuggest li b').allTextContents();
  console.log('[befehle]', cmds.length, cmds.slice(0, 8).join(' '));
  assert.ok(cmds.some((c) => c.startsWith('/me')) && cmds.some((c) => c.startsWith('/color')));
  assert.ok(!cmds.some((c) => c.startsWith('/ban')), 'Ohne Mod-Rechte keine Mod-Befehle');
  await shot(win, 'chat-commands.png');
  await win.keyboard.type('co');
  await win.keyboard.press('Tab');
  assert.equal(await win.inputValue('#chatInput'), '/color ');
  await win.fill('#chatInput', '');
  const someone = await win.evaluate(() => [...document.querySelectorAll('#chatList .chat-line[data-login]')].at(-1)?.dataset.login);
  await win.keyboard.type(`@${someone.slice(0, 2)}`);
  await win.waitForSelector('#chatSuggest:not([hidden]) li');
  const users = await win.locator('#chatSuggest li').allTextContents();
  console.log('[@-vorschläge]', users.slice(0, 5).join(' '));
  assert.ok(users.length >= 1);
  await win.keyboard.press('Tab');
  assert.match(await win.inputValue('#chatInput'), /^@\S+ $/);
  await shot(win, 'chat-mention.png');
  // Emote-Auswahl öffnet
  await win.click('#chatEmoteBtn');
  await win.waitForSelector('#chatEmotes:not([hidden])');
  console.log('[emote-auswahl]', (await win.locator('#chatEmotes').textContent()).slice(0, 80));
  await win.click('#chatEmoteBtn');
  await win.fill('#chatInput', '');
  await win.evaluate(() => document.getElementById('chatInput').blur());

  // ---- Kanalseite: Clips
  await win.click('#vChannel');
  await win.waitForSelector('#view-twchannel.active #twChannelTabs', { timeout: 30_000 });
  await win.locator('#twChannelTabs button', { hasText: 'Clips' }).click();
  await win.locator('.clip-periods button', { hasText: 'Alle' }).click();
  await win.waitForSelector('#twChannelGrid .tw-card[data-id^="twitch-clip:"]', { timeout: 30_000 });
  const clips = await win.locator('#twChannelGrid .tw-card').count();
  console.log('[clips]', clips);
  await win.waitForTimeout(2500);
  console.log('[clip-bilder kaputt]', await brokenImages(win, '#twChannelGrid'));
  await shot(win, 'channel-clips.png');
  await win.locator('#twChannelGrid .tw-card .thumb').first().click();
  await win.waitForFunction(() => document.getElementById('video').currentTime > 2, null, { timeout: 60_000 });
  const cv = await win.evaluate(() => ({ h: document.getElementById('video').videoHeight, t: document.getElementById('video').currentTime }));
  console.log('[clip läuft]', cv);
  assert.ok(cv.h >= 360);
  await win.keyboard.press('i');
  await win.waitForSelector('#infoPanel:not([hidden])');
  await win.waitForTimeout(800);
  console.log('[clip-info]', (await win.locator('#infoPanel').textContent()).replace(/\s+/g, ' ').slice(0, 160));
  await shot(win, 'clip-playing.png');

  // ---- VOD: Chat-Wiedergabe
  const hasVod = await win.evaluate(() => Boolean([...document.querySelectorAll('#infoPanel button')].find((b) => b.textContent === 'Ganzen Stream ansehen')));
  if (hasVod) {
    await win.locator('#infoPanel button', { hasText: 'Ganzen Stream ansehen' }).click();
    await win.waitForFunction(() => document.getElementById('video').currentTime > 60, null, { timeout: 60_000 });
    console.log('[vod ab clip-stelle]', await win.evaluate(() => Math.round(document.getElementById('video').currentTime)), 's');
    // Chat ist noch offen (letzte Wahl wird gemerkt) – sonst einblenden
    await win.waitForTimeout(500);
    if (await win.locator('#chatPanel').isHidden()) await win.click('#btnChat');
    await win.waitForSelector('#chatPanel:not([hidden])');
    await win.waitForFunction(() => document.getElementById('chatTitle').textContent === 'Chat-Wiedergabe');
    await win.waitForFunction(() => document.querySelectorAll('#chatList .chat-line:not(.system)').length >= 3, null, { timeout: 45_000 });
    console.log('[chat-wiedergabe]', await win.locator('#chatList .chat-line:not(.system)').count(), 'Nachrichten |', await win.locator('#chatSub').textContent());
    await shot(win, 'vod-replay.png');
  } else {
    // Clip ohne VOD: erstes VOD des Kanals, an Minute 10
    await win.click('#vChannel');
    await win.waitForSelector('#view-twchannel.active #twChannelTabs', { timeout: 30_000 });
    await win.locator('#twChannelTabs button', { hasText: 'Videos' }).click();
    await win.waitForSelector('#twChannelGrid .tw-card[data-id^="twitch-vod:"]', { timeout: 30_000 });
    await win.locator('#twChannelGrid .tw-card .thumb').first().click();
    const plays = await win.waitForFunction(() => document.getElementById('video').currentTime > 1, null, { timeout: 30_000 }).then(() => true, () => false);
    if (plays) {
      await win.evaluate(() => (document.getElementById('video').currentTime = 600));
      await win.waitForFunction(() => document.getElementById('video').currentTime > 602, null, { timeout: 60_000 });
    } else {
      // Video-CDN nicht erreichbar (z. B. gesperrtes Netz): Stelle 10:00 vortäuschen – der Chat kommt von gql.twitch.tv
      console.log('[vod] Video lädt hier nicht – Stelle wird vorgetäuscht');
      await win.evaluate(() => Object.defineProperty(document.getElementById('video'), 'currentTime', { configurable: true, get: () => 600, set: () => {} }));
    }
    // Chat ist noch offen (letzte Wahl wird gemerkt) – sonst einblenden
    await win.waitForTimeout(500);
    if (await win.locator('#chatPanel').isHidden()) await win.click('#btnChat');
    await win.waitForSelector('#chatPanel:not([hidden])');
    await win.waitForFunction(() => document.getElementById('chatTitle').textContent === 'Chat-Wiedergabe');
    await win.waitForFunction(() => document.querySelectorAll('#chatList .chat-line:not(.system)').length >= 3, null, { timeout: 45_000 });
    const r = await win.evaluate(() => ({ n: document.querySelectorAll('#chatList .chat-line:not(.system)').length, badges: document.querySelectorAll('#chatList .chat-badge-img').length, t: Math.round(document.getElementById('video').currentTime), sub: document.getElementById('chatSub').textContent }));
    console.log('[chat-wiedergabe]', r);
    await win.waitForTimeout(3000);
    console.log('[bilder kaputt]', await brokenImages(win, '#chatList'));
    await shot(win, 'vod-replay.png');
  }
  console.log('OK');
} catch (err) {
  console.error(err);
  await shot(win, 'fehler.png');
  console.error(logs.slice(-40).join('\n'));
  process.exitCode = 1;
} finally {
  const errs = logs.filter((l) => /\[fehler\]/.test(l));
  if (errs.length) console.log('Seitenfehler:', errs.join('\n'));
  await app.close();
}
