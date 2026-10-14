// Alle YouTube-Abfragen über YouTube.js (InnerTube) – ohne Werbedaten.
// Läuft im Hauptprozess; der Player im Fenster bekommt nur fertige Manifeste.

import { Innertube, Platform, UniversalCache, Log } from 'youtubei.js';

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
export const STREAM_CLIENTS = ['IOS', 'MWEB', 'TV_SIMPLY', 'ANDROID_VR', 'TV'];

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

let options = { lang: 'de', location: 'DE', fetch: undefined, cacheDir: undefined };
let clientPromise = null;
const searches = new Map();
let searchCounter = 0;

export function configure(opts) {
  options = { ...options, ...opts };
  clientPromise = null;
}

export function client() {
  if (!clientPromise) {
    clientPromise = Innertube.create({
      lang: options.lang,
      location: options.location,
      retrieve_player: true,
      generate_session_locally: true,
      fetch: options.fetch,
      cache: options.cacheDir ? new UniversalCache(true, options.cacheDir) : undefined,
    }).catch((e) => {
      clientPromise = null;
      throw e;
    });
  }
  return clientPromise;
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
      channelName: parts[0] || '',
      thumbnail: bestThumb(node.content_image?.image ?? node.content_image?.primary_thumbnail?.image, id),
      durationSec: parseDuration(durationText),
      viewsText: parts.find((p) => /aufrufe|views|zuschauer|watching/i.test(p)) || '',
      publishedText: parts.find((p) => /^vor |ago$|gestreamt|streamed/i.test(p)) || '',
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
  const yt = await client().catch((e) => Promise.reject(friendlyError(e)));
  const info = await guarded(() => yt.getInfo(id));
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
  constructor(message, reasons) {
    super(message);
    this.reasons = reasons;
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

// Clients, deren Streams kürzlich mitten im Video abgelehnt wurden, kommen eine Weile ans Ende.
const clientFailures = new Map(); // Client → Zeitpunkt
const FAILURE_PENALTY_MS = 60 * 60 * 1000;

export function reportClientFailure(clientName) {
  if (clientName) clientFailures.set(clientName, Date.now());
}

export function preferredClients(exclude = []) {
  const now = Date.now();
  const recentlyFailed = (c) => now - (clientFailures.get(c) ?? 0) < FAILURE_PENALTY_MS;
  const usable = STREAM_CLIENTS.filter((c) => !exclude.includes(c));
  return [...usable.filter((c) => !recentlyFailed(c)), ...usable.filter(recentlyFailed)];
}

/**
 * Sucht einen YouTube-Client, dessen Stream-Adressen wirklich abspielbar sind,
 * und baut daraus ein DASH-Manifest (getrennte Video- und Tonspur) bzw. nimmt
 * bei Live-Streams die HLS-Adresse.
 *
 * Geprüft wird die beste Videospur bis [maxHeight] mitten in der Datei: Manche Clients
 * liefern ohne "PO-Token" nur den Anfang oder nur niedrige Qualitäten.
 * [exclude]: Clients, die bei diesem Video schon versagt haben.
 */
export async function stream(id, { maxHeight = 1080, exclude = [], clients = preferredClients(exclude), check = true } = {}) {
  if (!VIDEO_ID.test(id)) throw new Error('Ungültige Video-ID');
  const yt = await client().catch((e) => Promise.reject(friendlyError(e)));
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const reasons = [];
  for (const clientName of clients) {
    try {
      const info = await yt.getBasicInfo(id, { client: clientName });
      const status = info.playability_status;
      if (status?.status !== 'OK') {
        reasons.push(`${clientName}: ${status?.reason || status?.status || 'nicht abspielbar'}`);
        // Privat / gelöscht: andere Clients ändern daran nichts
        if (status?.status === 'ERROR') break;
        continue;
      }
      const sd = info.streaming_data;
      const b = info.basic_info;
      const meta = {
        id,
        title: b.title ?? '',
        channelName: b.author ?? '',
        thumbnail: bestThumb(b.thumbnail, id),
        durationSec: b.duration ?? -1,
        isLive: Boolean(b.is_live),
        client: clientName,
      };
      if (b.is_live || b.is_post_live_dvr) {
        if (sd?.hls_manifest_url) return { ...meta, kind: 'hls', url: sd.hls_manifest_url };
        reasons.push(`${clientName}: kein Live-Stream`);
        continue;
      }
      const formats = sd?.adaptive_formats ?? [];
      const videos = formats.filter((f) => f.has_video && !f.has_audio);
      // Höchste erlaubte Auflösung; gibt es nichts darunter, die kleinste vorhandene
      const fitting = videos.filter((f) => (f.height || 0) <= maxHeight);
      const pool = fitting.length ? fitting : videos.sort((a, c) => (a.height || 0) - (c.height || 0)).slice(0, 1);
      const video = pool.sort((a, c) => (c.height || 0) - (a.height || 0) || (c.bitrate || 0) - (a.bitrate || 0))[0];
      const audio = formats.filter((f) => f.has_audio && !f.has_video).sort((a, c) => (c.bitrate || 0) - (a.bitrate || 0))[0];
      if (!video || !audio) {
        reasons.push(`${clientName}: keine Streams`);
        continue;
      }
      if (check) {
        const [videoUrl, audioUrl] = await Promise.all([video.decipher(yt.session.player), audio.decipher(yt.session.player)]);
        const middle = (f) => (Number(f.content_length) || 0) * 0.5;
        const [videoOk, audioOk] = await Promise.all([
          urlWorks(videoUrl, fetchImpl, middle(video)),
          urlWorks(audioUrl, fetchImpl, middle(audio)),
        ]);
        if (!videoOk || !audioOk) {
          reasons.push(`${clientName}: Stream gesperrt (${!videoOk ? `Video ${video.height}p` : 'Ton'})`);
          continue;
        }
      }
      const cap = video.height || maxHeight;
      const manifest = await info.toDash({
        // Nur Videospuren bis zur geprüften Auflösung – darüber sperrt YouTube manchmal
        format_filter: (f) => f.has_video && (f.height || 0) > cap,
      });
      return { ...meta, kind: 'dash', manifest, maxHeight: cap };
    } catch (e) {
      reasons.push(`${clientName}: ${e?.message?.split('\n')[0] || e}`);
    }
  }
  const bot = reasons.some((r) => /bot|sign in|anmelden|status code (403|429)/i.test(r));
  throw new StreamError(
    bot
      ? 'YouTube blockiert gerade Anfragen aus deinem Netz („Bestätige, dass du kein Bot bist“). Später erneut versuchen.'
      : 'Video konnte nicht geladen werden: ' + (reasons[0]?.replace(/^[A-Z_]+: /, '') || 'unbekannter Fehler'),
    reasons,
  );
}
