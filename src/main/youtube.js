// Alle YouTube-Abfragen über YouTube.js (InnerTube) – ohne Werbedaten.
// Läuft im Hauptprozess; der Player im Fenster bekommt nur fertige Manifeste.

import { Innertube, Platform, UniversalCache, Log, YTNodes, Constants } from 'youtubei.js';
import { buildSabrFormat } from 'googlevideo/utils';

Log.setLevel(Log.Level.NONE);

// YouTube verschlüsselt die Stream-Adressen mit Funktionen aus seinem Player-Skript.
// YouTube.js schneidet sie heraus, ausführen müssen wir sie selbst.
Platform.shim.eval = async (data, env) => {
  const props = [];
  if (env.n) props.push(`n: exportedVars.nFunction(${JSON.stringify(env.n)})`);
  if (env.sig) props.push(`sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`);
  return new Function(`${data.output}\nreturn { ${props.join(', ')} }`)();
};

/**
 * Reihenfolge der YouTube-Clients für die Streams. Nicht jeder liefert jedes Video,
 * und YouTube sperrt mal den einen, mal den anderen – also der Reihe nach probieren.
 */
// (Stand Oktober 2026: Web/Mobile Web liefern oft nur noch die 360p-Datei, TV verlangt "Seite neu laden".)
export const STREAM_CLIENTS = ['VISIONOS', 'TV_SIMPLY', 'IOS', 'MWEB', 'ANDROID_VR'];

// Mit Google-Konto: Diese Clients akzeptieren Konto-Cookies (TV braucht kein PO-Token) …
export const ACCOUNT_CLIENTS = ['TV', 'TV_SIMPLY', 'MWEB'];
// … und diese die Anmeldung per Code (Token von YouTube auf dem Fernseher)
// (TV_SIMPLY lehnt das Fernseher-Token mit HTTP 400 ab; TV liefert mit Konto oft nur SABR – siehe unten)
export const DEVICE_CLIENTS = ['TV'];
const ACCOUNT_PREFIX = 'Konto ';
const EXPIRED_MESSAGE = 'Google-Anmeldung abgelaufen – bitte in den Einstellungen neu anmelden';
// Erneuern des Tokens abgelehnt: in Google widerrufen oder abgelaufen
const REFRESH_REJECTED = /refresh access token: 4\d\d|invalid_grant|Invalid tokens/i;

// Diese Clients bekommen ein PO-Token (wie YouTube im Browser), wenn eins erzeugt werden kann
const PO_CLIENTS = new Set(['MWEB', 'WEB']);
const BOT_REASON = /bot|sign in|anmelden|confirm you/i;

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const channelIdOf = (value) => (CHANNEL_ID.test(value ?? '') ? value : null);
// Zeilen wie "109.546 Aufrufe" oder "vor 3 Monaten" sind kein Kanalname
const VIEWS_TEXT = /aufrufe|views|zuschauer|watching/i;
const PUBLISHED_TEXT = /^vor |ago$|gestreamt|streamed|premiere/i;

// poTokens: { available(): boolean, mint(binding): Promise<string> } – siehe potoken.js
// account: { loggedIn(), method(), cookieHeader(), deviceTokens(), onTokens(tokens), fetch, onExpired() } – siehe account.js
let options = { lang: 'de', location: 'DE', fetch: undefined, cacheDir: undefined, poTokens: null, account: null };
let clientPromise = null;
let accountPromise = null;
const searches = new Map();
let searchCounter = 0;

export function configure(opts) {
  options = { ...options, ...opts };
  clientPromise = null;
  accountPromise = null;
}

function cache() {
  return options.cacheDir ? new UniversalCache(true, options.cacheDir) : undefined;
}

export function client() {
  if (!clientPromise) {
    clientPromise = Innertube.create({
      lang: options.lang,
      location: options.location,
      retrieve_player: true,
      generate_session_locally: true,
      fetch: options.fetch,
      cache: cache(),
    }).catch((e) => {
      clientPromise = null;
      throw e;
    });
  }
  return clientPromise;
}

// ------------------------------------------------------------------ Google-Konto

class AccountError extends Error {}

/** Werte aus der ytcfg einer YouTube-Seite (angemeldet?, Besucher-ID, DataSync-ID). */
export function parseYtcfg(html) {
  const str = (key) => {
    const m = String(html).match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? JSON.parse(`"${m[1]}"`) : null;
  };
  const loggedIn = String(html).match(/"LOGGED_IN":(true|false)/);
  return {
    loggedIn: loggedIn ? loggedIn[1] === 'true' : null,
    visitorData: str('VISITOR_DATA'),
    dataSyncId: str('DATASYNC_ID'),
  };
}

function accountMethod() {
  return options.account?.loggedIn() ? (options.account.method?.() ?? 'cookies') : null;
}

/** Konto-Client mit der Anmeldung per Code: Innertube mit den Tokens (Bearer), wie YouTube auf dem Fernseher. */
async function createDeviceClient() {
  const acc = options.account;
  const tokens = acc.deviceTokens?.();
  if (!tokens) throw new AccountError('nicht angemeldet');
  const yt = await Innertube.create({
    lang: options.lang,
    location: options.location,
    retrieve_player: true,
    generate_session_locally: true,
    enable_session_cache: false,
    fetch: options.fetch,
    cache: cache(),
  });
  yt.session.on('update-credentials', ({ credentials }) => acc.onTokens?.({ ...credentials }));
  try {
    await yt.session.signIn({ ...tokens });
  } catch (e) {
    if (REFRESH_REJECTED.test(String(e?.message))) {
      acc.onExpired?.();
      throw new AccountError(EXPIRED_MESSAGE);
    }
    throw e;
  }
  return { yt, dataSyncId: null, clients: DEVICE_CLIENTS };
}

async function createAccountClient() {
  if (accountMethod() === 'device') return createDeviceClient();
  const acc = options.account;
  const cookie = acc?.loggedIn() ? await acc.cookieHeader() : null;
  if (!cookie) throw new AccountError('nicht angemeldet');
  // Startseite mit Konto: Ist die Anmeldung noch gültig? Dazu Besucher- und DataSync-ID wie im Browser
  let cfg = { loggedIn: null, visitorData: null, dataSyncId: null };
  try {
    const res = await acc.fetch(`https://www.youtube.com/?hl=${options.lang}&gl=${options.location}`, { headers: { Accept: 'text/html' } });
    if (res.ok) cfg = parseYtcfg(await res.text());
  } catch (e) {
    console.warn('[konto]', e?.message ?? e);
  }
  if (cfg.loggedIn === false) {
    acc.onExpired?.();
    throw new AccountError(EXPIRED_MESSAGE);
  }
  const yt = await Innertube.create({
    lang: options.lang,
    location: options.location,
    retrieve_player: true,
    generate_session_locally: true,
    enable_session_cache: false,
    visitor_data: cfg.visitorData ?? undefined,
    cookie,
    fetch: acc.fetch,
    cache: cache(),
  });
  return { yt, dataSyncId: cfg.dataSyncId, clients: ACCOUNT_CLIENTS };
}

