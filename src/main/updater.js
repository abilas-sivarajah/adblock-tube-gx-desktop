// Updates über GitHub-Releases (Windows-Installer und Linux-AppImage): automatisch im Hintergrund
// und von Hand in den Einstellungen ("Jetzt suchen", "Neu starten & aktualisieren").

import { app } from 'electron';
import updater from 'electron-updater';

const { autoUpdater } = updater;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const MIN_GAP_MS = 10 * 60 * 1000;

/**
 * Zustand für die Oberfläche:
 *  unsupported – diese Version kann sich nicht selbst ersetzen (portable, deb, macOS, Entwicklung)
 *  idle | checking | none (aktuell) | downloading | ready | error
 */
let status = { state: 'idle', current: app.getVersion(), version: null, percent: 0, error: null, checkedAt: null, reason: null };
let notify = () => {};
let lastCheck = 0;

function set(patch) {
  status = { ...status, ...patch };
  notify(status);
}

function unsupportedReason() {
  if (!app.isPackaged) return 'Entwicklungsversion';
  if (process.env.GXTUBE_NO_UPDATES) return 'Updates abgeschaltet';
  if (process.env.PORTABLE_EXECUTABLE_DIR) return 'Die portable Version aktualisiert sich nicht selbst – neue Version auf GitHub laden.';
  if (process.platform === 'linux' && !process.env.APPIMAGE) return 'Als .deb installiert – neue Version auf GitHub laden.';
  // macOS-Updates gehen nur mit signierter App
  if (process.platform === 'darwin') return 'Unter macOS neue Version auf GitHub laden.';
  return null;
}

export function updateStatus() {
  return status;
}

/** Nach Updates suchen. [manual]: vom Knopf – auch wenn automatische Updates aus sind. */
export async function checkForUpdates(manual = false) {
  if (status.state === 'unsupported' || status.state === 'checking' || status.state === 'downloading' || status.state === 'ready') return status;
  lastCheck = Date.now();
  set({ state: 'checking', error: null });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    set({ state: 'error', error: friendly(err), checkedAt: Date.now() });
    if (manual) console.warn('[update]', err?.message ?? err);
  }
  return status;
}

/** Geladenes Update installieren und GX Tube neu starten. */
export function installUpdate() {
  if (status.state !== 'ready') return false;
  // Unter Windows still installieren und danach wieder starten
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return true;
}

function friendly(err) {
  const msg = String(err?.message ?? err ?? '');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|net::/i.test(msg)) return 'Keine Verbindung zu GitHub.';
  if (/rate limit|403/i.test(msg)) return 'GitHub lässt gerade keine Abfrage zu – später erneut versuchen.';
  return msg.split('\n')[0].slice(0, 200) || 'Unbekannter Fehler';
}

export function setupUpdates({ enabled, toast, onStatus }) {
  notify = onStatus ?? (() => {});
  const reason = unsupportedReason();
  if (reason) {
    set({ state: 'unsupported', reason });
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => set({ state: 'checking', error: null }));
  autoUpdater.on('update-not-available', () => set({ state: 'none', version: null, checkedAt: Date.now() }));
  autoUpdater.on('update-available', (info) => set({ state: 'downloading', version: info.version, percent: 0, checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent ?? 0) }));
  autoUpdater.on('update-downloaded', (info) => {
    set({ state: 'ready', version: info.version, percent: 100 });
    toast(`Update ${info.version} ist bereit – in den Einstellungen „Neu starten & aktualisieren“ oder beim Beenden`);
  });
  autoUpdater.on('error', (err) => {
    console.warn('[update]', err?.message ?? err);
    set({ state: 'error', error: friendly(err), checkedAt: Date.now() });
  });
  const auto = () => {
    if (enabled() && Date.now() - lastCheck > MIN_GAP_MS) checkForUpdates();
  };
  setTimeout(auto, 10_000);
  setInterval(auto, CHECK_EVERY_MS);
  return { onWindowShown: auto };
}
