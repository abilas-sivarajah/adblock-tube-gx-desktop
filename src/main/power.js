// PC neu starten oder herunterfahren (vom Handy aus). Erzwungen: Offene Programme werden ohne
// Nachfrage geschlossen, damit nichts den PC am Ausschalten hindert.

import { execFile } from 'node:child_process';
import path from 'node:path';

/** Befehle, die nacheinander versucht werden: [[Programm, Argumente], …]. */
export function powerCommands(action, platform = process.platform, env = process.env) {
  const restart = action === 'restart';
  if (platform === 'win32') {
    const exe = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'shutdown.exe');
    return [[exe, [restart ? '/r' : '/s', '/f', '/t', '0']]];
  }
  if (platform === 'darwin') {
    // Ohne Administrator-Rechte nur über loginwindow (ohne Rückfrage-Fenster)
    return [['/usr/bin/osascript', ['-e', `tell application "loginwindow" to «event aevt${restart ? 'rrst' : 'rsdn'}»`]]];
  }
  // Linux: systemd (-i: auch wenn ein Programm das Ausschalten gerade blockiert), sonst klassisch
  return [
    ['systemctl', [restart ? 'reboot' : 'poweroff', '-i']],
    ['shutdown', [restart ? '-r' : '-P', 'now']],
  ];
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error(String(stderr || '').trim().split('\n')[0] || err.message));
      else resolve();
    });
  });
}

/** Führt den Befehl aus; wirft mit dem Grund, wenn das System ablehnt. */
export async function powerAction(action) {
  let last = null;
  for (const [file, args] of powerCommands(action)) {
    try {
      await run(file, args);
      return;
    } catch (err) {
      last = err;
    }
  }
  throw last ?? new Error('Nicht unterstützt');
}
