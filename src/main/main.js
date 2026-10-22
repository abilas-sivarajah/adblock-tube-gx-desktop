// GX Tube Desktop – Hauptprozess: Fenster, Tray, YouTube-Abfragen und der
// Empfänger für die Android-App. Der Player selbst läuft im Fenster (renderer/).

import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, net, powerSaveBlocker, session as electronSession, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YT from './youtube.js';
import * as SponsorBlock from './sponsorblock.js';
import * as PoToken from './potoken.js';
import * as Account from './account.js';
import { CastServer } from './cast-server.js';
import { Session } from './session.js';
import { Store, lanAddresses } from './store.js';
import { sanitizeVideo } from './protocol.js';
import { checkForUpdates, installUpdate, setupUpdates, updateStatus } from './updater.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, '..', 'assets');
const startHidden = process.argv.includes('--hidden');

// Für Tests: eigener Datenordner und Ports per Umgebungsvariable
if (process.env.GXTUBE_USER_DATA) app.setPath('userData', process.env.GXTUBE_USER_DATA);
app.setName('GX Tube');
if (process.platform === 'win32') app.setAppUserModelId('de.abilas.gxtube.desktop');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start);
}

/** @type {BrowserWindow | null} */
let win = null;
let tray = null;
let updates = null;
let quitting = false;
let store;
let server;
let session;
let blockerId = null;

// Zuletzt vom Player gemeldeter Zustand
let playback = idleState();
let loadToken = 0;
let current = null; // { token, video, stream?, segments, error?, startMs }

function idleState() {
  return { status: 'idle', positionMs: 0, durationMs: 0, bufferedMs: 0, volume: 100, muted: false, speed: 1 };
}

// ------------------------------------------------------------------ Start

async function start() {
  store = new Store(app.getPath('userData'));
  playback.volume = store.settings.volume;
  playback.speed = store.settings.speed;
  Account.init(app.getPath('userData'));

  YT.configure({
    lang: 'de',
    location: 'DE',
    fetch: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init),
    cacheDir: path.join(app.getPath('userData'), 'yt-cache'),
    poTokens: { available: PoToken.available, mint: PoToken.mint },
    account: {
      loggedIn: Account.loggedIn,
      method: Account.method,
      cookieHeader: Account.cookieHeader,
      deviceTokens: Account.deviceTokens,
      onTokens: Account.updateDeviceTokens,
      fetch: Account.accountFetch,
      onExpired: () => {
        Account.markExpired();
        send('account', Account.status());
      },
    },
  });
  YT.client().catch(() => {}); // Player-Skript schon mal laden

  setupMediaHeaders();
  Menu.setApplicationMenu(null);

  session = new Session({
    autoplay: store.settings.autoplay,
    recentlyWatched: () => store.history.slice(0, 50).map((h) => h.video.id),
  });
  session.on('queue', (snap) => {
    send('session:queue', snap);
    server?.broadcast(queueMessage());
    broadcastState();
  });
  session.on('load', (req) => loadVideo(req));
  session.on('stop', () => stopPlayback());

  server = new CastServer({
    id: store.settings.deviceId,
    name: store.settings.deviceName,
    version: app.getVersion(),
    port: Number(process.env.GXTUBE_PORT) || undefined,
    discoveryPort: Number(process.env.GXTUBE_DISCOVERY_PORT) || undefined,
  });
  server.on('command', (cmd, peer) => onRemoteCommand(cmd, peer));
  server.on('hello', (ws) => {
    server.send(ws, queueMessage());
    server.send(ws, stateMessage());
  });
  server.on('connected', (peer) => toast(`${peer.name} ist verbunden`));
  server.on('disconnected', (peer) => toast(`${peer.name} wurde getrennt`));
  server.on('clients', (list) => {
    send('clients', list);
    updateTray();
  });
  server.on('error', (err) => console.warn('[cast]', err?.message ?? err));
  try {
    await server.start();
  } catch (err) {
    console.error('Streaming-Empfänger konnte nicht starten', err);
  }

  setupIpc();
  createWindow();
  createTray();
  applyLoginItem();
  updates = setupUpdates({ enabled: () => store.settings.autoUpdate, toast, onStatus: (s) => send('update:status', s) });
  // BotGuard schon mal im Hintergrund starten, damit das erste Video nicht wartet
  setTimeout(() => PoToken.warmUp(), 3000);
}

