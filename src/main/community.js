// Community-Dienste – beide abschaltbar und standardmäßig aus:
// - DeArrow (dearrow.ajay.app): Titel und Vorschaubilder ohne Clickbait, von der Community gesammelt.
//   Die Titel kommen über den Hash-Präfix der Video-ID (wie SponsorBlock – die ID bleibt privat);
//   eigene Vorschaubilder liefert der Bild-Server von DeArrow (der sieht dabei die Video-ID).
// - Return YouTube Dislike: die Zahl der Daumen nach unten (die Video-ID geht an returnyoutubedislikeapi.com).

import { createHash } from 'node:crypto';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const TIMEOUT_MS = 8000;

// ------------------------------------------------------------------ DeArrow

const BRANDING_TTL_MS = 6 * 60 * 60 * 1000;
const branding = new Map(); // Video-ID → { at, value }
const prefixRequests = new Map(); // Hash-Präfix → Promise (gleichzeitige Anfragen bündeln)

const prefixOf = (id) => createHash('sha256').update(id).digest('hex').slice(0, 4);

/** DeArrow-Titel aufbereiten: ein führendes ">" heißt nur "nicht automatisch formatieren". */
export function cleanTitle(title) {
  return String(title ?? '')
    .replace(/^>\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bester Titel und bestes Vorschaubild eines Videos (nur von der Community, nicht das Original). */
export function parseBranding(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const trusted = (t) => !t?.original && (t?.locked || Number(t?.votes) >= 0);
  const title = (entry.titles ?? []).find((t) => trusted(t) && typeof t.title === 'string' && cleanTitle(t.title));
  const thumb = (entry.thumbnails ?? []).find((t) => trusted(t) && Number.isFinite(Number(t.timestamp)));
  const out = {};
  if (title) out.title = cleanTitle(title.title).slice(0, 300);
  if (thumb) out.thumbnailTime = Math.max(0, Number(thumb.timestamp));
  return out.title || out.thumbnailTime !== undefined ? out : null;
}

/** Adresse des Vorschaubilds von DeArrow (Bild an der gewählten Stelle des Videos). */
export function thumbnailUrl(videoId, time) {
  return `https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=${encodeURIComponent(videoId)}&time=${encodeURIComponent(String(time))}`;
}

async function fetchPrefix(prefix, fetchImpl) {
  if (!prefixRequests.has(prefix)) {
    const request = (async () => {
      const res = await fetchImpl(`https://sponsor.ajay.app/api/branding/${prefix}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 404) return {};
      if (!res.ok) throw new Error(`DeArrow ${res.status}`);
      const json = await res.json();
      return json && typeof json === 'object' ? json : {};
    })().finally(() => prefixRequests.delete(prefix));
    prefixRequests.set(prefix, request);
  }
  return prefixRequests.get(prefix);
}

/**
 * DeArrow für mehrere Videos: { id: { title?, thumbnail? } } – nur Videos, für die es etwas gibt.
 * Höchstens 6 Präfix-Anfragen gleichzeitig; Ergebnisse (auch "nichts") werden gemerkt.
 */
export async function brandingFor(ids, fetchImpl = globalThis.fetch) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => VIDEO_ID.test(id ?? '')))].slice(0, 100);
  const now = Date.now();
  const missing = list.filter((id) => !(branding.get(id) && now - branding.get(id).at < BRANDING_TTL_MS));
  const byPrefix = new Map();
  for (const id of missing) {
    const p = prefixOf(id);
    if (!byPrefix.has(p)) byPrefix.set(p, []);
    byPrefix.get(p).push(id);
  }
  const prefixes = [...byPrefix.keys()];
  for (let i = 0; i < prefixes.length; i += 6) {
    await Promise.all(
      prefixes.slice(i, i + 6).map(async (p) => {
        try {
          const data = await fetchPrefix(p, fetchImpl);
          for (const id of byPrefix.get(p)) branding.set(id, { at: now, value: parseBranding(data[id]) });
        } catch {
          // Server nicht erreichbar: diesmal ohne DeArrow, beim nächsten Mal wieder fragen
        }
      }),
    );
  }
  for (const key of branding.keys()) if (branding.size > 5000) branding.delete(key);
  const out = {};
  for (const id of list) {
    const value = branding.get(id)?.value;
    if (!value) continue;
    out[id] = { title: value.title ?? null, thumbnail: value.thumbnailTime !== undefined ? thumbnailUrl(id, value.thumbnailTime) : null };
  }
  return out;
}

// ------------------------------------------------------------------ Return YouTube Dislike

const VOTES_TTL_MS = 10 * 60 * 1000;
const votesCache = new Map(); // Video-ID → { at, value }

/** Likes und Dislikes eines Videos (Schätzung von Return YouTube Dislike) oder null. */
export async function votes(videoId, fetchImpl = globalThis.fetch) {
  if (!VIDEO_ID.test(videoId ?? '')) return null;
  const cached = votesCache.get(videoId);
  if (cached && Date.now() - cached.at < VOTES_TTL_MS) return cached.value;
  try {
    const res = await fetchImpl(`https://returnyoutubedislikeapi.com/votes?videoId=${videoId}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const j = await res.json();
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null);
    const value = { likes: num(j?.likes), dislikes: num(j?.dislikes) };
    if (value.dislikes === null) return null;
    votesCache.set(videoId, { at: Date.now(), value });
    for (const key of votesCache.keys()) if (votesCache.size > 500) votesCache.delete(key);
    return value;
  } catch {
    return null;
  }
}