function accountClient() {
  if (!accountPromise) {
    accountPromise = createAccountClient().catch((e) => {
      accountPromise = null;
      throw e;
    });
  }
  return accountPromise;
}

/** Nach An- oder Abmelden: Konto-Client neu aufbauen. */
export function resetAccount() {
  accountPromise = null;
  accountFirstUntil = 0;
}

/** Name und Bild des angemeldeten Kontos (nur zur Anzeige). */
export async function accountProfile() {
  const { yt, clients } = await accountClient();
  let items;
  if (clients === DEVICE_CLIENTS) {
    // Mit dem Fernseher-Token antwortet nur der TV-Client
    const info = await yt.account.getInfo(false);
    items = info.page?.contents_memo?.getType(YTNodes.AccountItem) ?? [];
  } else {
    items = await yt.account.getInfo(true);
  }
  const me = items.find((i) => i.is_selected) ?? items[0];
  if (!me) return null;
  return { name: text(me.account_name) || null, photo: bestThumb(me.account_photo) };
}

// ------------------------------------------------------------------ Umwandeln

const text = (t) => (t == null ? '' : typeof t === 'string' ? t : t.text ?? t.toString?.() ?? '');

function parseDuration(str) {
  if (!str) return -1;
  const parts = String(str).trim().split(':').map((p) => parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return -1;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function bestThumb(list, id) {
  const arr = Array.isArray(list) ? list : [];
  const pick = arr.filter((t) => t?.url).sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  if (pick?.url) return pick.url.startsWith('//') ? 'https:' + pick.url : pick.url;
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

/** Ein Video aus den verschiedenen YouTube-Kacheln (Video, CompactVideo, LockupView …). */
export function toVideo(node) {
  if (!node) return null;
  if (node.type === 'LockupView') {
    if (node.content_type !== 'VIDEO' && node.content_type !== 'SHORT') return null;
    const id = node.content_id;
    if (!VIDEO_ID.test(id || '')) return null;
    const rows = node.metadata?.metadata?.metadata_rows ?? [];
    const parts = rows.flatMap((r) => r.metadata_parts ?? []).map((p) => text(p.text)).filter(Boolean);
    const badges = (node.content_image?.overlays ?? []).flatMap((o) => o.badges ?? []);
    const durationText = badges.map((b) => b.text).find((t) => /^\d+(:\d+)+$/.test(t || ''));
    const live = badges.some((b) => /LIVE/i.test(b.badge_style || '') || /^live$/i.test(b.text || ''));
    return {
      id,
      title: text(node.metadata?.title),
      channelName: parts.find((p) => !VIEWS_TEXT.test(p) && !PUBLISHED_TEXT.test(p)) || '',
      // Kanal steckt im Klick aufs Kanalbild
      channelId: channelIdOf(node.metadata?.image?.renderer_context?.command_context?.on_tap?.payload?.browseId),
      thumbnail: bestThumb(node.content_image?.image ?? node.content_image?.primary_thumbnail?.image, id),
      durationSec: parseDuration(durationText),
      viewsText: parts.find((p) => VIEWS_TEXT.test(p)) || '',
      publishedText: parts.find((p) => PUBLISHED_TEXT.test(p)) || '',
      isLive: live,
      isShort: node.content_type === 'SHORT',
    };
  }
  if (node.type === 'ShortsLockupView') {
    const id = node.on_tap_endpoint?.payload?.videoId ?? node.entity_id?.replace(/^shorts-shelf-item-/, '');
    if (!VIDEO_ID.test(id || '')) return null;
    return {
      id,
      title: text(node.overlay_metadata?.primary_text),
      channelName: '',
      channelId: null,
      thumbnail: bestThumb(node.thumbnail, id),
      durationSec: -1,
      viewsText: text(node.overlay_metadata?.secondary_text),
      publishedText: '',
      isLive: false,
      isShort: true,
    };
  }
  const id = node.video_id ?? node.id;
  if (!VIDEO_ID.test(id || '')) return null;
  if (!['Video', 'CompactVideo', 'GridVideo', 'PlaylistVideo', 'PlaylistPanelVideo', 'ReelItem'].includes(node.type)) return null;
  const durationSec = node.duration?.seconds > 0 ? node.duration.seconds : parseDuration(text(node.duration?.text ?? node.length_text ?? node.duration));
  return {
    id,
    title: text(node.title),
    channelName: node.author?.name && node.author.name !== 'N/A' ? node.author.name : text(node.short_byline_text ?? node.author),
    channelId: channelIdOf(node.author?.id),
    thumbnail: bestThumb(node.thumbnails ?? node.thumbnail, id),
    durationSec,
    viewsText: text(node.short_view_count ?? node.view_count ?? node.views),
    publishedText: text(node.published),
    isLive: Boolean(node.is_live),
    isShort: node.type === 'ReelItem',
  };
}

function toChannel(node) {
  if (node?.type !== 'Channel') return null;
  return {
    kind: 'channel',
    id: node.id,
    name: node.author?.name ?? '',
    thumbnail: bestThumb(node.author?.thumbnails),
    subscribersText: text(node.subscriber_count ?? node.video_count),
  };
}

function unique(videos) {
  const seen = new Set();
  return videos.filter((v) => v && !seen.has(v.id) && seen.add(v.id));
}

function flattenResults(nodes) {
  const out = [];
  for (const n of nodes ?? []) {
    if (!n) continue;
    if (n.type === 'Channel') {
      const c = toChannel(n);
      if (c) out.push(c);
      continue;
    }
    const v = toVideo(n);
    if (v) {
      out.push({ kind: 'video', ...v });
      continue;
    }
    // Regale (z. B. "Shorts", "Ähnliche Suchanfragen") enthalten selbst wieder Videos
    const inner = n.contents ?? n.items ?? n.content?.items;
    if (Array.isArray(inner) || inner?.length) out.push(...flattenResults([...inner]));
  }
  return out;
}

/** Verständliche Fehlermeldung statt "Request to … failed with status code 403". */
export function friendlyError(err) {
  const msg = String(err?.message ?? err ?? '');
  const info = String(err?.info ?? '');
  if (/status code (403|429)/.test(msg) || /automated queries|unusual traffic/i.test(info)) {
    return new Error('YouTube blockiert gerade Anfragen aus deinem Netz (zu viele Anfragen). Bitte etwas später erneut versuchen.');
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/i.test(msg)) {
    return new Error('Keine Verbindung zu YouTube. Ist der PC mit dem Internet verbunden?');
  }
  return err instanceof Error ? err : new Error(msg);
}

async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    throw friendlyError(err);
  }
}

// ------------------------------------------------------------------ Suche

export async function search(query) {
  return guarded(async () => {
    const yt = await client();
    const res = await yt.search(query, { type: 'all' });
    return storeSearch(res);
  });
}

export async function searchMore(token) {
  const prev = searches.get(token);
  if (!prev) return { items: [], next: null };
  searches.delete(token);
  return guarded(async () => storeSearch(await prev.getContinuation()));
}

function storeSearch(res) {
  let next = null;
  if (res.has_continuation) {
    next = String(++searchCounter);
    searches.set(next, res);
    // Nur die letzten Suchen merken
    for (const key of searches.keys()) if (searches.size > 20) searches.delete(key);
  }
  const items = flattenResults(res.results);
  const seen = new Set();
  return {
    items: items.filter((i) => {
      const key = i.kind + ':' + i.id;
      return !seen.has(key) && seen.add(key);
    }),
    next,
  };
}

export async function suggestions(query) {
  if (!query?.trim()) return [];
  const yt = await client();
  return (await yt.getSearchSuggestions(query)).slice(0, 10);
}

// ------------------------------------------------------------------ Video

/** Titel, Kanal, Beschreibung und ähnliche Videos (für Autoplay und die Seitenleiste). */
export async function details(id) {
  if (!VIDEO_ID.test(id)) throw new Error('Ungültige Video-ID');
  // Während anonym gesperrt ist, auch die Details mit Konto holen
  const viaAccount = options.account?.loggedIn() && Date.now() < accountFirstUntil ? await accountClient().then((a) => a.yt, () => null) : null;
  let info = viaAccount ? await viaAccount.getInfo(id).catch(() => null) : null;
  if (!info) {
    const yt = await client().catch((e) => Promise.reject(friendlyError(e)));
    info = await guarded(() => yt.getInfo(id));
  }
  const b = info.basic_info;
  const related = unique((info.watch_next_feed ?? []).map(toVideo));
  return {
    id,
    title: b.title ?? '',
    channelName: b.author ?? '',
    channelId: b.channel_id ?? null,
    thumbnail: bestThumb(b.thumbnail, id),
    durationSec: b.duration ?? -1,
    viewCount: b.view_count ?? -1,
    description: b.short_description ?? '',
    isLive: Boolean(b.is_live),
    related,
  };
}

class StreamError extends Error {
  constructor(message, reasons, { signIn = false } = {}) {
    super(message);
    this.reasons = reasons;
    // Würde eine Anmeldung mit Google helfen?
    this.signIn = signIn;
  }
}

/** Prüft ein kleines Stück der Datei ab [offset] – YouTube sperrt manchmal erst weiter hinten oder höhere Qualitäten. */
async function urlWorks(url, fetchImpl, offset = 0) {
  try {
    const start = Math.max(0, Math.floor(offset));
    const r = await fetchImpl(url + (url.includes('?') ? '&' : '?') + `range=${start}-${start + 1023}`, { method: 'GET' });
    await r.arrayBuffer().catch(() => {});
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * PO-Tokens für Web-Clients: [session] gebunden an die Visitor-ID (mit Konto: DataSync-ID),
 * [content] an die Video-ID.
 */
async function poTokensFor(yt, clientName, id, binding) {
  const provider = options.poTokens;
  if (!PO_CLIENTS.has(clientName) || !binding || !provider?.available()) return null;
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('PO-Token dauert zu lange')), 8000));
    const [session, content] = await Promise.race([Promise.all([provider.mint(binding), provider.mint(id)]), timeout]);
    return { session, content };
  } catch (e) {
    console.warn('[potoken]', e?.message ?? e);
    return null;
  }
}

