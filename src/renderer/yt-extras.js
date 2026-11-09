// Helfer für die YouTube-Ansicht – ohne DOM, damit sie sich auch ohne Fenster testen lassen:
// Kapitel, Vorschaubilder der Zeitleiste, Beschreibung mit Links/Zeitstempeln, DeArrow-Abfragen bündeln.

/** Index des Kapitels an der Stelle [ms] (oder -1 vor dem ersten). */
export function chapterAt(chapters, ms) {
  let index = -1;
  for (let i = 0; i < (chapters?.length ?? 0); i++) {
    if (chapters[i].startMs <= ms) index = i;
    else break;
  }
  return index;
}

/**
 * Ausschnitt aus dem Vorschaubild-Raster von YouTube für die Stelle [ms]:
 * Adresse des Rasters und die Lage des Bildes darin (in Pixeln des Originals).
 */
export function storyboardFrame(sb, ms, durationMs) {
  if (!sb?.template || !(sb.count > 0) || !(sb.columns > 0) || !(sb.rows > 0)) return null;
  const interval = sb.intervalMs > 0 ? sb.intervalMs : durationMs > 0 ? durationMs / sb.count : 0;
  if (!(interval > 0)) return null;
  const index = Math.min(sb.count - 1, Math.max(0, Math.floor(ms / interval)));
  const perSheet = sb.columns * sb.rows;
  const sheet = Math.floor(index / perSheet);
  const within = index % perSheet;
  return {
    url: sb.template.replace('$M', String(sheet)),
    x: (within % sb.columns) * sb.width,
    y: Math.floor(within / sb.columns) * sb.height,
    width: sb.width,
    height: sb.height,
  };
}

/** "1:02:03" → 3723000 ms (oder -1). */
export function stampToMs(stamp) {
  const parts = String(stamp).split(':').map((p) => Number(p));
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !Number.isInteger(p) || p < 0)) return -1;
  return parts.reduce((acc, p) => acc * 60 + p, 0) * 1000;
}

const PARTS = /(https?:\/\/[^\s<>"]+)|(?<![\d:])((?:\d{1,2}:)?\d{1,2}:\d{2})(?![\d:])/g;

/**
 * Text (Beschreibung, Kommentar) in Teile zerlegen: normaler Text, Links und Zeitstempel.
 * Satzzeichen am Ende eines Links gehören nicht zur Adresse.
 */
export function textParts(text) {
  const src = String(text ?? '');
  const parts = [];
  let last = 0;
  for (const m of src.matchAll(PARTS)) {
    if (m.index > last) parts.push({ type: 'text', text: src.slice(last, m.index) });
    if (m[1]) {
      const url = m[1].replace(/[),.;:!?'\]]+$/, '');
      parts.push({ type: 'link', text: url, url });
      if (url.length < m[1].length) parts.push({ type: 'text', text: m[1].slice(url.length) });
    } else {
      const ms = stampToMs(m[2]);
      parts.push(ms >= 0 ? { type: 'time', text: m[2], ms } : { type: 'text', text: m[2] });
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) parts.push({ type: 'text', text: src.slice(last) });
  return parts;
}

/** Video-ID aus einem YouTube-Link (watch, youtu.be, shorts, live) – sonst null. */
export function videoIdFromUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1);
    else if (host === 'youtube.com') id = u.pathname === '/watch' ? u.searchParams.get('v') : u.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)?.[1] ?? null;
    return /^[A-Za-z0-9_-]{11}$/.test(id ?? '') ? id : null;
  } catch {
    return null;
  }
}

/** Startzeit aus einem YouTube-Link (&t=90, &t=1m30s) in ms – sonst null. */
export function startFromUrl(url) {
  try {
    const t = new URL(url).searchParams.get('t');
    if (!t) return null;
    if (/^\d+$/.test(t)) return Number(t) * 1000;
    const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!m || !m[0]) return null;
    return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
  } catch {
    return null;
  }
}

/**
 * DeArrow-Abfragen bündeln: Karten melden ihre Video-ID, nach kurzer Zeit geht eine Sammelanfrage raus.
 * [fetchBatch](ids) liefert { id: { title?, thumbnail? } }; Ergebnisse (auch "nichts") werden gemerkt.
 */
export function createBrandingLoader(fetchBatch, { delayMs = 60, chunk = 60 } = {}) {
  const cache = new Map();
  let pending = new Map();
  let timer = null;
  const flush = async () => {
    timer = null;
    const batch = pending;
    pending = new Map();
    const ids = [...batch.keys()];
    for (let i = 0; i < ids.length; i += chunk) {
      const part = ids.slice(i, i + chunk);
      let result;
      try {
        result = (await fetchBatch(part)) ?? {};
      } catch {
        continue; // Dienst nicht erreichbar: diesmal ohne, später wieder fragen
      }
      for (const id of part) {
        const value = result[id] ?? null;
        cache.set(id, value);
        if (value) for (const cb of batch.get(id)) cb(value);
      }
    }
  };
  return {
    /** [cb] bekommt das Ergebnis – nur, wenn es für das Video etwas gibt. */
    get(id, cb) {
      if (cache.has(id)) {
        const value = cache.get(id);
        if (value) cb(value);
        return;
      }
      if (!pending.has(id)) pending.set(id, []);
      pending.get(id).push(cb);
      timer ??= setTimeout(flush, delayMs);
    },
    peek(id) {
      return cache.get(id) ?? null;
    },
    clear() {
      cache.clear();
    },
  };
}
