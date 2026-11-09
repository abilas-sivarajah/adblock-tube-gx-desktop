// Prüft die YouTube-Oberfläche im echten Programm: Info-Leiste (Beschreibung, Kapitel, Kommentare),
// Untertitel, Vorschaubilder auf der Zeitleiste, Suchfilter, Playlists, "Entdecken" und SponsorBlock.
// Das Fenster bleibt unsichtbar und ohne Ton (stiehlt keinen Fokus); Bilder landen in test-e2e/out/.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test-e2e/out');
fs.mkdirSync(out, { recursive: true });
// Video mit Kapiteln, Untertiteln und Kommentaren (Lex Fridman Podcast)
const VIDEO = process.env.UI_VIDEO || 'ZAzWPE9CItg';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
const checks = [];
const check = (ok, what) => {
  checks.push([ok, what]);
  console.log(ok ? '  ✔' : '  ✘', what);
};

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gxtube-ui-'));
const app = await electron.launch({
  args: [root, '--no-sandbox', '--hidden', '--mute-audio'],
  cwd: root,
  env: { ...process.env, GXTUBE_USER_DATA: userData, GXTUBE_PORT: '18775', GXTUBE_DISCOVERY_PORT: '18776', GXTUBE_NO_UPDATES: '1' },
});
try {
  // Fenster nie zeigen und nie nach vorne holen – auch nicht, wenn ein Video startet
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.show = () => {};
      w.focus = () => {};
      w.moveTop = () => {};
      w.setFullScreen = () => {};
    }
  });
  const win = await app.firstWindow();
  win.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log('  [fenster]', m.text().slice(0, 300));
  });
  await win.setViewportSize({ width: 1400, height: 860 }).catch(() => {});
  await win.waitForSelector('#castHero h1', { timeout: 30000 });

  // ------------------------------------------------------------ Startseite: Entdecken
  log('Entdecken');
  await win.waitForFunction(() => document.querySelectorAll('#exploreGrid .card').length > 0, null, { timeout: 30000 }).catch(() => {});
  check((await win.locator('#exploreGrid .card').count()) > 0, 'Entdecken zeigt Gaming-Trends');
  await win.click('#exploreChips button:nth-child(2)');
  await win.waitForFunction(() => document.querySelectorAll('#exploreGrid .card').length > 0 && document.querySelector('#exploreChips button:nth-child(2)').classList.contains('active'), null, { timeout: 30000 }).catch(() => {});
  check((await win.locator('#exploreGrid .card').count()) > 0, 'Entdecken zeigt Live-Streams');
  await win.screenshot({ path: path.join(out, 'yt-1-home.png') });

  // ------------------------------------------------------------ Suche mit Filtern, Playlists
  log('Suche mit Filter "Playlists"');
  await win.fill('#searchInput', 'lofi hip hop');
  await win.press('#searchInput', 'Enter');
  await win.waitForSelector('#searchFilters .tw-chip', { timeout: 30000 });
  await win.click('#searchFilters .tw-chip:has-text("Playlists")');
  await win.waitForFunction(() => document.querySelectorAll('#searchGrid .card.playlist').length > 0, null, { timeout: 30000 }).catch(() => {});
  const playlists = await win.locator('#searchGrid .card.playlist').count();
  check(playlists > 0, `Suchfilter liefert Playlists (${playlists})`);
  await win.screenshot({ path: path.join(out, 'yt-2-search-playlists.png') });
  if (playlists) {
    await win.click('#searchGrid .card.playlist >> nth=0');
    await win.waitForFunction(() => document.querySelectorAll('#playlistGrid .card').length > 0, null, { timeout: 30000 }).catch(() => {});
    const items = await win.locator('#playlistGrid .card').count();
    check(items > 0, `Playlist-Seite mit ${items} Videos`);
    check((await win.locator('#playlistHead .playlist-actions .pill').count()) === 2, 'Knöpfe "Alle abspielen" und "Zufällig"');
    await win.screenshot({ path: path.join(out, 'yt-3-playlist.png') });
  }

  // ------------------------------------------------------------ Video: Info-Leiste, Kapitel, Untertitel
  log('Video', VIDEO);
  await win.evaluate((id) => window.gx.play({ id, title: '', channelName: '', channelId: null, thumbnail: null, durationSec: -1, isLive: false }, null), VIDEO);
  await win.waitForFunction(() => document.querySelector('#video').currentTime > 1, null, { timeout: 90000 });
  check(true, 'Video läuft');
  await win.waitForFunction(() => document.querySelectorAll('#seekChapters div').length > 0, null, { timeout: 30000 }).catch(() => {});
  const ticks = await win.locator('#seekChapters div').count();
  check(ticks > 0, `Kapitel-Striche auf der Zeitleiste (${ticks})`);
  check(!(await win.locator('#chapterLabel').isHidden()), `Kapitel neben der Zeit: ${await win.textContent('#chapterLabel')}`);
  check(!(await win.locator('#btnCaptions').isHidden()), 'Knopf "CC" für Untertitel');

  // Vorschaubild beim Überfahren der Zeitleiste
  await win.evaluate(() => {
    const seek = document.querySelector('#seek');
    seek.hidden = false;
    const r = seek.getBoundingClientRect();
    seek.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + r.width * 0.4, clientY: r.top + 5, bubbles: true }));
  });
  const preview = await win.evaluate(() => ({ hidden: document.querySelector('#seekPreview').hidden, bg: document.querySelector('#seekPreview').style.backgroundImage, chapter: document.querySelector('#seekChapter').textContent }));
  check(!preview.hidden && /i\.ytimg\.com\/sb\//.test(preview.bg), 'Vorschaubild aus dem Storyboard im Tooltip');
  check(Boolean(preview.chapter), `Kapitel im Tooltip: ${preview.chapter}`);
  await win.screenshot({ path: path.join(out, 'yt-4-seek-preview.png') });

  // Untertitel einschalten (Taste u) – die Spur muss Text haben
  await win.evaluate(() => document.querySelector('#watch').focus());
  await win.keyboard.press('u');
  await win.waitForFunction(() => [...document.querySelector('#video').textTracks].some((t) => t.mode === 'showing' || (t.cues && t.cues.length > 0)), null, { timeout: 30000 }).catch(() => {});
  const cues = await win.evaluate(() => Math.max(0, ...[...document.querySelector('#video').textTracks].map((t) => t.cues?.length ?? 0)));
  const shaka = await win.evaluate(() => document.querySelector('#btnCaptions').classList.contains('active'));
  check(shaka, 'Untertitel aktiv (CC markiert)');
  log('Untertitel-Cues im Video:', cues);

  // Info-Leiste mit Beschreibung, Kapiteln und Kommentaren
  await win.keyboard.press('i');
  await win.waitForSelector('#infoPanel:not([hidden]) .info-title', { timeout: 20000 });
  await win.waitForFunction(() => document.querySelectorAll('#infoComments .comment').length > 0, null, { timeout: 40000 }).catch(() => {});
  const info = await win.evaluate(() => ({
    title: document.querySelector('.info-title')?.textContent,
    chapters: document.querySelectorAll('.chapter-list .chapter').length,
    desc: document.querySelector('.info-desc')?.textContent.length ?? 0,
    links: document.querySelectorAll('.info-desc .rich-link, .info-desc .rich-time').length,
    comments: document.querySelectorAll('#infoComments .comment').length,
    likes: document.querySelector('.info-chips')?.textContent ?? '',
    channel: document.querySelector('.info-channel b')?.textContent,
  }));
  check(Boolean(info.title), `Info: Titel "${info.title?.slice(0, 50)}"`);
  check(info.chapters > 1, `Info: ${info.chapters} Kapitel`);
  check(info.desc > 100, `Info: Beschreibung (${info.desc} Zeichen, ${info.links} Links/Zeitstempel)`);
  check(info.comments > 0, `Info: ${info.comments} Kommentare`);
  check(Boolean(info.channel), `Info: Kanal ${info.channel}`);
  await win.screenshot({ path: path.join(out, 'yt-5-info.png') });

  // Kapitel anklicken springt dorthin
  await win.click('.chapter-list .chapter >> nth=2');
  await sleep(1500);
  const pos = await win.evaluate(() => document.querySelector('#video').currentTime);
  check(pos > 60, `Klick aufs dritte Kapitel springt (jetzt ${Math.round(pos)} s)`);

  // Antworten zu einem Kommentar
  const replyBtn = win.locator('#infoComments .comment-body > .link-btn:not([hidden])').first();
  if (await replyBtn.count()) {
    await replyBtn.click();
    await win.waitForFunction(() => document.querySelectorAll('#infoComments .comment.reply').length > 0, null, { timeout: 20000 }).catch(() => {});
    check((await win.locator('#infoComments .comment.reply').count()) > 0, 'Antworten auf einen Kommentar');
  }

  // Sortierung wechseln
  await win.click('.comments-head .pill');
  await win.waitForFunction(() => /Neueste/.test(document.querySelector('.comments-head .pill')?.textContent ?? '') && document.querySelectorAll('#infoComments .comment').length > 0, null, { timeout: 30000 }).catch(() => {});
  check(/Neueste/.test(await win.textContent('.comments-head .pill')), 'Kommentare: neueste zuerst');
  await win.screenshot({ path: path.join(out, 'yt-6-comments.png') });

  // ------------------------------------------------------------ SponsorBlock: Highlight, "ganzes Video", Rückgängig
  const SB_VIDEO = process.env.UI_SB_VIDEO || 'vDmjw-c_R2k';
  log('SponsorBlock', SB_VIDEO);
  await win.evaluate((id) => window.gx.play({ id, title: '', channelName: '', channelId: null, thumbnail: null, durationSec: -1, isLive: false }, null), SB_VIDEO);
  await win.waitForFunction(() => document.querySelector('#video').currentTime > 0.5, null, { timeout: 90000 });
  await win.waitForFunction(() => document.querySelectorAll('#seekSegments div').length > 0, null, { timeout: 30000 }).catch(() => {});
  const segs = await win.locator('#seekSegments div').count();
  check(segs > 0, `SponsorBlock-Abschnitte auf der Zeitleiste (${segs})`);
  check(!(await win.locator('#seekHighlight').isHidden()), 'Highlight-Markierung auf der Zeitleiste');
  await win.waitForFunction(() => /Gesponsert|Eigenwerbung|Exklusiv/.test(document.querySelector('.info-chips')?.textContent ?? ''), null, { timeout: 20000 }).catch(() => {});
  check(/Gesponsert|Eigenwerbung|Exklusiv/.test((await win.textContent('.info-chips').catch(() => '')) ?? ''), 'Hinweis "ganzes Video" in der Info-Leiste');
  await win.click('.info-chips .chip.action');
  await sleep(1500);
  const atHighlight = await win.evaluate(() => document.querySelector('#video').currentTime);
  check(atHighlight > 600, `Klick auf "Zum Highlight" springt (jetzt ${Math.round(atHighlight)} s)`);
  // In den ersten Sponsor-Abschnitt springen: wird übersprungen, "Rückgängig" holt ihn zurück
  const first = await win.evaluate(() => {
    const d = document.querySelector('#video').duration;
    const div = document.querySelector('#seekSegments div:not(.mute)');
    return div ? (parseFloat(div.style.left) / 100) * d : null;
  });
  if (first != null) {
    await win.evaluate((t) => { document.querySelector('#video').currentTime = t + 0.2; }, first);
    await win.waitForSelector('.toast-action', { timeout: 10000 }).catch(() => {});
    const after = await win.evaluate(() => document.querySelector('#video').currentTime);
    check(after > first + 1, `Sponsor ab ${Math.round(first)} s übersprungen (jetzt ${Math.round(after)} s)`);
    await win.click('.toast-action').catch(() => {});
    await sleep(1200);
    const back = await win.evaluate(() => document.querySelector('#video').currentTime);
    check(Math.abs(back - first) < 3, `"Rückgängig" springt zurück an den Anfang des Abschnitts (${Math.round(back)} s)`);
    await sleep(1500);
    const stays = await win.evaluate(() => document.querySelector('#video').currentTime);
    check(stays < first + 5, 'Nach "Rückgängig" wird nicht erneut übersprungen');
  }
  await win.screenshot({ path: path.join(out, 'yt-7-sponsorblock.png') });

  // ------------------------------------------------------------ Community: Dislikes und DeArrow (eingeschaltet)
  log('Return YouTube Dislike und DeArrow');
  // Wie ein Nutzer: Einstellungen öffnen und beide Schalter umlegen
  await win.keyboard.press('Escape');
  await win.click('#btnSettings');
  await win.waitForSelector('.set-row:has-text("DeArrow") input', { timeout: 10000 });
  await win.click('.set-row:has-text("DeArrow") .toggle');
  await win.click('.set-row:has-text("Dislikes anzeigen") .toggle');
  await sleep(500);
  check((await win.evaluate(() => window.gx.settings().then((s) => s.dearrow && s.returnDislike))) === true, 'DeArrow und Dislikes in den Einstellungen eingeschaltet');
  await win.evaluate((id) => window.gx.play({ id, title: '', channelName: '', channelId: null, thumbnail: null, durationSec: -1, isLive: false }, null), VIDEO);
  await win.waitForFunction(() => document.querySelectorAll('.info-chips .chip').length >= 2 && document.querySelector('.info-chips').innerHTML.includes('M15 3H6'), null, { timeout: 40000 }).catch(() => {});
  check((await win.evaluate(() => document.querySelector('.info-chips')?.innerHTML.includes('M15 3H6'))) === true, 'Dislike-Zahl in der Info-Leiste');
  // Für DeArrow eine Suche mit vielen Einreichungen (MrBeast)
  await win.keyboard.press('Escape');
  await win.fill('#searchInput', 'MrBeast');
  await win.press('#searchInput', 'Enter');
  await win.click('#searchFilters .tw-chip:has-text("Videos")');
  await win.waitForFunction(() => document.querySelectorAll('#searchGrid .card-title[title^="Original:"]').length > 0, null, { timeout: 30000 }).catch(() => {});
  const replaced = await win.locator('#searchGrid .card-title[title^="Original:"]').count();
  check(replaced > 0, `DeArrow ersetzt Titel in der Suche (${replaced})`);
  await win.screenshot({ path: path.join(out, 'yt-8-dearrow.png') });
} catch (err) {
  console.error('FEHLER:', err);
  checks.push([false, String(err?.message ?? err)]);
} finally {
  await app.close().catch(() => {});
  fs.rmSync(userData, { recursive: true, force: true });
}
const bad = checks.filter(([ok]) => !ok);
console.log(bad.length ? `\n${bad.length} von ${checks.length} Prüfungen fehlgeschlagen` : `\nAlle ${checks.length} Prüfungen bestanden`);
process.exit(bad.length ? 1 : 0);