// Clients, deren Streams kürzlich mitten im Video abgelehnt wurden, kommen eine Weile ans Ende.
const clientFailures = new Map(); // Client → Zeitpunkt
const FAILURE_PENALTY_MS = 60 * 60 * 1000;
// Nach einer Bot-Sperre eine Weile gleich mit Konto laden, statt erst wieder anonym zu fragen
const ACCOUNT_FIRST_MS = 30 * 60 * 1000;
let accountFirstUntil = 0;
const AGE_REASON = /\bage\b|\balter\b|altersbeschr|inappropriate|ungeeignet/i;
// Client, der zuletzt volle Qualität geliefert hat: kommt eine Weile zuerst dran (spart Anfragen)
const lastGood = new Map(); // Gruppe ('' oder 'Konto ') → { client, at }
const LAST_GOOD_MS = 60 * 60 * 1000;

/** [names] mit dem zuletzt erfolgreichen Client vorne. */
export function withLastGoodFirst(names, prefix = '') {
  const good = lastGood.get(prefix);
  if (!good || Date.now() - good.at > LAST_GOOD_MS || !names.includes(good.client)) return names;
  return [good.client, ...names.filter((c) => c !== good.client)];
}

function rememberGood(prefix, client) {
  lastGood.set(prefix, { client, at: Date.now() });
}

/**
 * Original-Tonspur eines Videos mit mehreren Tonspuren (Synchronfassungen, KI-Übersetzungen).
 * Gibt die Spur-ID zurück, oder null, wenn es nur eine gibt.
 * YouTube markiert die Spuren (acont=original/dubbed/dubbed-auto); fehlt die Markierung, hilft
 * der Name ("… original") und zuletzt die Standard-Spur.
 */
export function originalAudioTrack(formats) {
  const audios = (formats ?? []).filter((f) => f.has_audio && !f.has_video && f.audio_track?.id);
  const ids = new Set(audios.map((f) => f.audio_track.id));
  if (ids.size <= 1) return null;
  const marked = new Set(audios.filter((f) => f.is_original && !f.is_drc).map((f) => f.audio_track.id));
  const dubsMarked = audios.some((f) => f.is_dubbed || f.is_auto_dubbed || f.is_secondary || f.is_descriptive);
  if (dubsMarked && marked.size === 1) return [...marked][0];
  const named = audios.find((f) => /original/i.test(f.audio_track.display_name ?? ''));
  if (named) return named.audio_track.id;
  if (marked.size === 1) return [...marked][0];
  return audios.find((f) => f.audio_track.audio_is_default)?.audio_track.id ?? null;
}

/** true für Tonspuren, die nicht das Original sind (zum Aussortieren). */
function notOriginalAudio(formats) {
  const original = originalAudioTrack(formats);
  if (!original) return () => false;
  return (f) => f.has_audio && !f.has_video && Boolean(f.audio_track?.id) && f.audio_track.id !== original;
}

/** Fehlertext kurz und verständlich (YouTube.js schreibt "Request to … failed with status code 400"). */
function shortError(e) {
  const msg = String(e?.message ?? e).split('\n')[0];
  const http = msg.match(/^Request to .*failed with status code (\d+)/);
  if (http) return `YouTube lehnt die Anfrage ab (HTTP ${http[1]})`;
  if (/No valid URL to decipher/i.test(msg)) return 'nur über SABR';
  return msg;
}

