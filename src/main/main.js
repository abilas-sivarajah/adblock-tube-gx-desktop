// GX Tube Desktop – Hauptprozess: Fenster, Tray, YouTube-Abfragen und der
// Empfänger für die Android-App. Der Player selbst läuft im Fenster (renderer/).

import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, net, powerSaveBlocker, screen, session as electronSession, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YT from './youtube.js';
import * as SponsorBlock from './sponsorblock.js';
import * as PoToken from './potoken.js';
import * as Account from './account.js';
import * as TW from './twitch.js';
import * as TwitchAccount from './twitch-account.js';
import { CastServer } from './cast-server.js';
import { Session } from './session.js';
import { Store, lanAddresses } from './store.js';
import { isTwitchVideo, sanitizeChannel, sanitizeTwitchChannel, sanitizeVideo } from './protocol.js';
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

  TwitchAccount.init(app.getPath('userData'));
  TW.configure({
    fetch: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init),
    auth: TwitchAccount.auth,
    unauthorized: () => twitchExpired(),
  });

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
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, () => broadcastState());
  createTray();
  applyLoginItem();
  updates = setupUpdates({ enabled: () => store.settings.autoUpdate, toast, onStatus: (s) => send('update:status', s) });
  // BotGuard schon mal im Hintergrund starten, damit das erste Video nicht wartet
  setTimeout(() => PoToken.warmUp(), 3000);
  // Abos aus dem YouTube-Konto übernehmen
  setTimeout(() => syncAccountSubscriptions(), 15000);
  // Twitch-Anmeldung prüfen (verlangt Twitch stündlich) und Gefolgte übernehmen
  setTimeout(() => checkTwitchLogin().then(() => syncTwitchFollows()), 5000);
  setInterval(() => checkTwitchLogin(), 60 * 60 * 1000);
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
  win.on('enter-full-screen', () => {
    send('window:fullscreen', true);
    broadcastState();
  });
  win.on('leave-full-screen', () => {
    send('window:fullscreen', false);
    broadcastState();
  });
  // Auf welchem Bildschirm läuft GX Tube? (fürs Handy)
  win.on('moved', () => broadcastState());
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(www\.)?(youtube\.com|youtu\.be|github\.com|sponsor\.ajay\.app|twitch\.tv)\//.test(url)) shell.openExternal(url);
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
 * YouTube liefert die Video-Daten von googlevideo.com ohne CORS-Freigabe, Twitch die VODs
 * (cloudfront.net) ebenso. Für den eingebauten Player geben wir sie hier frei (nur für diese Adressen).
 * Pro Sitzung gibt es nur einen Empfänger je Ereignis – deshalb alles in einem Filter.
 */
function setupMediaHeaders() {
  const filter = {
    urls: ['https://*.googlevideo.com/*', 'https://*.youtube.com/api/manifest/*', 'https://*.ttvnw.net/*', 'https://*.cloudfront.net/*'],
  };
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
async function loadVideo({ video, startMs, exclude = [], fallback = false, notes = [] }) {
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
    notes,
    attempts: (previous?.attempts ?? 0) + (previous ? 1 : 0),
  };
  playback = { ...playback, status: 'loading', positionMs: resume, durationMs: previous ? playback.durationMs : Math.max(0, video.durationSec * 1000), bufferedMs: 0 };
  if (!previous) store.recordWatch(video);
  send('player:loading', { token, video, startMs: resume });
  broadcastState();
  updateTray();

  if (isTwitchVideo(video.id)) {
    if (previous?.details) send('player:details', { token, details: previous.details });
    return loadTwitch(token, video, resume, Boolean(previous));
  }

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
        const enriched = { ...video, title: d.title || video.title, channelName: d.channelName || video.channelName, channelId: d.channelId || video.channelId || null, durationSec: d.durationSec > 0 ? d.durationSec : video.durationSec, isLive: d.isLive };
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
    const stream = await YT.stream(video.id, { maxHeight: store.settings.maxQuality, exclude, notes });
    if (token !== loadToken) return;
    current.stream = stream;
    current.resolvedAt = Date.now();
    console.info(`[stream] ${video.id} über ${stream.client}${stream.poToken ? ' mit PO-Token' : ''}, bis ${stream.maxHeight}p${stream.note ? ` – ${stream.note}` : ''}${stream.degraded ? ` [${stream.attempts?.join(' | ')}]` : ''}`);
    if (stream.account && !Account.status().name) loadAccountProfile();
    updateCurrentVideo({ ...video, title: stream.title || video.title, channelName: stream.channelName || video.channelName, channelId: stream.channelId || video.channelId || null, durationSec: stream.durationSec > 0 ? stream.durationSec : video.durationSec, isLive: stream.isLive });
    send('player:source', { token, video: current.video, stream, startMs: stream.isLive ? null : resume, maxQuality: store.settings.maxQuality });
  } catch (err) {
    if (token !== loadToken) return;
    console.warn('Stream-Fehler', err?.reasons ?? err);
    current.error = err?.message ?? 'Video konnte nicht geladen werden';
    playback = { ...playback, status: 'error' };
    send('player:error', { token, message: current.error, details: Array.isArray(err?.reasons) ? err.reasons : [], signIn: Boolean(err?.signIn), signInWindow: Boolean(err?.signInWindow) });
    broadcastState();
  }
}

