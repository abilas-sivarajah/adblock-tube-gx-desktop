// SponsorBlock: gesponserte Abschnitte im Video überspringen.
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

export async function segments(videoId, categories, fetchImpl = globalThis.fetch) {
  const cats = (categories ?? []).filter((c) => c in CATEGORIES);
  if (!cats.length) return [];
  const prefix = createHash('sha256').update(videoId).digest('hex').slice(0, 4);
  const url = `https://sponsor.ajay.app/api/skipSegments/${prefix}?categories=${encodeURIComponent(JSON.stringify(cats))}`;
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const list = await res.json();
    const entry = Array.isArray(list) ? list.find((e) => e.videoID === videoId) : null;
    return (entry?.segments ?? [])
      .filter((s) => s.actionType === 'skip' && Array.isArray(s.segment))
      .map((s) => ({
        startMs: Math.round(s.segment[0] * 1000),
        endMs: Math.round(s.segment[1] * 1000),
        category: s.category,
        label: CATEGORIES[s.category] ?? s.category,
        uuid: s.UUID,
      }))
      .filter((s) => s.endMs > s.startMs)
      .sort((a, b) => a.startMs - b.startMs);
  } catch {
    return [];
  }
}
