// GX-Tube-Streaming-Protokoll (Handy → PC). Beschreibung: PROTOCOL.md
// Alles, was übers Netz kommt, wird hier geprüft und auf erlaubte Werte zurechtgestutzt.

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 8765;
export const DISCOVERY_PORT = 8766;
export const WS_PATH = '/gxtube';
export const MAX_QUEUE = 500;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

export class ProtocolError extends Error {}

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function num(value, min, max, fallback = null) {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function imageUrl(value) {
  if (typeof value !== 'string' || value.length > 1000) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

// Twitch: Live-Stream 'twitch:<login>', VOD 'twitch-vod:<id>'
const TWITCH_LIVE = /^twitch:([a-z0-9_]{1,25})$/;
const TWITCH_VOD = /^twitch-vod:(\d{1,15})$/;
const TWITCH_LOGIN = /^[a-z0-9_]{1,25}$/;

export const isTwitchVideo = (id) => typeof id === 'string' && (TWITCH_LIVE.test(id) || TWITCH_VOD.test(id));

function sanitizeTwitch(v) {
  const live = TWITCH_LIVE.exec(v.id);
  const login = live ? live[1] : TWITCH_LOGIN.test(v.channelLogin ?? '') ? v.channelLogin : null;
  return {
    id: v.id,
    platform: 'twitch',
    title: str(v.title, 300),
    channelName: str(v.channelName, 200),
    channelId: null,
    channelLogin: login,
    thumbnail: imageUrl(v.thumbnail) ?? (live ? `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-440x248.jpg` : null),
    durationSec: live ? -1 : Math.round(num(v.durationSec, -1, 1e7, -1)),
    isLive: Boolean(live),
  };
}

/** Ein Video, wie es Handy und PC austauschen. Unbekannte Felder fallen weg. */
export function sanitizeVideo(v) {
  if (v && typeof v === 'object' && isTwitchVideo(v.id)) return sanitizeTwitch(v);
  if (!v || typeof v !== 'object' || !VIDEO_ID.test(v.id ?? '')) throw new ProtocolError('Ungültiges Video');
  return {
    id: v.id,
    title: str(v.title, 300),
    channelName: str(v.channelName, 200),
    channelId: CHANNEL_ID.test(v.channelId ?? '') ? v.channelId : null,
    thumbnail: imageUrl(v.thumbnail) ?? `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    durationSec: Math.round(num(v.durationSec, -1, 1e7, -1)),
    isLive: v.isLive === true,
  };
}

/** Ein Twitch-Kanal (fürs Folgen). */
export function sanitizeTwitchChannel(c) {
  const login = typeof c?.login === 'string' ? c.login.toLowerCase() : '';
  if (!TWITCH_LOGIN.test(login)) throw new ProtocolError('Ungültiger Kanal');
  return { login, userId: /^\d{1,20}$/.test(String(c.userId ?? '')) ? String(c.userId) : null, name: str(c.name, 200) || login, avatar: imageUrl(c.avatar) };
}

/** Ein Kanal (fürs Abonnieren). */
export function sanitizeChannel(c) {
  if (!c || typeof c !== 'object' || !CHANNEL_ID.test(c.id ?? '')) throw new ProtocolError('Ungültiger Kanal');
  return { id: c.id, name: str(c.name, 200), thumbnail: imageUrl(c.thumbnail) };
}

function sanitizeQueue(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const item of list.slice(0, MAX_QUEUE)) {
    try {
      out.push(sanitizeVideo(item));
    } catch {
      // einzelne kaputte Einträge überspringen
    }
  }
  return out;
}

function index(value) {
  const n = num(value, 0, MAX_QUEUE);
  if (n === null || !Number.isInteger(n)) throw new ProtocolError('Ungültige Position');
  return n;
}

/** Prüft einen Befehl vom Handy. Wirft ProtocolError bei Unsinn. */
export function parseCommand(raw) {
  let msg;
  try {
    msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new ProtocolError('Kein gültiges JSON');
  }
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') throw new ProtocolError('Typ fehlt');
  const { type } = msg;
  switch (type) {
    case 'hello':
      return {
        type,
        name: str(msg.name, 80) || 'Handy',
        deviceId: str(msg.deviceId, 80),
        app: str(msg.app, 80),
        protocol: num(msg.protocol, 0, 1000, 0),
      };
    case 'play': {
      const video = sanitizeVideo(msg.video);
      return {
        type,
        video,
        queue: sanitizeQueue(msg.queue),
        startMs: num(msg.startMs, 0, 1e10),
      };
    }
    case 'add':
      return { type, video: sanitizeVideo(msg.video), next: msg.next === true };
    case 'jump':
    case 'remove':
      return { type, index: index(msg.index) };
    case 'seek':
      return { type, positionMs: num(msg.positionMs, 0, 1e10, 0) };
    case 'seekBy':
      return { type, deltaMs: num(msg.deltaMs, -1e9, 1e9, 0) };
    case 'volume':
      return { type, value: Math.round(num(msg.value, 0, 100, 100)) };
    case 'volumeBy':
      return { type, delta: Math.round(num(msg.delta, -100, 100, 0)) };
    case 'mute':
      return { type, muted: msg.muted === true };
    case 'speed':
      return { type, value: num(msg.value, 0.25, 3, 1) };
    case 'autoplay':
      return { type, enabled: msg.enabled === true };
    case 'fullscreen':
      // ohne "on": umschalten
      return { type, on: typeof msg.on === 'boolean' ? msg.on : null };
    case 'display': {
      const id = typeof msg.id === 'number' && Number.isSafeInteger(msg.id) ? msg.id : null;
      if (id === null) throw new ProtocolError('Bildschirm fehlt');
      return { type, id };
    }
    case 'pause':
    case 'resume':
    case 'toggle':
    case 'next':
    case 'previous':
    case 'stop':
    case 'clearQueue':
    case 'ping':
      return { type };
    default:
      throw new ProtocolError(`Unbekannter Befehl: ${str(type, 40)}`);
  }
}

/** Antwort auf eine Suche im WLAN (UDP). */
export function discoveryReply({ id, name, port, version }) {
  return JSON.stringify({
    type: 'device',
    protocol: PROTOCOL_VERSION,
    app: 'GX Tube Desktop',
    id,
    name,
    port,
    version,
  });
}

export function isDiscoveryRequest(buf) {
  if (buf.length > 2048) return false;
  try {
    const msg = JSON.parse(buf.toString('utf8'));
    return msg?.type === 'discover';
  } catch {
    return false;
  }
}

/**
 * Nur Geräte aus dem eigenen Netz dürfen steuern: private IPv4-Bereiche,
 * Loopback, Link-Local und private IPv6-Adressen (fc00::/7, fe80::/10).
 */
export function isLocalAddress(address) {
  if (!address) return false;
  let a = address.toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a.includes(':')) {
    return a === '::1' || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
  }
  const p = a.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  return (
    p[0] === 10 ||
    p[0] === 127 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 169 && p[1] === 254) ||
    // Carrier-Grade-NAT (manche Mesh-/Gast-Netze)
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
  );
}