// ------------------------------------------------------------------ Twitch

/**
 * Twitch-Stream oder -VOD laden: Infos (Titel, Kategorie, Zuschauer) und Wiedergabe-Adresse
 * gleichzeitig. Die Werbung entfernt der Werbeblocker im Fenster.
 */
async function loadTwitch(token, video, resume, again) {
  await ensureTwitchToken();
  const [info, play] = await Promise.allSettled([TW.watchInfo(video.id), TW.playback(video.id)]);
  if (token !== loadToken) return;
  const failed = info.status === 'rejected' && info.reason?.code === 'offline' ? info.reason : play.status === 'rejected' ? play.reason : null;
  if (failed) {
    console.warn('[twitch]', failed?.message ?? failed);
    current.error = failed?.message ?? 'Stream konnte nicht geladen werden';
    playback = { ...playback, status: 'error' };
    send('player:error', { token, message: current.error, details: current.notes ?? [], twitchSignIn: Boolean(failed?.signIn) && !TwitchAccount.loggedIn(), offline: failed?.code === 'offline', channelLogin: video.channelLogin ?? TW.parseId(video.id)?.login ?? null });
    broadcastState();
    return;
  }
  if (info.status === 'fulfilled') {
    const i = info.value;
    updateCurrentVideo({ ...video, title: i.title || video.title, channelName: i.channelName || video.channelName, channelLogin: i.channelLogin || video.channelLogin || null, thumbnail: video.thumbnail || i.thumbnail, durationSec: i.isLive ? -1 : i.durationSec || video.durationSec, isLive: i.isLive });
    current.details = { twitch: i };
    send('player:details', { token, details: current.details });
  }
  const p = play.value;
  current.stream = { kind: 'twitch', url: p.url, isLive: p.isLive, login: p.login, vod: p.vod, client: p.account ? 'Twitch (Konto)' : 'Twitch', account: p.account };
  current.resolvedAt = Date.now();
  console.info(`[twitch] ${video.id}${p.account ? ' mit Konto' : ''}${again ? ' (neu geladen)' : ''}`);
  send('player:source', { token, video: current.video, stream: current.stream, startMs: p.isLive ? null : resume, maxQuality: store.settings.maxQuality });
}

let twitchRefreshing = null;

/** Zugangs-Token kurz vor Ablauf erneuern. */
async function ensureTwitchToken() {
  if (!TwitchAccount.loggedIn() || !TwitchAccount.needsRefresh()) return;
  twitchRefreshing ??= TW.refreshTokens(TwitchAccount.currentTokens())
    .then((t) => TwitchAccount.updateTokens(t))
    .catch(() => twitchExpired())
    .finally(() => {
      twitchRefreshing = null;
    });
  await twitchRefreshing;
}

/** Beim Start und stündlich: Ist die Twitch-Anmeldung noch gültig? */
async function checkTwitchLogin() {
  if (!TwitchAccount.loggedIn()) return;
  try {
    const v = await TW.validate(TwitchAccount.currentTokens().access_token);
    if (v) {
      if (v.login && v.login !== TwitchAccount.status().login) TwitchAccount.setUser({ login: v.login, id: v.userId });
      return;
    }
    TwitchAccount.updateTokens(await TW.refreshTokens(TwitchAccount.currentTokens()));
  } catch (err) {
    if (err?.signIn) twitchExpired();
  }
}