app.on('before-quit', () => {
  quitting = true;
  PoToken.dispose();
  saveProgress();
  store?.saveLibraryNow();
  server?.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || quitting) app.quit();
});

app.on('activate', () => showWindow());

// ------------------------------------------------------------------ Fenster

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#0f0f0f',
    title: 'GX Tube',
    icon: path.join(assets, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.loadFile(path.join(here, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!startHidden) win.show();
  });
  win.on('close', (e) => {
    if (!quitting && store.settings.closeToTray && tray) {
      e.preventDefault();
      win.hide();
      // Verstecktes Fenster: Video anhalten, Empfang fürs Handy bleibt an
      send('player:command', { type: 'pause' });
    }
  });
  // Unsichtbares BotGuard-Fenster darf das Beenden nicht verhindern
  win.on('closed', () => {
    PoToken.dispose();
    win = null;
  });
  win.on('enter-full-screen', () => send('window:fullscreen', true));
  win.on('leave-full-screen', () => send('window:fullscreen', false));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(www\.)?(youtube\.com|youtu\.be|github\.com|sponsor\.ajay\.app)\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  updates?.onWindowShown();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function toast(text) {
  send('toast', text);
}

// ------------------------------------------------------------------ Tray

function createTray() {
  try {
    const image = nativeImage.createFromPath(path.join(assets, process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
    tray = new Tray(image);
    tray.setToolTip('GX Tube');
    tray.on('click', () => showWindow());
    updateTray();
  } catch (err) {
    console.warn('Tray nicht verfügbar', err);
    tray = null;
  }
}

function updateTray() {
  if (!tray) return;
  const clients = server?.clients() ?? [];
  const title = current?.video?.title;
  tray.setToolTip(['GX Tube', title ? `▶ ${title}` : null, clients.length ? `Verbunden: ${clients.map((c) => c.name).join(', ')}` : 'Bereit für GX Tube auf dem Handy'].filter(Boolean).join('\n'));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'GX Tube öffnen', click: () => showWindow() },
      { type: 'separator' },
      { label: title ? 'Abspielen/Pause' : 'Nichts wird abgespielt', enabled: Boolean(title), click: () => send('player:command', { type: 'toggle' }) },
      { label: 'Nächstes Video', enabled: Boolean(title), click: () => session.next() },
      { type: 'separator' },
      ...(clients.length ? clients.map((c) => ({ label: `📱 ${c.name}`, enabled: false })) : [{ label: 'Kein Handy verbunden', enabled: false }]),
      { type: 'separator' },
      { label: 'Beenden', click: () => { quitting = true; app.quit(); } },
    ]),
  );
}

function applyLoginItem() {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: store.settings.openAtLogin, args: ['--hidden'] });
  } catch {
    // z. B. AppImage ohne Autostart-Unterstützung
  }
}

// ------------------------------------------------------------------ Streams

/**
 * YouTube liefert die Video-Daten von googlevideo.com ohne CORS-Freigabe.
 * Für den eingebauten Player geben wir sie hier frei (nur für diese Adressen).
 */
function setupMediaHeaders() {
  const filter = { urls: ['https://*.googlevideo.com/*', 'https://*.youtube.com/api/manifest/*'] };
  const ses = electronSession.defaultSession;
  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = { ...details.requestHeaders };
    delete headers.Origin;
    delete headers.Referer;
    callback({ requestHeaders: headers });
  });
  ses.webRequest.onHeadersReceived(filter, (details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) if (key.toLowerCase().startsWith('access-control-')) delete headers[key];
    headers['Access-Control-Allow-Origin'] = ['*'];
    headers['Access-Control-Expose-Headers'] = ['*'];
    callback({ responseHeaders: headers });
  });
}

/**
 * Video laden. [exclude]: YouTube-Clients, deren Stream bei diesem Video schon abgelehnt
 * wurde ([fallback] = gleiches Video, nur anderer Client – Details/SponsorBlock bleiben).
 */
