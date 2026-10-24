// Twitch-Konto: Anmeldung per Code wie die Twitch-App auf dem Fernseher (twitch.tv/activate) –
// bestätigt auf dem Handy oder in einem Fenster hier am PC. Gespeichert werden nur die Tokens
// (verschlüsselt, wenn das Betriebssystem es anbietet) und Name/Bild zur Anzeige.
// Mit Konto: Chat schreiben, Folgen bei Twitch, Abo-Streams, als Abonnent keine Werbung.

import { BrowserWindow, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { seal, unseal } from './account.js';

const PARTITION = 'persist:gx-twitch';

let file = null;
let info = null; // { since, user: { id, login, name, avatar }, tokens, expired? }
let tokens = null; // entschlüsselt im Speicher
let loginWindow = null;

export function init(userDataDir) {
  file = path.join(userDataDir, 'twitch-account.json');
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8'));
    tokens = unseal(info.tokens);
    if (!tokens?.access_token) info = tokens = null;
  } catch {
    info = tokens = null;
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

/** Für die Oberfläche. */
export function status() {
  if (!info) return { loggedIn: false, expired: false };
  const u = info.user ?? {};
  return {
    loggedIn: !info.expired,
    expired: Boolean(info.expired),
    login: u.login ?? null,
    name: u.name ?? u.login ?? null,
    avatar: u.avatar ?? null,
    userId: u.id ?? null,
    canChat: !info.expired && (tokens?.scopes ?? []).includes('chat:edit'),
  };
}

export function loggedIn() {
  return Boolean(info && !info.expired && tokens);
}

/** Für Abfragen mit Konto: { token, clientId } oder null. */
export function auth() {
  return loggedIn() ? { token: tokens.access_token, clientId: tokens.client_id } : null;
}

/** Für den Chat (IRC): { login, token } oder null. */
export function chatAuth() {
  const s = status();
  return s.canChat && s.login ? { login: s.login, token: tokens.access_token } : null;
}

export function currentTokens() {
  return tokens;
}

/** Anmeldung ist durch. */
export function saveLogin(next, user) {
  tokens = next;
  save({ since: Date.now(), user, tokens: seal(next) });
}

/** Token wurde erneuert. */
export function updateTokens(next) {
  if (!info) return;
  tokens = next;
  save({ ...info, expired: false, tokens: seal(next) });
}

export function setUser(user) {
  if (info) save({ ...info, user: { ...info.user, ...user } });
}

/** Twitch lehnt das Token ab (abgelaufen oder in den Twitch-Einstellungen getrennt). */
export function markExpired() {
  if (info && !info.expired) save({ ...info, expired: true });
}

/** Läuft das Zugangs-Token bald ab? (Fernseher-Tokens halten meist lange, aber nicht ewig.) */
export function needsRefresh() {
  return Boolean(tokens?.expires_at && tokens.expires_at - Date.now() < 10 * 60 * 1000);
}

/**
 * Anmeldeseite in einem Fenster öffnen (twitch.tv/activate mit vorausgefülltem Code).
 * Das Fenster schließt sich, sobald die Anmeldung durch ist (closeWindow).
 */
export function openWindow(url, parent) {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    parent: parent ?? undefined,
    width: 520,
    height: 780,
    title: 'Bei Twitch anmelden – GX Tube',
    autoHideMenuBar: true,
    backgroundColor: '#0e0e10',
    webPreferences: { session: session.fromPartition(PARTITION), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  loginWindow = win;
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https:\/\//.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    if (loginWindow === win) loginWindow = null;
  });
  win.loadURL(url);
}

export function closeWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
  loginWindow = null;
}

export function windowOpen() {
  return Boolean(loginWindow && !loginWindow.isDestroyed());
}

/** Abmelden: Tokens vergessen und die Anmeldung im Fenster löschen. Gibt die alten Tokens zurück (zum Widerrufen). */
export async function logout() {
  const old = tokens;
  tokens = null;
  save(null);
  try {
    await session.fromPartition(PARTITION).clearStorageData();
  } catch {
    // egal
  }
  return old;
}
