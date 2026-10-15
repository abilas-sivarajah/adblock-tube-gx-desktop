// Google-Anmeldung durchspielen (ohne echtes Konto):
// 1. "Mit dem Handy anmelden" holt einen echten Code von Google und zeigt ihn an; Abbrechen schließt
//    "Hier im Fenster" öffnet Googles Anmeldeseite ohne Electron-Kennung
// 2. Mit (unechten) Konto-Cookies und gesperrten anonymen Anfragen wird das Konto benutzt
// 3. Mit (unechten) Tokens vom Handy ebenso – Google lehnt sie ab → "Anmeldung abgelaufen"
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-account-'));
const shots = process.env.SHOTS_DIR;
const env = { ...process.env, GXTUBE_USER_DATA: ud, GXTUBE_PORT: '19865', GXTUBE_DISCOVERY_PORT: '19866', GXTUBE_NO_UPDATES: '1' };

async function launch() {
  const app = await electron.launch({ args: [root, '--no-sandbox'], cwd: root, env });
  const logs = [];
  const collect = (d) => logs.push(String(d));
  app.process().stderr.on('data', collect);
  app.process().stdout.on('data', collect);
  const win = await app.firstWindow();
  await win.waitForSelector('#castHero h1');
  return { app, win, logs };
}

async function openSettings(win) {
  await win.click('#btnSettings');
  await win.waitForSelector('#accountRow');
  return win.locator('#accountRow');
}