/** Ein Client hat nichts Brauchbares geliefert: Grund merken (auch für die Details). */
function failed(ctx, reason) {
  ctx.reasons.push(reason);
  ctx.trail.push(reason);
}

/** Bestes Ergebnis unter den Notlösungen: höchste Auflösung, bei Gleichstand DASH vor der Datei mit Ton. */
export function bestCandidate(candidates) {
  return [...candidates].sort((a, b) => (b.maxHeight || 0) - (a.maxHeight || 0) || (a.kind === 'dash' ? -1 : 0) - (b.kind === 'dash' ? -1 : 0))[0] ?? null;
}

export function reportClientFailure(clientName) {
  if (clientName) clientFailures.set(clientName, Date.now());
  if (String(clientName).startsWith(SABR_PREFIX)) sabrFirstUntil = 0;
}

export function preferredClients(exclude = []) {
  const now = Date.now();
  const recentlyFailed = (c) => now - (clientFailures.get(c) ?? 0) < FAILURE_PENALTY_MS;
  const usable = STREAM_CLIENTS.filter((c) => !exclude.includes(c));
  return [...usable.filter((c) => !recentlyFailed(c)), ...usable.filter(recentlyFailed)];
}

/** Wie viele Clients bleiben für dieses Video noch übrig (angemeldet auch die mit Konto)? */
export function clientsLeft(exclude = []) {
  const anonymous = STREAM_CLIENTS.filter((c) => !exclude.includes(c)).length + sabrNames(exclude).length;
  const method = accountMethod();
  const names = method === 'device' ? DEVICE_CLIENTS : method ? ACCOUNT_CLIENTS : [];
  const account = method ? names.filter((c) => !exclude.includes(ACCOUNT_PREFIX + c)).length + sabrNames(exclude, ACCOUNT_PREFIX).length : 0;
  return anonymous + account;
}

/**
 * Probiert die Clients einer Gruppe (anonym oder mit Konto) der Reihe nach.
 * Gibt den ersten Stream in voller Qualität zurück, sonst null. Gründe landen in [ctx.reasons],
 * Streams in niedrigerer Qualität (YouTube sperrt die höheren) in [ctx.candidates].
 */
async function tryClients(id, group, ctx) {
  const { yt } = group;
  let botBlocks = 0;
  for (const clientName of withLastGoodFirst(group.clients, group.prefix)) {
    const label = group.prefix + clientName;
    try {
      const po = await poTokensFor(yt, clientName, id, group.binding);
      // Token für die Video-Server: hängt der Player an jede Stream-Adresse an (&pot=)
      yt.session.player.po_token = po?.session;
      const info = await yt.getBasicInfo(id, { client: clientName, po_token: po?.content });
      const status = info.playability_status;
      if (status?.status !== 'OK') {
        const reason = status?.reason || status?.status || 'nicht abspielbar';
        failed(ctx, `${label}: ${reason}`);
        // Privat / gelöscht: andere Clients ändern daran nichts
        if (status?.status === 'ERROR') return null;
        // Bot-Sperre gilt fürs ganze Netz – nicht alle Clients durchprobieren (das macht es nur schlimmer)
        if (BOT_REASON.test(reason) && ++botBlocks >= 2) {
          ctx.botStop = true;
          return null;
        }
        continue;
      }
      const sd = info.streaming_data;
      const b = info.basic_info;
      const meta = {
        id,
        title: b.title ?? '',
        channelName: b.author ?? '',
        channelId: channelIdOf(b.channel_id),
        thumbnail: bestThumb(b.thumbnail, id),
        durationSec: b.duration ?? -1,
        isLive: Boolean(b.is_live),
        client: label,
        account: Boolean(group.account),
      };
      if (b.is_live || b.is_post_live_dvr) {
        if (sd?.hls_manifest_url) return { ...meta, kind: 'hls', url: sd.hls_manifest_url };
        failed(ctx, `${label}: kein Live-Stream`);
        continue;
      }
      const formats = sd?.adaptive_formats ?? [];
      const videos = formats.filter((f) => f.has_video && !f.has_audio);
      // Immer der Originalton – Synchronfassungen fliegen raus
      const dubbed = notOriginalAudio(formats);
      const audio = formats.filter((f) => f.has_audio && !f.has_video && !dubbed(f)).sort((a, c) => (c.bitrate || 0) - (a.bitrate || 0))[0];
      // Video mit Ton in einer Datei (meist 360p) – liefert YouTube fast immer
      const muxed = (sd?.formats ?? []).filter((f) => f.has_video && f.has_audio).sort((a, c) => (c.height || 0) - (a.height || 0))[0];
      const middle = (f) => (Number(f.content_length) || 0) * 0.5;
      const works = async (f) => !ctx.check || urlWorks(await f.decipher(yt.session.player), ctx.fetchImpl, middle(f));

      // Beste Auflösung bis maxHeight, die YouTube wirklich ausliefert – manche Clients sperren
      // höhere Qualitäten (ohne passendes Token), niedrigere gehen dann meist noch.
      const heights = [...new Set(videos.map((f) => f.height || 0))].filter((h) => h > 0 && h <= ctx.maxHeight).sort((a, c) => c - a);
      if (!heights.length && videos.length) heights.push(Math.min(...videos.map((f) => f.height || 0)));
      const audioOk = audio ? await works(audio) : false;
      const tried = [];
      let video = null;
      if (audioOk) {
        for (const h of heights.slice(0, 5)) {
          const candidate = videos.filter((f) => f.height === h).sort((a, c) => (c.bitrate || 0) - (a.bitrate || 0))[0];
          tried.push(`${h}p`);
          if (await works(candidate)) {
            video = candidate;
            break;
          }
        }
      }
      if (video) {
        const cap = video.height;
        const manifest = await info.toDash({
          // Nur Videospuren bis zur geprüften Auflösung – darüber sperrt YouTube
          format_filter: (f) => (f.has_video && (f.height || 0) > cap) || dubbed(f),
        });
        const result = { ...meta, kind: 'dash', manifest, maxHeight: cap, poToken: Boolean(po), degraded: tried.length > 1, note: tried.length > 1 ? `höhere Qualität gesperrt (${tried.slice(0, -1).join(', ')})` : null };
        ctx.trail.push(`${label}: ${cap}p${result.degraded ? ` (${tried.slice(0, -1).join(', ')} gesperrt)` : ''}`);
        if (!result.degraded) {
          rememberGood(group.prefix, clientName);
          return result;
        }
        // Nur niedrigere Qualität: merken und die anderen Clients fragen
        ctx.candidates.push(result);
        continue;
      }
      if (muxed && (await works(muxed))) {
        const result = { ...meta, kind: 'progressive', url: await muxed.decipher(yt.session.player), maxHeight: muxed.height, poToken: Boolean(po), degraded: (muxed.height || 0) < (heights[0] ?? 0), note: 'nur Datei mit Ton (niedrige Qualität)' };
        ctx.trail.push(`${label}: nur ${muxed.height}p-Datei (${!audioOk ? 'Ton' : 'Video'} gesperrt)`);
        if (!result.degraded) return result;
        ctx.candidates.push(result);
        continue;
      }
      const what = !audio ? 'keine Tonspur' : !audioOk ? 'Ton' : `Video ${tried.join(', ') || 'keine Spur'}`;
      failed(ctx, `${label}: Stream gesperrt (${what}${muxed ? ', auch die 360p-Datei' : ''})`);
    } catch (e) {
      // Token in Google widerrufen: nicht weiter mit Konto probieren, Anmeldung als abgelaufen zeigen
      if (group.account && REFRESH_REJECTED.test(String(e?.message))) {
        options.account?.onExpired?.();
        accountPromise = null;
        ctx.accountExpired = true;
        failed(ctx, `Konto: ${EXPIRED_MESSAGE}`);
        return null;
      }
      failed(ctx, `${label}: ${shortError(e)}`);
    } finally {
      yt.session.player.po_token = undefined;
    }
  }
  return null;
}

