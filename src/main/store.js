// Einstellungen, Verlauf und Empfehlungen als JSON-Dateien im Benutzerordner der App.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export const DEFAULT_SETTINGS = {
  deviceName: '',
  deviceId: '',
  maxQuality: 1080,
  autoplay: true,
  sponsorBlock: true,
  sponsorCategories: ['sponsor', 'selfpromo', 'interaction'],
  volume: 100,
  speed: 1,
  fullscreenOnCast: false,
  focusOnCast: true,
  closeToTray: true,
  openAtLogin: false,
  autoUpdate: true,
  historyEnabled: true,
};

const MAX_HISTORY = 500;
const MAX_RECOMMENDATIONS = 200;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Schreibt erst in eine Hilfsdatei – ein Absturz zerstört so nie die alte Datei. */
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.settingsFile = path.join(dir, 'settings.json');
    this.libraryFile = path.join(dir, 'library.json');
    this.settings = { ...DEFAULT_SETTINGS, ...readJson(this.settingsFile, {}) };
    const lib = readJson(this.libraryFile, {});
    this.history = Array.isArray(lib.history) ? lib.history : [];
    this.recommendations = Array.isArray(lib.recommendations) ? lib.recommendations : [];
    this.searchHistory = Array.isArray(lib.searchHistory) ? lib.searchHistory : [];
    // Abos: { id, name, thumbnail, since } – auf diesem PC, mit Google-Konto zusätzlich bei YouTube
    this.subscriptions = Array.isArray(lib.subscriptions) ? lib.subscriptions : [];
    let dirty = false;
    if (!this.settings.deviceId) {
      this.settings.deviceId = randomUUID();
      dirty = true;
    }
    if (!this.settings.deviceName) {
      this.settings.deviceName = defaultDeviceName();
      dirty = true;
    }
    if (dirty) this.saveSettings();
    this.libraryTimer = null;
  }

  saveSettings() {
    writeJson(this.settingsFile, this.settings);
  }

  updateSettings(patch) {
    const next = { ...this.settings };
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!(key in DEFAULT_SETTINGS) || key === 'deviceId') continue;
      const def = DEFAULT_SETTINGS[key];
      if (typeof def === 'boolean' && typeof value === 'boolean') next[key] = value;
      else if (typeof def === 'number' && Number.isFinite(value)) next[key] = value;
      else if (typeof def === 'string' && typeof value === 'string') next[key] = value.trim().slice(0, 60);
      else if (Array.isArray(def) && Array.isArray(value)) next[key] = value.filter((v) => typeof v === 'string').slice(0, 20);
    }
    if (!next.deviceName) next.deviceName = defaultDeviceName();
    next.volume = Math.min(100, Math.max(0, Math.round(next.volume)));
    next.speed = Math.min(3, Math.max(0.25, next.speed));
    this.settings = next;
    this.saveSettings();
    return this.settings;
  }

  saveLibrarySoon() {
    clearTimeout(this.libraryTimer);
    this.libraryTimer = setTimeout(() => this.saveLibraryNow(), 500);
  }

  saveLibraryNow() {
    clearTimeout(this.libraryTimer);
    writeJson(this.libraryFile, { history: this.history, recommendations: this.recommendations, searchHistory: this.searchHistory, subscriptions: this.subscriptions });
  }

  historyEntry(id) {
    return this.history.find((h) => h.video.id === id) ?? null;
  }

  recordWatch(video, positionMs = 0, durationMs = 0) {
    if (!this.settings.historyEnabled) return;
    const old = this.historyEntry(video.id);
    const entry = {
      video: { ...old?.video, ...video },
      watchedAt: Date.now(),
      positionMs: positionMs || old?.positionMs || 0,
      durationMs: durationMs || old?.durationMs || 0,
    };
    this.history = [entry, ...this.history.filter((h) => h.video.id !== video.id)].slice(0, MAX_HISTORY);
    this.saveLibrarySoon();
  }

  updateProgress(id, positionMs, durationMs) {
    const entry = this.historyEntry(id);
    if (!entry) return;
    entry.positionMs = Math.max(0, Math.round(positionMs));
    if (durationMs > 0) entry.durationMs = Math.round(durationMs);
    this.saveLibrarySoon();
  }

  /** Ab wo weiterschauen (wie in der Android-App). */
  resumePosition(id) {
    const e = this.historyEntry(id);
    if (!e) return 0;
    const pos = e.positionMs;
    return pos > 5000 && (e.durationMs <= 0 || pos < e.durationMs - 15000) ? pos : 0;
  }

  removeHistory(id) {
    this.history = id ? this.history.filter((h) => h.video.id !== id) : [];
    this.saveLibrarySoon();
  }

  addRecommendations(list) {
    const watched = new Set(this.history.slice(0, 100).map((h) => h.video.id));
    const fresh = (list ?? []).filter((v) => v && !v.isShort && !watched.has(v.id));
    const ids = new Set(fresh.map((v) => v.id));
    this.recommendations = [...fresh, ...this.recommendations.filter((v) => !ids.has(v.id))].slice(0, MAX_RECOMMENDATIONS);
    this.saveLibrarySoon();
  }

  isSubscribed(id) {
    return this.subscriptions.some((s) => s.id === id);
  }

  /** Kanal abonnieren bzw. das Abo beenden (neueste zuerst). */
  setSubscribed(channel, on) {
    const old = this.subscriptions.find((s) => s.id === channel.id);
    const rest = this.subscriptions.filter((s) => s.id !== channel.id);
    this.subscriptions = on ? [{ ...old, ...channel, name: channel.name || old?.name || '', since: old?.since ?? Date.now() }, ...rest] : rest;
    this.saveLibrarySoon();
    return this.subscriptions;
  }

  /** Abos aus dem YouTube-Konto dazunehmen (vorhandene bleiben, Namen/Bilder werden aufgefrischt). */
  mergeSubscriptions(list) {
    const known = new Map(this.subscriptions.map((s) => [s.id, s]));
    let changed = false;
    for (const c of list ?? []) {
      const old = known.get(c.id);
      if (!old) {
        known.set(c.id, { ...c, since: Date.now() });
        changed = true;
      } else if ((c.name && c.name !== old.name) || (c.thumbnail && c.thumbnail !== old.thumbnail)) {
        known.set(c.id, { ...old, name: c.name || old.name, thumbnail: c.thumbnail || old.thumbnail });
        changed = true;
      }
    }
    if (changed) {
      this.subscriptions = [...known.values()];
      this.saveLibrarySoon();
    }
    return changed;
  }

  addSearch(query) {
    const q = String(query ?? '').trim().slice(0, 200);
    if (!q || !this.settings.historyEnabled) return;
    this.searchHistory = [q, ...this.searchHistory.filter((s) => s.toLowerCase() !== q.toLowerCase())].slice(0, 30);
    this.saveLibrarySoon();
  }
}

export function defaultDeviceName() {
  const host = os.hostname().replace(/\.local$/, '').replace(/[-_]+/g, ' ').trim();
  return host ? host.slice(0, 40) : 'GX Tube PC';
}

/** IPv4-Adressen im lokalen Netz (für "Per Adresse verbinden" in der App). */
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // Virtuelle Adapter (VirtualBox, WSL, Docker, VPN) nach hinten
      const virtual = /vbox|virtual|vmware|docker|wsl|hyper-v|vethernet|tailscale|zerotier|utun|tun|tap/i.test(name);
      out.push({ address: a.address, name, virtual });
    }
  }
  return out.sort((a, b) => Number(a.virtual) - Number(b.virtual)).map((a) => a.address);
}
