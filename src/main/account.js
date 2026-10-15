// Freiwillige Anmeldung mit dem Google-Konto (wie in der Android-App): Hilft, wenn YouTube
// anonyme Anfragen aus deinem Netz mit "Bestätige, dass du kein Bot bist" blockiert.
// Videos laufen weiterhin ohne Werbung. Zwei Wege:
//  - 'device': wie YouTube auf dem Fernseher – der PC zeigt einen Code, bestätigt wird auf dem
//    Handy unter google.com/device. Gespeichert werden nur die Tokens (verschlüsselt, wenn das
//    Betriebssystem es anbietet).
//  - 'cookies': Anmeldung im Fenster. Sie lebt in einem eigenen Browser-Profil auf diesem PC;
//    Anfragen mit Konto laufen über dieses Profil, damit erneuerte Cookies gespeichert werden.

import { BrowserWindow, net, safeStorage, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const PARTITION = 'persist:gx-google';
const LOGIN_URL =
  'https://accounts.google.com/ServiceLogin?service=youtube&hl=de&passive=true' +
  '&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26app%3Ddesktop%26hl%3Dde%26next%3D%252F';
const AUTH_COOKIES = new Set(['SAPISID', '__Secure-3PAPISID']);

let file = null;
let info = null; // { method, since, name, photo, expired, tokens? }
let loginWindow = null;
let profileSession = null;

function ses() {
  if (!profileSession) {
    profileSession = session.fromPartition(PARTITION);
    // Google lässt Anmeldungen in "eingebetteten Browsern" nicht zu – ohne Electron-Kennung ist es ein normales Chromium
    const ua = profileSession.getUserAgent().replace(/\s?(Electron|gxtube-desktop|GX ?Tube)\/[\w.-]+/gi, '');
    profileSession.setUserAgent(ua, 'de-DE,de,en-US,en');
  }
  return profileSession;
}

export function init(userDataDir) {
  file = path.join(userDataDir, 'account.json');
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    info = null;
  }
}

function save(next) {
  info = next;
  try {
    if (next) fs.writeFileSync(file, JSON.stringify(next));
    else fs.rmSync(file, { force: true });
  } catch {
    // nicht schlimm
  }
}

/** Für die Oberfläche: angemeldet, abgelaufen, wie, Name/Bild. */
export function status() {
  if (!info) return { loggedIn: false, expired: false };
  return { loggedIn: !info.expired, expired: Boolean(info.expired), method: method(), name: info.name ?? null, photo: info.photo ?? null };
}

/** 'device' (Code vom Handy), 'cookies' (Anmeldefenster) oder null. */
export function method() {
  return info ? (info.method ?? 'cookies') : null;
}

// ------------------------------------------------------------------ Code vom Handy (Tokens)

function seal(tokens) {
  try {
    if (safeStorage.isEncryptionAvailable()) return { sealed: safeStorage.encryptString(JSON.stringify(tokens)).toString('base64') };
  } catch {
    // dann eben ohne
  }
  return { plain: tokens };
}

function unseal(box) {
  try {
    if (box?.sealed) return JSON.parse(safeStorage.decryptString(Buffer.from(box.sealed, 'base64')));
    return box?.plain ?? null;
  } catch {
    return null;
  }
}

/** Tokens der Anmeldung per Code (null = nicht so angemeldet). */
export function deviceTokens() {
  return method() === 'device' && !info.expired ? unseal(info.tokens) : null;
}

/** Anmeldung per Code ist durch: Tokens merken (eine Anmeldung im Fenster wird ersetzt). */
export async function saveDevice(tokens) {
  if (method() === 'cookies') await clearProfile();
  save({ method: 'device', since: Date.now(), name: null, photo: null, tokens: seal(tokens) });
}

/** YouTube.js hat das Zugangs-Token erneuert. */
export function updateDeviceTokens(tokens) {
  if (method() !== 'device' || !tokens?.refresh_token) return;
  save({ ...info, tokens: seal(tokens) });
}