// ------------------------------------------------------------------ SABR

// SABR: So lädt der YouTube-Webplayer – der Player fragt Stück für Stück per POST (siehe renderer/sabr.js).
// Bei den Web-Clients liefert YouTube darüber auch dann HD, wenn es direkte Adressen nur noch für 360p gibt.
export const SABR_CLIENTS = process.env.GXTUBE_SABR_CLIENTS ? process.env.GXTUBE_SABR_CLIENTS.split(',') : ['WEB', 'MWEB'];
// Mit Konto: Der TV-Client kommt auch durch, wenn das Netz anonym als "Bot" gesperrt ist – liefert aber nur SABR
// (WEB als zweiter Weg, falls SABR über TV bei einem Video im Player scheitert)
export const ACCOUNT_SABR_CLIENTS = ['TV', 'WEB'];
const SABR_PREFIX = 'SABR ';
// Lief zuletzt nur SABR in voller Qualität: eine Weile gleich SABR nehmen (spart die vielen Versuche)
const SABR_FIRST_MS = 60 * 60 * 1000;
let sabrFirstUntil = 0;
let sabrFirstAccount = false;

/** SABR für diese Gruppe ('' = anonym, 'Konto ') schon gescheitert oder abgeschaltet? */
function sabrExcluded(exclude, prefix = '') {
  return sabrNames(exclude, prefix).length === 0;
}

/** SABR-Clients, die für dieses Video noch nicht gescheitert sind. */
function sabrNames(exclude, prefix = '') {
  if (process.env.GXTUBE_NO_SABR === '1') return [];
  return (prefix ? ACCOUNT_SABR_CLIENTS : SABR_CLIENTS).filter((n) => !exclude.includes(prefix + SABR_PREFIX + n));
}

function clientInfoFor(clientName, yt) {
  const c = Constants.CLIENTS[clientName];
  return {
    clientName: Number(Constants.CLIENT_NAME_IDS[c.NAME]),
    clientVersion: c.VERSION,
    osName: yt.session.context.client.osName,
    osVersion: yt.session.context.client.osVersion,
  };
}

async function sabrData(yt, id, clientName, po) {
  const info = await yt.getBasicInfo(id, { client: clientName, po_token: po?.content });
  const sd = info.streaming_data;
  const ustreamerConfig = info.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
  const url = sd?.server_abr_streaming_url ? await yt.session.player.decipher(sd.server_abr_streaming_url) : null;
  return { info, sd, ustreamerConfig, url };
}

/**
 * Stream über SABR – Web-Clients mit PO-Token, mit Konto der TV-Client. Ohne Vorab-Prüfung:
 * Scheitert es im Player, geht es mit der nächsten Möglichkeit weiter.
 */
async function trySabr(id, group, ctx, names = SABR_CLIENTS) {
  const { yt } = group;
  for (const clientName of names) {
    const label = group.prefix + SABR_PREFIX + clientName;
    try {
      const po = await poTokensFor(yt, clientName, id, group.binding);
      const { info, sd, ustreamerConfig, url } = await sabrData(yt, id, clientName, po);
      const status = info.playability_status;
      if (status?.status !== 'OK') {
        const reason = status?.reason || status?.status || 'nicht abspielbar';
        failed(ctx, `${label}: ${reason}`);
        // Gelöscht/privat oder Bot-Sperre: der andere Web-Client ändert daran nichts
        if (status?.status === 'ERROR' || BOT_REASON.test(reason)) return null;
        continue;
      }
      const b = info.basic_info;
      if (b.is_live || b.is_post_live_dvr) return null;
      if (!url || !ustreamerConfig || !sd?.adaptive_formats?.length) {
        failed(ctx, `${label}: kein SABR`);
        continue;
      }
      // Nur MP4-Spuren (H.264/AV1, AAC): Bei WebM steckt der Index (Cues) nicht im Anfangsstück, das SABR liefert
      const mp4 = (f) => /^(video|audio)\/mp4/.test(String(f.mime_type));
      const heights = sd.adaptive_formats.filter((f) => f.has_video && mp4(f)).map((f) => f.height || 0);
      if (!heights.length || !sd.adaptive_formats.some((f) => f.has_audio && mp4(f))) {
        failed(ctx, `${label}: keine MP4-Spuren`);
        continue;
      }
      const maxHeight = Math.max(0, ...heights.filter((h) => h <= ctx.maxHeight)) || Math.min(...heights);
      const dubbed = notOriginalAudio(sd.adaptive_formats);
      const manifest = await info.toDash({ manifest_options: { is_sabr: true }, format_filter: (f) => !mp4(f) || dubbed(f) });
      ctx.trail.push(`${label}: bis ${maxHeight}p${po ? ' (mit PO-Token)' : ''}`);
      return {
        id,
        title: b.title ?? '',
        channelName: b.author ?? '',
        channelId: channelIdOf(b.channel_id),
        thumbnail: bestThumb(b.thumbnail, id),
        durationSec: b.duration ?? -1,
        isLive: false,
        client: label,
        account: Boolean(group.account),
        kind: 'sabr',
        manifest,
        maxHeight,
        poToken: Boolean(po),
        degraded: false,
        note: 'SABR wie im Browser',
        sabr: {
          url,
          ustreamerConfig,
          formats: sd.adaptive_formats.map((f) => buildSabrFormat(f)),
          clientInfo: clientInfoFor(clientName, yt),
          poToken: po?.content ?? null,
          // PO-Tokens aus BotGuard gelten nur für Web-Clients
          noPoToken: !PO_CLIENTS.has(clientName),
        },
      };
    } catch (e) {
      failed(ctx, `${label}: ${shortError(e)}`);
    }
  }
  return null;
}