function twitchExpired() {
  if (!TwitchAccount.loggedIn()) return;
  TwitchAccount.markExpired();
  send('twitch:account', TwitchAccount.status());
}

// Anmeldung per Code (twitch.tv/activate): bestätigt auf dem Handy oder im Fenster am PC
let twitchLogin = null;

async function startTwitchLogin({ inWindow = false } = {}) {
  if (!twitchLogin) {
    const flow = await TW.startDeviceLogin();
    twitchLogin = flow;
    flow.done
      .then(async (tokens) => {
        const v = await TW.validate(tokens.access_token).catch(() => null);
        const [u] = v?.login ? await TW.users([v.login]).catch(() => []) : [];
        TwitchAccount.saveLogin(tokens, { id: v?.userId ?? u?.userId ?? null, login: v?.login ?? null, name: u?.name ?? v?.login ?? null, avatar: u?.avatar ?? null });
        TwitchAccount.closeWindow();
        send('twitch:login', { state: 'ok' });
        send('twitch:account', TwitchAccount.status());
        toast(`Bei Twitch angemeldet${u?.name ? ` als ${u.name}` : ''}`);
        syncTwitchFollows();
        // Gerade gescheitert (z. B. nur für Abonnenten)? Gleich nochmal – diesmal mit Konto
        if (current?.error && isTwitchVideo(current.video.id)) loadVideo({ video: current.video, startMs: playback.positionMs || current.startMs });
      })
      .catch((err) => {
        console.warn('[twitch] Anmeldung:', err?.reason ?? err?.message ?? err);
        send('twitch:login', { state: err?.reason ?? 'error', message: err?.message ?? String(err) });
      })
      .finally(() => {
        if (twitchLogin === flow) twitchLogin = null;
      });
  }
  if (inWindow) TwitchAccount.openWindow(twitchLogin.activateUrl, win);
  return { userCode: twitchLogin.userCode, verificationUrl: twitchLogin.verificationUrl, expiresAt: twitchLogin.expiresAt };
}

async function twitchLogout() {
  twitchLogin?.cancel();
  const old = await TwitchAccount.logout();
  TW.revoke(old).catch(() => {});
  send('twitch:account', TwitchAccount.status());
  return TwitchAccount.status();
}

/** Gefolgte Kanäle aus dem Twitch-Konto übernehmen. */
async function syncTwitchFollows() {
  if (!TwitchAccount.loggedIn()) return;
  try {
    await ensureTwitchToken();
    const list = await TW.followedChannels();
    if (store.mergeFollows(list)) send('twitch:follows', store.twitchFollows);
  } catch (err) {
    console.warn('[twitch] Gefolgte:', err?.message ?? err);
  }
}

/** Folgen / Entfolgen: auf diesem PC und – angemeldet – auch bei Twitch. */
async function setTwitchFollow(channel, on) {
  const c = sanitizeTwitchChannel(channel);
  let synced = false;
  let error = null;
  if (TwitchAccount.loggedIn()) {
    try {
      await ensureTwitchToken();
      if (!c.userId) c.userId = (await TW.users([c.login]))[0]?.userId ?? null;
      await TW.follow(c.userId, on);
      synced = true;
    } catch (err) {
      error = err?.message ?? String(err);
      console.warn('[twitch] Folgen:', error);
    }
  }
  store.setFollowing(c, on);
  send('twitch:follows', store.twitchFollows);
  return { following: on, synced, error };
}

/** Gefolgte Kanäle mit Live-Status (live zuerst, nach Zuschauern). */
async function twitchFollowed() {
  const list = await TW.users(store.twitchFollows.map((f) => f.login));
  const byLogin = new Map(list.map((c) => [c.login, c]));
  // Namen und Bilder auffrischen
  if (store.mergeFollows(list)) send('twitch:follows', store.twitchFollows);
  return store.twitchFollows
    .map((f) => byLogin.get(f.login) ?? { kind: 'channel', platform: 'twitch', login: f.login, userId: f.userId, name: f.name, avatar: f.avatar, live: null })
    .sort((a, b) => (b.live?.viewers ?? -1) - (a.live?.viewers ?? -1));
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
  syncAccountSubscriptions();
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

// ------------------------------------------------------------------ Abos

/** Abos aus dem YouTube-Konto übernehmen (soweit YouTube die Liste herausgibt). */
function syncAccountSubscriptions() {
  if (!Account.loggedIn()) return;
  YT.accountSubscriptions()
    .then((list) => {
      if (list && store.mergeSubscriptions(list)) send('subs', store.subscriptions);
    })
    .catch((e) => console.warn('[abos]', e?.message ?? e));
}

/** Abonnieren / Abo beenden: auf diesem PC und – angemeldet – auch bei YouTube. */
async function setSubscribed(channel, on) {
  const c = sanitizeChannel(channel);
  let synced = false;
  let error = null;
  if (Account.loggedIn()) {
    try {
      await YT.accountSubscribe(c.id, on);
      synced = true;
    } catch (e) {
      error = e?.message ?? String(e);
      console.warn('[abos]', error);
    }
  }
  store.setSubscribed(c, on);
  send('subs', store.subscriptions);
  return { subscribed: on, synced, error };
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

// ------------------------------------------------------------------ Bildschirme (vom Handy wählbar)

function displayList() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    name: d.label || `Bildschirm ${i + 1}`,
    primary: d.id === primary,
    width: d.size.width,
    height: d.size.height,
  }));
}