/** Kann gerade mit Konto geladen werden? */
export function loggedIn() {
  return Boolean(info && !info.expired);
}

/** YouTube meldet uns als abgemeldet (Cookies abgelaufen oder in Google widerrufen). */
export function markExpired() {
  if (info && !info.expired) save({ ...info, expired: true });
}

async function youtubeCookies() {
  return ses().cookies.get({ url: 'https://www.youtube.com' });
}

/** Aktuelle youtube.com-Cookies aus dem Anmelde-Profil als Cookie-Kopfzeile (null = nicht angemeldet). */
export async function cookieHeader() {
  if (!loggedIn() || method() !== 'cookies') return null;
  const cookies = await youtubeCookies();
  if (!cookies.some((c) => AUTH_COOKIES.has(c.name))) return null;
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * fetch über das Anmelde-Profil: Chromium hängt die gespeicherten Cookies selbst an
 * (eine mitgeschickte Cookie-Zeile ersetzt es) und speichert erneuerte.
 */
export function accountFetch(input, init = {}) {
  const url = input instanceof URL ? input.toString() : input;
  const target = new URL(typeof url === 'string' ? url : url.url);
  const headers = new Headers(init.headers ?? (url instanceof Request ? url.headers : undefined));
  headers.delete('cookie');
  // Fremder Origin macht daraus eine CORS-Anfrage, bei der Chromium keine Cookies schickt
  if (headers.has('origin') && headers.get('origin') !== target.origin) headers.delete('origin');
  return ses().fetch(url, { ...init, headers, credentials: 'include' });
}

/**
 * Anmeldefenster öffnen. Ergebnis: 'ok' (bei YouTube angemeldet), 'cancel' (Fenster geschlossen)
 * oder 'rejected' (Google hat die Anmeldung in diesem Fenster abgelehnt).
 */
export function login(parent) {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return Promise.resolve('cancel');
  }
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent: parent ?? undefined,
      width: 520,
      height: 760,
      title: 'Mit Google anmelden – GX Tube',
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: { session: ses(), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    loginWindow = win;
    let done = false;
    let rejected = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      loginWindow = null;
      if (!win.isDestroyed()) win.close();
      resolve(result);
    };
    const check = async () => {
      if (done || win.isDestroyed()) return;
      const url = win.webContents.getURL();
      // "Dieser Browser oder diese App ist möglicherweise nicht sicher" – Google zeigt es selbst an
      if (/accounts\.google\.com\/.*(signin\/rejected|disallowed_useragent)/.test(url)) rejected = true;
      if (!/^https:\/\/(www|m)\.youtube\.com\//.test(url)) return;
      if (!(await youtubeCookies()).some((c) => AUTH_COOKIES.has(c.name))) return;
      await ses().cookies.flushStore().catch(() => {});
      save({ method: 'cookies', since: Date.now(), name: null, photo: null });
      finish('ok');
    };
    win.webContents.on('did-navigate', check);
    win.webContents.on('did-stop-loading', check);
    // Links, die ein neues Fenster öffnen wollen (Hilfe, Datenschutz …), im normalen Browser
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.on('closed', () => finish(rejected ? 'rejected' : 'cancel'));
    win.loadURL(LOGIN_URL);
  });
}

/** Name und Bild fürs Konto merken (nur zur Anzeige in den Einstellungen). */
export function setProfile(name, photo) {
  if (!info) return;
  save({ ...info, name: name || info.name || null, photo: photo || info.photo || null });
}

async function clearProfile() {
  try {
    await ses().clearStorageData();
  } catch {
    // egal
  }
}

/** Abmelden: Tokens bei Google widerrufen bzw. Cookies und alles andere aus dem Anmelde-Profil löschen. */
export async function logout() {
  const tokens = method() === 'device' ? unseal(info.tokens) : null;
  save(null);
  await clearProfile();
  if (tokens?.refresh_token) {
    const url = `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.refresh_token)}`;
    await net.fetch(url, { method: 'POST' }).catch(() => {});
  }
}