/** YouTube verlangt neue SABR-Adressen (z. B. nach langer Pause). */
export async function sabrReload(id, label, reloadPlaybackContext = null) {
  if (!VIDEO_ID.test(id)) throw new Error('Ungültige Video-ID');
  const withAccount = String(label).startsWith(ACCOUNT_PREFIX);
  const clientName = String(label).replace(ACCOUNT_PREFIX, '').replace(SABR_PREFIX, '');
  if (!(withAccount ? ACCOUNT_SABR_CLIENTS : SABR_CLIENTS).includes(clientName)) throw new Error('Kein SABR-Client');
  const acc = withAccount ? await accountClient() : null;
  const yt = acc?.yt ?? (await client());
  const po = await poTokensFor(yt, clientName, id, withAccount ? acc.dataSyncId : yt.session.context.client.visitorData);
  // Wie der Webplayer: den Kontext, den YouTube mit der Reload-Aufforderung schickt, wieder mitgeben
  const res = await yt.actions.execute('/player', {
    videoId: id,
    client: clientName,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: {
      contentPlaybackContext: { vis: 0, splay: false, signatureTimestamp: yt.session.player?.signature_timestamp },
      ...(reloadPlaybackContext ? { reloadPlaybackContext } : {}),
    },
    ...(po?.content ? { serviceIntegrityDimensions: { poToken: po.content } } : {}),
  });
  const raw = res.data?.streamingData?.serverAbrStreamingUrl;
  const ustreamerConfig = res.data?.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig;
  if (!raw || !ustreamerConfig) throw new Error('YouTube hat keine neuen SABR-Daten geschickt');
  return { url: await yt.session.player.decipher(raw), ustreamerConfig };
}

/** PO-Token für SABR-Anfragen (an die Video-ID gebunden). */
export async function mintPoToken(binding) {
  const provider = options.poTokens;
  if (!provider?.available()) return '';
  return provider.mint(String(binding)).catch(() => '');
}

/**
 * Sucht einen YouTube-Client, dessen Stream-Adressen wirklich abspielbar sind,
 * und baut daraus ein DASH-Manifest (getrennte Video- und Tonspur) bzw. nimmt
 * bei Live-Streams die HLS-Adresse.
 *
 * Geprüft wird die beste Videospur bis [maxHeight] mitten in der Datei: Manche Clients
 * liefern ohne "PO-Token" nur den Anfang oder nur niedrige Qualitäten.
 * [exclude]: Clients, die bei diesem Video schon versagt haben.
 *
 * Mit Google-Konto: Scheitert es anonym (Bot-Sperre, Altersgrenze …), geht es mit Konto
 * weiter – und nach einer Sperre für eine Weile gleich mit Konto.
 */
export async function stream(id, { maxHeight = 1080, exclude = [], clients = preferredClients(exclude), check = true, notes = [] } = {}) {
  if (!VIDEO_ID.test(id)) throw new Error('Ungültige Video-ID');
  // [notes]: was bei diesem Video schon im Player gescheitert ist (steht mit in den Details)
  const ctx = { reasons: [...notes], candidates: [], trail: [...notes], maxHeight, check, fetchImpl: options.fetch ?? globalThis.fetch };
  const withAccount = Boolean(options.account?.loggedIn());

  const anonymous = async () => {
    const yt = await client();
    return { yt, prefix: '', clients, binding: yt.session.context.client.visitorData };
  };
  const account = async () => {
    const { yt, dataSyncId, clients: accountClients } = await accountClient();
    const names = accountClients.filter((c) => !exclude.includes(ACCOUNT_PREFIX + c));
    return { yt, prefix: ACCOUNT_PREFIX, clients: names, binding: dataSyncId, account: true };
  };
  const accountFirst = withAccount && Date.now() < accountFirstUntil;
  const order = !withAccount ? [anonymous] : accountFirst ? [account, anonymous] : [anonymous, account];
  const chosen = (result) => {
    // Anonym ging es nicht (oder nur schlechter), mit Konto schon: die nächste halbe Stunde gleich mit Konto
    if (result.account && !accountFirst) accountFirstUntil = Date.now() + ACCOUNT_FIRST_MS;
    // Was jeder Client geliefert hat (für "Details" im Qualitäts-Menü)
    return { ...result, attempts: ctx.trail, signIn: Boolean(result.degraded && !withAccount) };
  };

  // SABR anonym bzw. mit Konto (TV)
  const sabrAnonymous = async () => trySabr(id, await anonymous(), ctx, sabrNames(exclude));
  const sabrAccount = async () => trySabr(id, await account(), ctx, sabrNames(exclude, ACCOUNT_PREFIX));
  const sabrAllowed = (useAccount) => (useAccount ? withAccount && !sabrExcluded(exclude, ACCOUNT_PREFIX) : !sabrExcluded(exclude));

  // Zuletzt ging nur SABR (oder Test): gleich über SABR
  if (process.env.GXTUBE_FORCE_SABR === '1' || Date.now() < sabrFirstUntil) {
    const useAccount = sabrFirstAccount && process.env.GXTUBE_FORCE_SABR !== '1';
    if (sabrAllowed(useAccount)) {
      const sabr = await (useAccount ? sabrAccount() : sabrAnonymous()).catch(() => null);
      if (sabr) return chosen(sabr);
    }
  }

  let setupError = null;
  let accountExpired = false;
  for (const group of order) {
    let g;
    try {
      g = await group();
    } catch (e) {
      if (group === account) {
        accountExpired = /abgelaufen/.test(e?.message ?? '');
        failed(ctx, `Konto: ${e?.message ?? e}`);
      } else {
        setupError ??= friendlyError(e);
      }
      continue;
    }
    const result = await tryClients(id, g, ctx);
    if (result) return chosen(result);
  }
  // Keiner in voller Qualität mit direkten Adressen: wie der YouTube-Webplayer über SABR
  // Anonym nicht bei einer Bot-Sperre (das wären nur weitere Anfragen, die die Sperre verlängern) –
  // mit Konto schon, dann sogar zuerst: Der TV-Client kommt mit Konto durch die Sperre.
  const sabrTries = [];
  if (sabrAllowed(false) && !(ctx.botStop && !ctx.candidates.length)) sabrTries.push([false, sabrAnonymous]);
  if (sabrAllowed(true) && !accountExpired && !ctx.accountExpired) sabrTries.push([true, sabrAccount]);
  if (ctx.botStop) sabrTries.reverse();
  for (const [useAccount, attempt] of sabrTries) {
    try {
      const sabr = await attempt();
      if (sabr) {
        sabrFirstUntil = Date.now() + SABR_FIRST_MS;
        sabrFirstAccount = useAccount;
        return chosen(sabr);
      }
    } catch (e) {
      failed(ctx, `${useAccount ? ACCOUNT_PREFIX : ''}SABR: ${shortError(e)}`);
    }
  }
  // Keiner in voller Qualität: die beste Notlösung nehmen
  const fallback = bestCandidate(ctx.candidates);
  if (fallback) return chosen(fallback);
  if (setupError && !ctx.reasons.length) throw setupError;

  const reasons = ctx.reasons;
  const tried = reasons.filter((r) => !r.startsWith('Konto: ') && !notes.includes(r));
  // "Bot" nur melden, wenn wirklich alle Versuche daran scheiterten
  const bot = tried.length > 0 && tried.every((r) => BOT_REASON.test(r));
  const age = tried.some((r) => AGE_REASON.test(r));
  const blocked = tried.length > 0 && tried.every((r) => /gesperrt|status code 403/i.test(r));
  const strip = (r) => r?.replace(/^(Konto )?[A-Z_]+: /, '');
  let message;
  let signIn = false;
  if (accountExpired || ctx.accountExpired) {
    message = 'Deine Google-Anmeldung ist abgelaufen. Bitte melde dich neu an.';
    signIn = true;
  } else if (age) {
    message = withAccount ? 'Dieses Video ist altersbeschränkt und lässt sich mit deinem Konto nicht abspielen.' : 'Dieses Video ist altersbeschränkt. Melde dich mit Google an, um es anzusehen.';
    signIn = !withAccount;
  } else if (bot) {
    message = withAccount
      ? 'YouTube verlangt gerade eine Bot-Bestätigung – auch mit deinem Google-Konto. Bitte ein paar Minuten warten.'
      : 'YouTube verlangt gerade eine Bot-Bestätigung für Anfragen aus deinem Netz. Mit Google anmelden hilft meistens – oder ein paar Minuten warten.';
    signIn = !withAccount;
  } else if (blocked) {
    message = 'YouTube hat die Streams für dieses Video abgelehnt.';
    signIn = !withAccount;
  } else if (notes.length) {
    // Ein Weg lief schon an und ist im Player gescheitert – das ist der eigentliche Grund
    message = 'Video konnte nicht abgespielt werden: ' + strip(notes.at(-1)).replace(/^SABR [A-Z_]+: /, '');
  } else {
    message = 'Video konnte nicht geladen werden: ' + (strip(tried.find((r) => !BOT_REASON.test(r))) || strip(reasons[0]) || 'unbekannter Fehler');
  }
  throw new StreamError(message, reasons, { signIn });
}