function currentDisplayId() {
  return win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()).id : null;
}

/** Fenster auf einen anderen Bildschirm schieben – Vollbild und maximiert bleiben erhalten. */
function moveToDisplay(id) {
  const target = screen.getAllDisplays().find((d) => d.id === id);
  if (!win || !target || currentDisplayId() === id) return;
  const wasFull = win.isFullScreen();
  const wasMax = win.isMaximized();
  const place = () => {
    if (win.isMaximized()) win.unmaximize();
    const area = target.workArea;
    const [w, h] = win.getSize();
    const width = Math.min(w, area.width);
    const height = Math.min(h, area.height);
    win.setBounds({ x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height });
    if (wasMax) win.maximize();
    if (wasFull) win.setFullScreen(true);
    showWindow();
    broadcastState();
    // Nach dem Umschalten in den Vollbildmodus stehen die Maße erst etwas später fest
    setTimeout(() => broadcastState(), 800);
  };
  if (wasFull) {
    // Erst aus dem Vollbild, sonst lässt sich das Fenster nicht verschieben
    win.once('leave-full-screen', () => setTimeout(place, 100));
    win.setFullScreen(false);
  } else {
    place();
  }
}

/** Vollbild ein/aus (ohne Angabe: umschalten). Beim Einschalten kommt das Video groß nach vorne. */
function setFullscreen(on) {
  if (!win) return;
  const next = typeof on === 'boolean' ? on : !win.isFullScreen();
  if (next) {
    showWindow();
    if (current) send('ui:watch', {});
  }
  win.setFullScreen(next);
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
    case 'fullscreen':
      setFullscreen(cmd.on);
      break;
    case 'display':
      moveToDisplay(cmd.id);
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
    // Fenster am PC: Vollbild und Bildschirm (zum Umschalten vom Handy)
    fullscreen: Boolean(win && !win.isDestroyed() && win.isFullScreen()),
    displayId: currentDisplayId(),
    displays: displayList(),
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
    if (!['youtube', 'twitch'].includes(s.platform)) s.platform = 'youtube';
    if (!['de', 'en', ''].includes(s.twitchLanguage)) s.twitchLanguage = 'de';
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
  ipcMain.on('player:failed', (_e, { token, positionMs, message, http, detail }) => {
    if (!current || token !== current.token) return;
    if (isTwitchVideo(current.video.id)) {
      // Twitch: einmal mit frischer Adresse (neue Sitzung) weitermachen, dann aufgeben
      const notes = [...(current.notes ?? []), `Twitch: im Player gescheitert (${String(detail || message || 'Fehler').slice(0, 160)})`];
      if (current.attempts < 1) {
        console.warn(`[twitch] im Player gescheitert (${detail ?? message}) – neu laden`);
        loadVideo({ video: current.video, startMs: Number(positionMs) || 0, fallback: true, notes });
        return;
      }
      current.error = 'Twitch hat den Stream abgebrochen.';
      playback = { ...playback, status: 'error' };
      send('player:error', { token, message: current.error, details: notes });
      broadcastState();
      return;
    }
    const used = current.stream?.client;
    // Für die Details: welcher Weg im Player gescheitert ist und warum
    const notes = [...(current.notes ?? []), `${used ?? 'Stream'}: im Player gescheitert (${String(detail || message || 'Fehler').slice(0, 160)})`];
    // Nach langer Pause sind die Adressen einfach abgelaufen – dann ist der Client nicht schuld
    const expired = current.resolvedAt && Date.now() - current.resolvedAt > 45 * 60 * 1000;
    const exclude = used && !expired ? [...current.exclude, used] : current.exclude;
    if (http && used && !expired) YT.reportClientFailure(used);
    const left = YT.clientsLeft(exclude);
    // Höchstens dreimal wechseln – viele Anfragen hintereinander lösen bei YouTube die Bot-Sperre aus
    if (left > 0 && current.attempts < 3) {
      console.warn(`[stream] ${used ?? '?'} abgelehnt bei ${Math.round((Number(positionMs) || 0) / 1000)} s – nächster Client (${detail ?? message})`);
      loadVideo({ video: current.video, startMs: Number(positionMs) || 0, exclude, fallback: true, notes });
      return;
    }
    current.error = message || 'Wiedergabefehler';
    playback = { ...playback, status: 'error' };
    send('player:error', { token, message: current.error, details: notes });
    broadcastState();
  });

  ipcMain.on('window:fullscreen', (_e, on) => win?.setFullScreen(Boolean(on)));
  ipcMain.handle('window:isFullscreen', () => Boolean(win?.isFullScreen()));
  ipcMain.on('clients:kick', (_e, id) => server?.kick(Number(id)));
  ipcMain.handle('yt:channel', (_e, id) => YT.channel(String(id)));
  ipcMain.handle('yt:channelMore', (_e, token) => YT.channelMore(String(token)));
  ipcMain.handle('subs:list', () => store.subscriptions);
  ipcMain.handle('subs:set', (_e, channel, on) => setSubscribed(channel, on === true));
  ipcMain.handle('subs:feed', () => YT.subscriptionFeed(store.subscriptions));
  ipcMain.handle('potoken:mint', (_e, binding) => YT.mintPoToken(String(binding)));
  ipcMain.handle('yt:sabrReload', (_e, id, client, reloadContext) =>
    YT.sabrReload(String(id), String(client), reloadContext && typeof reloadContext === 'object' ? reloadContext : null),
  );
  ipcMain.handle('tw:home', (_e, language) => TW.home({ language: String(language ?? '') }));
  ipcMain.handle('tw:moreStreams', (_e, language, cursor) => TW.moreStreams({ language: String(language ?? ''), cursor: String(cursor) }));
  ipcMain.handle('tw:category', (_e, name, language, cursor) => TW.category(String(name), { language: String(language ?? ''), cursor: typeof cursor === 'string' ? cursor : null }));
  ipcMain.handle('tw:search', (_e, q) => {
    store.addSearch(q);
    return TW.search(String(q).slice(0, 200));
  });
  ipcMain.handle('tw:channel', (_e, login) => TW.channel(String(login)));
  ipcMain.handle('tw:channelMore', (_e, login, cursor) => TW.channelMore(String(login), String(cursor)));
  ipcMain.handle('tw:follows', () => store.twitchFollows);
  ipcMain.handle('tw:followed', () => twitchFollowed());
  ipcMain.handle('tw:setFollow', (_e, channel, on) => setTwitchFollow(channel, on === true));
  ipcMain.handle('twitch:status', () => TwitchAccount.status());
  ipcMain.handle('twitch:loginStart', (_e, inWindow) => startTwitchLogin({ inWindow: inWindow === true }));
  ipcMain.on('twitch:loginCancel', () => {
    twitchLogin?.cancel();
    TwitchAccount.closeWindow();
  });
  ipcMain.handle('twitch:logout', () => twitchLogout());
  ipcMain.handle('twitch:chatAuth', async () => {
    await ensureTwitchToken();
    return TwitchAccount.chatAuth();
  });
  ipcMain.handle('account:status', () => Account.status());
  ipcMain.handle('account:login', () => login());
  ipcMain.handle('account:logout', () => logout());
  ipcMain.handle('account:deviceStart', () => startDeviceLogin());
  ipcMain.on('account:deviceCancel', () => deviceLogin?.cancel());
  ipcMain.handle('update:status', () => updateStatus());
  ipcMain.handle('update:check', () => checkForUpdates(true));
  ipcMain.handle('update:install', () => installUpdate());
  ipcMain.on('open:external', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\/(www\.)?(youtube\.com|youtu\.be|github\.com|twitch\.tv)\//.test(url)) shell.openExternal(url);
  });
}