async function loadVideo({ video, startMs, exclude = [], fallback = false }) {
  const previous = fallback && current?.video.id === video.id ? current : null;
  if (!previous) saveProgress();
  const token = ++loadToken;
  const resume = startMs ?? store.resumePosition(video.id);
  current = {
    token,
    video,
    startMs: resume,
    segments: previous?.segments ?? [],
    details: previous?.details ?? null,
    error: null,
    stream: null,
    exclude,
    attempts: (previous?.attempts ?? 0) + (previous ? 1 : 0),
  };
  playback = { ...playback, status: 'loading', positionMs: resume, durationMs: previous ? playback.durationMs : Math.max(0, video.durationSec * 1000), bufferedMs: 0 };
  if (!previous) store.recordWatch(video);
  send('player:loading', { token, video, startMs: resume });
  broadcastState();
  updateTray();

  if (previous) {
    // Gleiches Video mit anderem Client: Bekanntes gleich wieder anzeigen
    if (current.details) send('player:details', { token, details: current.details });
    if (current.segments.length) send('player:segments', { token, segments: current.segments });
  } else {
    // Details (Titel, ähnliche Videos) und SponsorBlock parallel zum Stream
    YT.details(video.id)
      .then((d) => {
        if (token !== loadToken) return;
        session.setRelated(video.id, d.related);
        store.addRecommendations(d.related.slice(0, 12));
        const enriched = { ...video, title: d.title || video.title, channelName: d.channelName || video.channelName, durationSec: d.durationSec > 0 ? d.durationSec : video.durationSec, isLive: d.isLive };
        updateCurrentVideo(enriched);
        current.details = { ...d, related: d.related.slice(0, 20) };
        send('player:details', { token, details: current.details });
      })
      .catch(() => {});
  }
  if (!previous && store.settings.sponsorBlock && !video.isLive) {
    SponsorBlock.segments(video.id, store.settings.sponsorCategories, (u, i) => net.fetch(u, i)).then((segments) => {
      if (token !== loadToken) return;
      current.segments = segments;
      send('player:segments', { token, segments });
      broadcastState();
    });
  }

  try {
    const stream = await YT.stream(video.id, { maxHeight: store.settings.maxQuality, exclude });
    if (token !== loadToken) return;
    current.stream = stream;
    current.resolvedAt = Date.now();
    console.info(`[stream] ${video.id} über ${stream.client}${stream.poToken ? ' mit PO-Token' : ''}, bis ${stream.maxHeight}p${stream.note ? ` – ${stream.note}` : ''}${stream.degraded ? ` [${stream.attempts?.join(' | ')}]` : ''}`);
    if (stream.account && !Account.status().name) loadAccountProfile();
    updateCurrentVideo({ ...video, title: stream.title || video.title, channelName: stream.channelName || video.channelName, durationSec: stream.durationSec > 0 ? stream.durationSec : video.durationSec, isLive: stream.isLive });
    send('player:source', { token, video: current.video, stream, startMs: stream.isLive ? null : resume, maxQuality: store.settings.maxQuality });
  } catch (err) {
    if (token !== loadToken) return;
    console.warn('Stream-Fehler', err?.reasons ?? err);
    current.error = err?.message ?? 'Video konnte nicht geladen werden';
    playback = { ...playback, status: 'error' };
    send('player:error', { token, message: current.error, details: Array.isArray(err?.reasons) ? err.reasons : [], signIn: Boolean(err?.signIn) });
    broadcastState();
  }
}

// ------------------------------------------------------------------ Google-Konto

async function login() {
  const result = await Account.login(win);
  if (result === 'rejected') toast('Google hat die Anmeldung in diesem Fenster abgelehnt („Browser nicht sicher“). Melde dich stattdessen mit dem Handy an.');
  if (result !== 'ok') return Account.status();
  deviceLogin?.cancel();
  signedIn();
  return Account.status();
}

function signedIn() {
  YT.resetAccount();
  send('account', Account.status());
  toast('Mit Google angemeldet');
  loadAccountProfile();
  // Ist gerade ein Video gescheitert oder läuft nur in niedriger Qualität? Gleich nochmal – diesmal mit Konto
  if (current?.error || current?.stream?.degraded) loadVideo({ video: current.video, startMs: playback.positionMs || current.startMs });
}