// ------------------------------------------------------------------ Anmeldung per Code

const TOKEN_URL = 'https://www.youtube.com/o/oauth2/token';

export class DeviceLoginError extends Error {
  constructor(reason, detail) {
    super(detail || reason);
    this.reason = reason; // cancelled | expired | denied | error
  }
}

/**
 * Anmeldung wie YouTube auf dem Fernseher: Google gibt einen Code aus, den man auf dem Handy
 * unter google.com/device eingibt. [done] löst mit den Tokens auf, sobald dort bestätigt wurde.
 */
export async function startDeviceLogin() {
  const yt = await client().catch((e) => Promise.reject(friendlyError(e)));
  const oauth = yt.session.oauth;
  // Kennung von YouTube auf dem Fernseher (steht in dessen Skript)
  oauth.client_id ??= await oauth.getClientID();
  const identity = { ...oauth.client_id };
  const code = await oauth.getDeviceAndUserCode();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const expiresAt = Date.now() + (Number(code.expires_in) || 1800) * 1000;
  let timer = null;
  let finished = false;
  let fail = () => {};
  const done = new Promise((resolve, reject) => {
    let interval = Math.max(Number(code.interval) || 5, 2) * 1000;
    const finish = (fn) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      fn();
    };
    fail = (err) => finish(() => reject(err));
    const poll = async () => {
      if (finished) return;
      if (Date.now() > expiresAt) return fail(new DeviceLoginError('expired'));
      try {
        const res = await fetchImpl(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: identity.client_id, client_secret: identity.client_secret, code: code.device_code, grant_type: 'http://oauth.net/grant_type/device/1.0' }),
        });
        const data = await res.json();
        if (finished) return;
        if (data.access_token && data.refresh_token) {
          const { expires_in: expiresIn, ...rest } = data;
          const tokens = { ...rest, expiry_date: new Date(Date.now() + (Number(expiresIn) || 3600) * 1000).toISOString(), client: identity };
          return finish(() => resolve(tokens));
        }
        switch (data.error) {
          case 'authorization_pending':
            break;
          case 'slow_down':
            interval += 5000;
            break;
          case 'access_denied':
            return fail(new DeviceLoginError('denied'));
          case 'expired_token':
            return fail(new DeviceLoginError('expired'));
          default:
            return fail(new DeviceLoginError('error', data.error_description || data.error || `HTTP ${res.status}`));
        }
      } catch {
        // kurzer Netzaussetzer: weiter warten
      }
      if (!finished) timer = setTimeout(poll, interval);
    };
    timer = setTimeout(poll, interval);
  });
  return {
    userCode: code.user_code,
    verificationUrl: code.verification_url || 'https://www.google.com/device',
    expiresAt,
    done,
    cancel: () => fail(new DeviceLoginError('cancelled')),
  };
}

// ------------------------------------------------------------------ Kanäle und Abos

/** Kopf und Videos eines Kanals (anonym – klappt auch, wenn die Player-Anfragen gesperrt sind). */
export async function channel(id) {
  if (!CHANNEL_ID.test(id)) throw new Error('Ungültige Kanal-ID');
  return guarded(async () => {
    const yt = await client();
    const ch = await yt.getChannel(id);
    const head = ch.header?.content ?? ch.header; // PageHeaderView (neu) oder ältere Kopf-Varianten
    const name = ch.metadata?.title || text(head?.title) || text(ch.header?.author?.name) || '';
    const parts = (head?.metadata?.metadata_rows ?? []).flatMap((r) => (r.metadata_parts ?? []).map((p) => text(p.text))).filter(Boolean);
    const handle = parts.find((p) => p.startsWith('@')) || null;
    const subscribersText = parts.find((p) => /abonnent|subscriber/i.test(p)) || text(ch.header?.subscribers) || '';
    const videosText = parts.find((p) => /video/i.test(p)) || '';
    const avatar = bestThumb(head?.image?.avatar?.image ?? head?.image?.image ?? ch.metadata?.avatar ?? ch.metadata?.thumbnail ?? ch.header?.author?.thumbnails);
    const banner = fittingThumb(head?.banner?.image ?? ch.header?.banner, 1060);
    let list = { items: [], next: null };
    if (ch.has_videos) list = storeChannelVideos(await ch.getVideos(), { id, name });
    return { id, name, handle, subscribersText, videosText, avatar, banner, description: String(ch.metadata?.description ?? '').slice(0, 400), ...list };
  });
}