// ---- 1. Anmeldefenster
{
  const { app, win } = await launch();
  const row = await openSettings(win);
  assert.match(await row.textContent(), /Nicht angemeldet/);
  await row.scrollIntoViewIfNeeded();
  if (shots) await win.screenshot({ path: path.join(shots, 'settings-logged-out.png') });

  // Code fürs Handy
  await row.locator('button', { hasText: 'Mit dem Handy anmelden' }).click();
  await win.waitForSelector('#signInDialog:not([hidden]) .device-code', { timeout: 30_000 });
  const code = (await win.locator('.device-code').textContent()).trim();
  const steps = await win.locator('#signInBody ol').first().textContent();
  console.log('[code]', code.replace(/[A-Z0-9]/g, 'X'), '|', steps);
  assert.match(code, /^[A-Z0-9]{3,5}(-[A-Z0-9]{3,5})+$/);
  assert.match(steps, /google\.com\/device/);
  if (shots) await win.screenshot({ path: path.join(shots, 'device-code.png') });
  await win.locator('#signInBody button', { hasText: 'Abbrechen' }).click();
  await win.waitForSelector('#signInDialog', { state: 'hidden' });

  // Anmeldefenster
  await row.locator('button', { hasText: 'Hier im Fenster' }).click();
  // (das unsichtbare BotGuard-Fenster ist auch ein Fenster – also nach der Adresse suchen)
  let login = null;
  for (let i = 0; i < 150 && !login; i++) {
    login = app.windows().find((p) => /^https:\/\/accounts\.google\.com\//.test(p.url())) ?? null;
    if (!login) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(login, 'Anmeldefenster nicht gefunden');
  await login.waitForLoadState('domcontentloaded');
  const url = login.url();
  const ua = await login.evaluate(() => navigator.userAgent);
  console.log('[login]', url.slice(0, 80), '|', ua);
  assert.match(url, /^https:\/\/accounts\.google\.com\//);
  assert.doesNotMatch(ua, /Electron|GX ?Tube|gxtube/i);
  await row.locator('button', { hasText: 'Anmeldefenster ist offen' }).waitFor();
  await login.waitForTimeout(3000);
  if (shots) await login.screenshot({ path: path.join(shots, 'google-login.png') });
  await login.close();
  await row.locator('button', { hasText: 'Hier im Fenster' }).waitFor();
  assert.match(await row.textContent(), /Nicht angemeldet/);
  await app.close();
}

// ---- 2. Angemeldet (unechte Cookies), anonyme Player-Anfragen gesperrt
fs.writeFileSync(path.join(ud, 'account.json'), JSON.stringify({ since: Date.now(), name: 'Test Konto', photo: null }));
{
  const { app, win, logs } = await launch();
  await app.evaluate(async ({ session }) => {
    const s = session.fromPartition('persist:gx-google');
    for (const name of ['SAPISID', '__Secure-3PAPISID', 'SID', 'HSID', 'SSID', 'APISID']) {
      await s.cookies.set({ url: 'https://www.youtube.com', domain: '.youtube.com', name, value: 'test-' + name, secure: true, expirationDate: Date.now() / 1000 + 3600 });
    }
    // Anonym (Standard-Profil) liefert YouTube keine Videos mehr – wie bei einer Bot-Sperre
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://www.youtube.com/youtubei/v1/player*'] }, (_d, cb) => cb({ cancel: true }));
  });
  const row = await openSettings(win);
  assert.match(await row.textContent(), /Angemeldet als Test Konto/);
  assert.equal(await row.locator('button').textContent(), 'Abmelden');
  await row.scrollIntoViewIfNeeded();
  if (shots) await win.screenshot({ path: path.join(shots, 'settings-logged-in.png') });

  await win.evaluate(() => window.gx.play({ id: 'dQw4w9WgXcQ', title: 'Test', channelName: '', thumbnail: null, durationSec: 213, isLive: false }));
  // Mit unechten Cookies scheitert auch das Konto – aber es muss probiert worden sein
  await win.waitForSelector('#errorBox:not([hidden])', { timeout: 90_000 });
  const reasons = await win.locator('#errorReasons li').allTextContents();
  console.log('[gründe]', reasons.join(' | '));
  console.log('[meldung]', await win.locator('#errorText').textContent());
  assert.ok(reasons.some((r) => r.startsWith('Konto')), 'Konto wurde nicht benutzt');
  if (shots) await win.screenshot({ path: path.join(shots, 'error-with-account.png') });

  // YouTube erkennt die unechten Cookies als abgemeldet → Anmeldung abgelaufen, Knopf zum Neu-Anmelden
  const expired = reasons.some((r) => /abgelaufen/.test(r));
  if (expired) {
    assert.equal(await win.locator('#btnSignIn').isVisible(), true);
    assert.equal(await win.locator('#btnSignIn').textContent(), 'Neu anmelden');
    await win.click('#btnBack').catch(() => {});
    const row2 = await openSettings(win);
    assert.match(await row2.textContent(), /Anmeldung abgelaufen/);
    await app.evaluate(({ session }) => session.fromPartition('persist:gx-google').cookies.flushStore());
  } else {
    // Abmelden löscht die Cookies
    await win.click('#btnBack').catch(() => {});
    const row2 = await openSettings(win);
    await row2.locator('button', { hasText: 'Abmelden' }).click();
    await row2.locator('button', { hasText: 'Mit dem Handy anmelden' }).waitFor();
    const left = await app.evaluate(({ session }) => session.fromPartition('persist:gx-google').cookies.get({}).then((c) => c.length));
    assert.equal(left, 0);
  }
  console.log('[main]', logs.join('').split('\n').filter((l) => /\[stream\]|\[konto\]|Stream-Fehler/.test(l)).join('\n').slice(0, 1500));
  await app.close();
}
// ---- 3. Angemeldet per Code (unechte, abgelaufene Tokens)
fs.writeFileSync(
  path.join(ud, 'account.json'),
  JSON.stringify({
    method: 'device',
    since: Date.now(),
    name: 'Handy Konto',
    photo: null,
    tokens: { plain: { access_token: 'test', refresh_token: 'test', expiry_date: new Date(Date.now() - 60_000).toISOString(), client: { client_id: 'test.apps.googleusercontent.com', client_secret: 'test' } } },
  }),
);
{
  const { app, win, logs } = await launch();
  await app.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://www.youtube.com/youtubei/v1/player*'] }, (_d, cb) => cb({ cancel: true }));
  });
  const row = await openSettings(win);
  assert.match(await row.textContent(), /Angemeldet als Handy Konto/);
  assert.match(await row.textContent(), /Per Code vom Handy angemeldet/);
  await win.evaluate(() => window.gx.play({ id: 'dQw4w9WgXcQ', title: 'Test', channelName: '', thumbnail: null, durationSec: 213, isLive: false }));
  await win.waitForSelector('#errorBox:not([hidden])', { timeout: 90_000 });
  const reasons = await win.locator('#errorReasons li').allTextContents();
  console.log('[gründe]', reasons.join(' | '));
  assert.ok(reasons.some((r) => /^Konto: .*abgelaufen/.test(r)), 'abgelehnte Tokens nicht als abgelaufen erkannt');
  assert.equal(await win.locator('#btnSignIn').textContent(), 'Neu anmelden');
  // "Neu anmelden" öffnet den Code-Dialog
  await win.click('#btnSignIn');
  await win.waitForSelector('#signInDialog:not([hidden])');
  await win.keyboard.press('Escape');
  await win.waitForSelector('#signInDialog', { state: 'hidden' });
  console.log('[main]', logs.join('').split('\n').filter((l) => /\[konto\]|Stream-Fehler/.test(l)).join('\n').slice(0, 800));
  await app.close();
}
console.log('Anmelde-Test bestanden');
