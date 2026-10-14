// Automatische Updates über GitHub-Releases (Windows-Installer und Linux-AppImage).

import { app } from 'electron';
import updater from 'electron-updater';

const { autoUpdater } = updater;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export function setupUpdates({ enabled, toast }) {
  // Nur in gebauten Versionen, die sich selbst ersetzen können (nicht "portable", nicht deb)
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR || process.env.GXTUBE_NO_UPDATES) return;
  if (process.platform === 'linux' && !process.env.APPIMAGE) return;
  // macOS-Updates gehen nur mit signierter App – dort von Hand neue Version laden
  if (process.platform === 'darwin') return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    toast(`Update ${info.version} ist bereit und wird beim Beenden installiert`);
  });
  autoUpdater.on('error', (err) => console.warn('[update]', err?.message ?? err));
  const check = () => {
    if (enabled()) autoUpdater.checkForUpdates().catch(() => {});
  };
  setTimeout(check, 10_000);
  setInterval(check, CHECK_EVERY_MS);
}