/** Kleinstes Bild, das mindestens [width] breit ist (Banner gibt es bis 2560 px – unnötig groß). */
function fittingThumb(list, width) {
  const arr = (Array.isArray(list) ? list : []).filter((t) => t?.url).sort((a, b) => (a.width || 0) - (b.width || 0));
  const pick = arr.find((t) => (t.width || 0) >= width) ?? arr.at(-1);
  return pick ? (pick.url.startsWith('//') ? 'https:' + pick.url : pick.url) : null;
}

/** Weitere Videos eines Kanals. */
export async function channelMore(token) {
  const prev = continuations.get(token);
  if (!prev) return { items: [], next: null };
  continuations.delete(token);
  return guarded(async () => storeChannelVideos(await prev.list.getContinuation(), prev.channel));
}

const continuations = new Map();
let continuationCounter = 0;

function storeChannelVideos(list, channelInfo) {
  let next = null;
  if (list.has_continuation) {
    next = 'c' + ++continuationCounter;
    continuations.set(next, { list, channel: channelInfo });
    for (const key of continuations.keys()) if (continuations.size > 20) continuations.delete(key);
  }
  // Auf der Kanalseite fehlt der Kanalname an den Videos – er ist ja klar
  const items = unique((list.videos ?? []).map(toVideo)).map((v) => ({ ...v, kind: 'video', channelId: v.channelId ?? channelInfo.id, channelName: channelInfo.name || v.channelName }));
  return { items, next };
}

/** Mit Google-Konto bei YouTube abonnieren bzw. das Abo beenden (Web-Client, sonst wie der Fernseher). */
export async function accountSubscribe(id, on) {
  if (!CHANNEL_ID.test(id)) throw new Error('Ungültige Kanal-ID');
  const { yt } = await accountClient();
  const endpoint = on ? '/subscription/subscribe' : '/subscription/unsubscribe';
  const body = { channelIds: [id], params: on ? 'EgIIAhgA' : 'CgIIAhgA' };
  try {
    await yt.actions.execute(endpoint, body);
  } catch (first) {
    try {
      await yt.actions.execute(endpoint, { ...body, client: 'TV' });
    } catch {
      throw new Error(shortError(first));
    }
  }
}

/** Abos aus dem YouTube-Konto (Liste "Kanäle"); null, wenn YouTube sie nicht herausgibt. */
export async function accountSubscriptions() {
  const { yt } = await accountClient();
  const res = await yt.actions.execute('/browse', { browseId: 'FEchannels' });
  const found = new Map();
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 40) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    const r = node.channelRenderer ?? node.gridChannelRenderer;
    if (r && CHANNEL_ID.test(r.channelId ?? '') && !found.has(r.channelId)) {
      const title = r.title?.simpleText ?? r.title?.runs?.map((x) => x.text).join('') ?? '';
      found.set(r.channelId, { id: r.channelId, name: title, thumbnail: bestThumb(r.thumbnail?.thumbnails) });
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  walk(res.data);
  return found.size ? [...found.values()] : null;
}

// Neue Videos der Abos über die öffentlichen RSS-Feeds der Kanäle: ohne Konto, ohne Bot-Sperre
const feedCache = new Map(); // Kanal → { at, videos }
const FEED_TTL_MS = 15 * 60 * 1000;

const xmlText = (s) =>
  String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

/** Einträge eines Kanal-Feeds (YouTube-RSS). */
export function parseFeed(xml, channelInfo = {}) {
  const out = [];
  for (const m of String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const pick = (re) => e.match(re)?.[1];
    const id = pick(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    if (!VIDEO_ID.test(id ?? '')) continue;
    const published = Date.parse(pick(/<published>([^<]+)<\/published>/) ?? '');
    const views = Number(pick(/<media:statistics views="(\d+)"/));
    out.push({
      id,
      title: xmlText(pick(/<title>([\s\S]*?)<\/title>/)),
      channelName: xmlText(pick(/<author>\s*<name>([\s\S]*?)<\/name>/)) || channelInfo.name || '',
      channelId: channelIdOf(pick(/<yt:channelId>([^<]+)<\/yt:channelId>/)) ?? channelInfo.id ?? null,
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      durationSec: -1,
      viewsText: Number.isFinite(views) && views > 0 ? `${views.toLocaleString('de-DE')} Aufrufe` : '',
      publishedAt: Number.isFinite(published) ? published : 0,
      isLive: false,
      isShort: /href="https:\/\/www\.youtube\.com\/shorts\//.test(e),
    });
  }
  return out;
}

/** Ungefährer Zeitpunkt aus "vor 3 Tagen" / "3 days ago" (für die Sortierung). */
export function approxPublished(textValue, now = Date.now()) {
  const units = { sekunde: 1e3, second: 1e3, minute: 6e4, stunde: 36e5, hour: 36e5, tag: 864e5, day: 864e5, woche: 6048e5, week: 6048e5, monat: 2592e6, month: 2592e6, jahr: 31536e6, year: 31536e6 };
  const m = String(textValue ?? '').toLowerCase().match(/(\d+)\s*(sekunde|second|minute|stunde|hour|tag|day|woche|week|monat|month|jahr|year)/);
  return m ? now - Number(m[1]) * units[m[2]] : 0;
}

// YouTube schaltet die RSS-Feeds zeitweise ab (404) – dann eine Weile gleich die Kanalseite nehmen
let rssFailures = 0;
let rssOffUntil = 0;

async function rssFeed(c) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const res = await fetchImpl(`https://www.youtube.com/feeds/videos.xml?channel_id=${c.id}`);
  if (!res.ok) throw new Error(`Feed ${res.status}`);
  return parseFeed(await res.text(), c);
}

async function channelFeed(c) {
  const cached = feedCache.get(c.id);
  if (cached && Date.now() - cached.at < FEED_TTL_MS) return cached.videos;
  let videos = null;
  if (Date.now() > rssOffUntil) {
    try {
      videos = await rssFeed(c);
      rssFailures = 0;
    } catch {
      if (++rssFailures >= 3) rssOffUntil = Date.now() + 60 * 60 * 1000;
    }
  }
  if (!videos) {
    // Ersatz: erste Seite der Kanalvideos
    const page = await channel(c.id);
    videos = page.items.map((v) => ({ ...v, publishedAt: approxPublished(v.publishedText) }));
  }
  feedCache.set(c.id, { at: Date.now(), videos });
  return videos;
}

/** Neueste Videos aller Abos (ohne Shorts), neueste zuerst. */
export async function subscriptionFeed(channels, limit = 48) {
  const list = (channels ?? []).filter((c) => CHANNEL_ID.test(c?.id ?? '')).slice(0, 100);
  const all = [];
  for (let i = 0; i < list.length; i += 8) {
    const batch = await Promise.all(list.slice(i, i + 8).map((c) => channelFeed(c).catch(() => [])));
    for (const videos of batch) all.push(...videos);
  }
  return all
    .filter((v) => !v.isShort)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, limit);
}
