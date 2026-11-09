// SponsorBlock: gesponserte Abschnitte im Video überspringen (oder stumm schalten), dazu das Highlight
// ("Zum Höhepunkt springen"), Hinweise wie "das ganze Video ist Werbung" und Kapitel aus der Community.
// Abfrage über die ersten 4 Zeichen des SHA-256-Hashs – die Video-ID bleibt privat.

import { createHash } from 'node:crypto';

export const CATEGORIES = {
  sponsor: 'Sponsor',
  selfpromo: 'Eigenwerbung',
  interaction: 'Erinnerung zum Abonnieren',
  intro: 'Intro',
  outro: 'Abspann',
  preview: 'Vorschau',
  music_offtopic: 'Nicht-Musik-Abschnitt',
  filler: 'Abschweifung',
};

// "Das ganze Video ist …" (actionType full)
const FULL_LABELS = {
  sponsor: 'Gesponsertes Video',
  selfpromo: 'Eigenwerbung',
  exclusive_access: 'Exklusiver Zugang (gesponsert)',
};

const ACTION_TYPES = ['skip', 'mute', 'full', 'poi', 'chapter'];
const TIMEOUT_MS = 8000;

/** Leeres Ergebnis (SponsorBlock aus, nichts gefunden oder nicht erreichbar). */
export const EMPTY = Object.freeze({ segments: [], highlight: null, full: null, chapters: [] });

/** Antwort der API in das aufbereiten, was der Player braucht. [categories]: was übersprungen werden soll. */
export function parseSegments(list, videoId, categories) {
  const wanted = new Set((categories ?? []).filter((c) => c in CATEGORIES));
  const entry = Array.isArray(list) ? list.find((e) => e?.videoID === videoId) : null;
  const all = (entry?.segments ?? []).filter((s) => Array.isArray(s?.segment) && s.segment.length >= 2);
  const ms = (v) => Math.max(0, Math.round(Number(v) * 1000) || 0);
  const segments = all
    .filter((s) => (s.actionType === 'skip' || s.actionType === 'mute') && wanted.has(s.category))
    .map((s) => ({
      startMs: ms(s.segment[0]),
      endMs: ms(s.segment[1]),
      category: s.category,
      label: CATEGORIES[s.category] ?? s.category,
      action: s.actionType,
      uuid: String(s.UUID ?? ''),
    }))
    .filter((s) => s.endMs > s.startMs && s.uuid)
    .sort((a, b) => a.startMs - b.startMs);
  const poi = all.find((s) => s.actionType === 'poi' && s.category === 'poi_highlight');
  const full = all.find((s) => s.actionType === 'full' && FULL_LABELS[s.category]);
  const chapters = all
    .filter((s) => s.actionType === 'chapter' && typeof s.description === 'string' && s.description.trim())
    .map((s) => ({ title: s.description.trim().slice(0, 120), startMs: ms(s.segment[0]), thumbnail: null }))
    .sort((a, b) => a.startMs - b.startMs);
  return {
    segments,
    highlight: poi ? { startMs: ms(poi.segment[0]), uuid: String(poi.UUID ?? '') } : null,
    full: full ? { category: full.category, label: FULL_LABELS[full.category] } : null,
    // Kapitel nur, wenn sie das Video gliedern (mindestens zwei)
    chapters: chapters.length >= 2 ? chapters : [],
  };
}

export async function segments(videoId, categories, fetchImpl = globalThis.fetch) {
  const cats = (categories ?? []).filter((c) => c in CATEGORIES);
  // Highlight, Kapitel und "ganzes Video" kommen immer mit – übersprungen wird nur, was eingestellt ist
  const query = [...new Set([...cats, 'poi_highlight', 'chapter', 'sponsor', 'selfpromo', 'exclusive_access'])];
  const prefix = createHash('sha256').update(videoId).digest('hex').slice(0, 4);
  const url =
    `https://sponsor.ajay.app/api/skipSegments/${prefix}?categories=${encodeURIComponent(JSON.stringify(query))}` +
    `&actionTypes=${encodeURIComponent(JSON.stringify(ACTION_TYPES))}`;
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return EMPTY;
    return parseSegments(await res.json(), videoId, cats);
  } catch {
    return EMPTY;
  }
}