// Anmeldung per Code (wie YouTube auf dem Fernseher): Code am PC, bestätigt wird auf dem Handy
let deviceLogin = null; // { userCode, verificationUrl, expiresAt, done, cancel }

async function startDeviceLogin() {
  if (deviceLogin) return deviceInfo(deviceLogin);
  const flow = await YT.startDeviceLogin();
  deviceLogin = flow;
  flow.done
    .then(async (tokens) => {
      await Account.saveDevice(tokens);
      send('account:device', { state: 'ok' });
      signedIn();
    })
    .catch((err) => {
      console.warn('[konto] Code-Anmeldung:', err?.reason ?? err?.message ?? err);
      send('account:device', { state: err?.reason ?? 'error', message: err?.message ?? String(err) });
    })
    .finally(() => {
      if (deviceLogin === flow) deviceLogin = null;
    });
  return deviceInfo(flow);
}

function deviceInfo(flow) {
  return { userCode: flow.userCode, verificationUrl: flow.verificationUrl, expiresAt: flow.expiresAt };
}

let profileLoading = false;
function loadAccountProfile() {
  if (profileLoading || !Account.loggedIn()) return;
  profileLoading = true;
  YT.accountProfile()
    .then((p) => {
      if (p) Account.setProfile(p.name, p.photo);
      send('account', Account.status());
    })
    .catch((e) => console.warn('[konto] Profil', e?.message ?? e))
    .finally(() => {
      profileLoading = false;
    });
}

async function logout() {
  await Account.logout();
  YT.resetAccount();
  send('account', Account.status());
  return Account.status();
}

/** Titel/Dauer nachtragen, wenn das Handy nur die ID geschickt hat. */
function updateCurrentVideo(video) {
  if (!current || current.video.id !== video.id) return;
  current.video = video;
  const idx = session.index;
  if (session.items[idx]?.id === video.id) session.items[idx] = { ...session.items[idx], ...video };
  store.recordWatch(video);
  send('player:video', { token: current.token, video });
  server?.broadcast(queueMessage());
  broadcastState();
  updateTray();
}

function stopPlayback() {
  saveProgress();
  loadToken++;
  current = null;
  playback = { ...idleState(), volume: playback.volume, muted: playback.muted, speed: playback.speed };
  send('player:stop', {});
  broadcastState();
  updateTray();
  setPowerBlock(false);
}

function saveProgress() {
  if (!current || current.video.isLive || !playback.durationMs) return;
  if (playback.positionMs > 0) store.updateProgress(current.video.id, playback.positionMs, playback.durationMs);
}

function showForCast() {
  if (!win) return;
  if (store.settings.focusOnCast || !win.isVisible()) showWindow();
  if (store.settings.fullscreenOnCast) win.setFullScreen(true);
  send('ui:watch', {});
}

