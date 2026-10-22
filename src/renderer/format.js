// Anzeige von Zeiten und Zahlen (deutsch)

export function duration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

export const durationMs = (ms) => duration(ms / 1000);

export function speedLabel(v) {
  return v === 1 ? 'Normal' : String(v).replace('.', ',') + '×';
}

export function qualityLabel(h) {
  if (!h) return 'Auto';
  if (h >= 2160) return '4K';
  if (h >= 1440) return '1440p';
  return h + 'p';
}

/** "vor 3 Tagen" usw. für einen Zeitpunkt (ms). */
export function relativeTime(ms) {
  const diff = Date.now() - ms;
  if (!Number.isFinite(diff) || diff < 0) return '';
  const steps = [
    [365 * 864e5, 'Jahr', 'Jahren'],
    [30 * 864e5, 'Monat', 'Monaten'],
    [7 * 864e5, 'Woche', 'Wochen'],
    [864e5, 'Tag', 'Tagen'],
    [36e5, 'Stunde', 'Stunden'],
    [6e4, 'Minute', 'Minuten'],
  ];
  for (const [size, one, many] of steps) {
    const n = Math.floor(diff / size);
    if (n >= 1) return `vor ${n} ${n === 1 ? one : many}`;
  }
  return 'gerade eben';
}

/** Element mit Klasse und Text bauen – nie innerHTML mit Daten von außen. */
export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