function setPowerBlock(on) {
  if (on && blockerId === null) blockerId = powerSaveBlocker.start('prevent-display-sleep');
  if (!on && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}

// ------------------------------------------------------------------ Handy-Befehle

function onRemoteCommand(cmd, peer) {
  switch (cmd.type) {
    case 'play':
      session.play(cmd.video, { queue: cmd.queue, startMs: cmd.startMs });
      showForCast();
      toast(`${peer.name}: ${cmd.video.title || 'Video'}`);
      break;
    case 'add':
      session.add(cmd.video, { next: cmd.next });
      if (session.items.length > 1) toast(cmd.next ? `Als Nächstes: ${cmd.video.title}` : `Zur Warteschlange hinzugefügt: ${cmd.video.title}`);
      else showForCast();
      break;
    case 'jump':
      session.jump(cmd.index);
      break;
    case 'remove':
      session.remove(cmd.index);
      break;
    case 'clearQueue':
      session.clearUpcoming();
      break;
    case 'next':
      if (!session.next()) toast('Kein weiteres Video');
      break;
    case 'previous':
      if (!session.previous(playback.positionMs)) send('player:command', { type: 'seek', positionMs: 0 });
      break;
    case 'autoplay':
      session.setAutoplay(cmd.enabled);
      store.updateSettings({ autoplay: cmd.enabled });
      send('settings', store.settings);
      break;
    case 'stop':
      session.clear();
      break;
    default:
      // pause, resume, toggle, seek, seekBy, volume, volumeBy, mute, speed → Player im Fenster
      send('player:command', cmd);
  }
}

function queueMessage() {
  return { type: 'queue', ...session.snapshot() };
}

function stateMessage() {
  return {
    type: 'state',
    video: current?.video ?? null,
    status: current ? playback.status : 'idle',
    positionMs: Math.round(playback.positionMs),
    durationMs: Math.round(playback.durationMs),
    bufferedMs: Math.round(playback.bufferedMs),
    volume: playback.volume,
    muted: playback.muted,
    speed: playback.speed,
    isLive: Boolean(current?.video?.isLive),
    error: current?.error ?? null,
    segments: current?.segments ?? [],
    queueIndex: session.index,
    queueLength: session.items.length,
    hasNext: session.hasNext || (session.autoplay && Boolean(session.nextRelated())),
    hasPrevious: session.index > 0,
    autoplay: session.autoplay,
  };
}

let lastStateJson = '';
function broadcastState() {
  if (!server) return;
  const msg = stateMessage();
  const json = JSON.stringify(msg);
  if (json === lastStateJson) return;
  lastStateJson = json;
  server.broadcast(msg);
}

// ------------------------------------------------------------------ IPC (Fenster ↔ Hauptprozess)

function safeVideo(v) {
  try {
    return sanitizeVideo(v);
  } catch {
    return null;
  }
}

function appInfo() {
  return {
    name: store.settings.deviceName,
    version: app.getVersion(),
    port: server?.port ?? null,
    addresses: lanAddresses(),
    clients: server?.clients() ?? [],
    platform: process.platform,
    packaged: app.isPackaged,
  };
}

function setupIpc() {
  ipcMain.handle('yt:search', async (_e, q) => {
    store.addSearch(q);
    return YT.search(String(q).slice(0, 200));
  });
  ipcMain.handle('yt:searchMore', (_e, token) => YT.searchMore(String(token)));
  ipcMain.handle('yt:suggestions', (_e, q) => YT.suggestions(String(q).slice(0, 200)).catch(() => []));

  ipcMain.handle('app:info', () => appInfo());
  ipcMain.handle('settings:get', () => store.settings);
  ipcMain.handle('settings:set', (_e, patch) => {
    const before = store.settings;
    const s = store.updateSettings(patch);
    if (s.deviceName !== before.deviceName) {
      server?.setName(s.deviceName);
      updateTray();
    }
    if (s.autoplay !== session.autoplay) session.setAutoplay(s.autoplay);
    if (s.openAtLogin !== before.openAtLogin) applyLoginItem();
    send('app:info', appInfo());
    return s;
  });
  ipcMain.handle('library:get', () => ({ history: store.history.slice(0, 60), recommendations: store.recommendations.slice(0, 60), searchHistory: store.searchHistory }));
  ipcMain.handle('library:removeHistory', (_e, id) => {
    store.removeHistory(typeof id === 'string' ? id : null);
    return true;
  });
  ipcMain.handle('session:get', () => ({ ...session.snapshot(), current: current ? { token: current.token, video: current.video, stream: current.stream, segments: current.segments, error: current.error, startMs: current.startMs } : null }));

  ipcMain.on('session:play', (_e, video, queue) => {
    const v = safeVideo(video);
    if (!v) return;
    const list = Array.isArray(queue) ? queue.map(safeVideo).filter(Boolean) : null;
    session.play(v, { queue: list });
  });
  ipcMain.on('session:add', (_e, video, next) => {
    const v = safeVideo(video);
    if (!v) return;
    session.add(v, { next: next === true });
    toast(next ? 'Wird als Nächstes abgespielt' : 'Zur Warteschlange hinzugefügt');
  });
  ipcMain.on('session:jump', (_e, i) => Number.isInteger(i) && session.jump(i));
  ipcMain.on('session:remove', (_e, i) => Number.isInteger(i) && session.remove(i));
  ipcMain.on('session:next', () => session.next());
  ipcMain.on('session:previous', (_e, positionMs) => {
    if (!session.previous(Number(positionMs) || 0)) send('player:command', { type: 'seek', positionMs: 0 });
  });
  ipcMain.on('session:clearUpcoming', () => session.clearUpcoming());
  ipcMain.on('session:stop', () => session.clear());
  ipcMain.on('session:retry', () => {
    if (current) loadVideo({ video: current.video, startMs: playback.positionMs || current.startMs });
  });

  ipcMain.on('player:report', (_e, report) => {
    if (!current || report?.token !== current.token) return;
    const prevStatus = playback.status;
    playback = {
      status: String(report.status),
      positionMs: Number(report.positionMs) || 0,
      durationMs: Number(report.durationMs) || playback.durationMs,
      bufferedMs: Number(report.bufferedMs) || 0,
      volume: Number.isFinite(report.volume) ? Math.round(report.volume) : playback.volume,
      muted: Boolean(report.muted),
      speed: Number(report.speed) || 1,
    };
    if (playback.volume !== store.settings.volume || playback.speed !== store.settings.speed) {
      store.settings.volume = playback.volume;
      store.settings.speed = playback.speed;
      store.saveSettings();
    }
    if (prevStatus !== playback.status) {
      setPowerBlock(playback.status === 'playing' || playback.status === 'buffering');
      if (playback.status === 'paused') saveProgress();
    }
    if (report.save) saveProgress();
    broadcastState();
  });
  ipcMain.on('player:ended', (_e, token) => {
    if (!current || token !== current.token) return;
    saveProgress();
    if (current.video.durationSec > 0) store.updateProgress(current.video.id, current.video.durationSec * 1000, current.video.durationSec * 1000);
    if (!session.ended()) {
      playback = { ...playback, status: 'ended' };
      broadcastState();
      setPowerBlock(false);
    }
  });
  // YouTube hat den Stream mitten im Video abgelehnt (oder die Adresse ist abgelaufen):
  // an derselben Stelle mit dem nächsten YouTube-Client weitermachen.
  ipcMain.on('player:failed', (_e, { token, positionMs, message, http }) => {
    if (!current || token !== current.token) return;
    const used = current.stream?.client;
    // Nach langer Pause sind die Adressen einfach abgelaufen – dann ist der Client nicht schuld
    const expired = current.resolvedAt && Date.now() - current.resolvedAt > 45 * 60 * 1000;
    const exclude = used && !expired ? [...current.exclude, used] : current.exclude;
    if (http && used && !expired) YT.reportClientFailure(used);
    const left = YT.clientsLeft(exclude);
    // Höchstens zweimal wechseln – viele Anfragen hintereinander lösen bei YouTube die Bot-Sperre aus
    if (left > 0 && current.attempts < 2) {
      console.warn(`[stream] ${used ?? '?'} abgelehnt bei ${Math.round((Number(positionMs) || 0) / 1000)} s – nächster Client`);
      loadVideo({ video: current.video, startMs: Number(positionMs) || 0, exclude, fallback: true });
      return;
    }
    current.error = message || 'Wiedergabefehler';
    playback = { ...playback, status: 'error' };
    send('player:error', { token, message: current.error });
    broadcastState();
  });

  ipcMain.on('window:fullscreen', (_e, on) => win?.setFullScreen(Boolean(on)));
  ipcMain.handle('window:isFullscreen', () => Boolean(win?.isFullScreen()));
  ipcMain.on('clients:kick', (_e, id) => server?.kick(Number(id)));
  ipcMain.handle('account:status', () => Account.status());
  ipcMain.handle('account:login', () => login());
  ipcMain.handle('account:logout', () => logout());
  ipcMain.handle('account:deviceStart', () => startDeviceLogin());
  ipcMain.on('account:deviceCancel', () => deviceLogin?.cancel());
  ipcMain.handle('update:status', () => updateStatus());
  ipcMain.handle('update:check', () => checkForUpdates(true));
  ipcMain.handle('update:install', () => installUpdate());
  ipcMain.on('open:external', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\/(www\.)?(youtube\.com|youtu\.be|github\.com)\//.test(url)) shell.openExternal(url);
  });
}
