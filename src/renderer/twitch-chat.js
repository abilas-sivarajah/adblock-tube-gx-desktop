// Twitch-Chat über IRC (WebSocket), wie twitch.tv selbst. Ohne Anmeldung nur lesen (justinfan),
// mit Twitch-Konto auch schreiben. Emotes: Twitch selbst plus 7TV, BTTV und FFZ.

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
const MAX_BACKOFF = 30_000;

// ------------------------------------------------------------------ IRC lesen

function unescapeTag(v) {
  return v.replace(/\\(.)/g, (_, c) => ({ s: ' ', ':': ';', '\\': '\\', r: '\r', n: '\n' })[c] ?? c);
}

/** Eine IRC-Zeile → { tags, prefix, nick, command, params, text }. */
export function parseIrc(line) {
  let rest = line;
  const tags = {};
  if (rest.startsWith('@')) {
    const end = rest.indexOf(' ');
    for (const part of rest.slice(1, end).split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) tags[part] = '';
      else tags[part.slice(0, eq)] = unescapeTag(part.slice(eq + 1));
    }
    rest = rest.slice(end + 1);
  }
  let prefix = null;
  if (rest.startsWith(':')) {
    const end = rest.indexOf(' ');
    prefix = rest.slice(1, end);
    rest = rest.slice(end + 1);
  }
  let text = null;
  const colon = rest.indexOf(' :');
  if (colon >= 0) {
    text = rest.slice(colon + 2);
    rest = rest.slice(0, colon);
  } else if (rest.startsWith(':')) {
    text = rest.slice(1);
    rest = '';
  }
  const [command = '', ...params] = rest.split(' ').filter(Boolean);
  const nick = prefix?.includes('!') ? prefix.slice(0, prefix.indexOf('!')) : null;
  return { tags, prefix, nick, command, params, text };
}

/** Twitch-Emotes aus dem Tag ("25:0-4,6-10/1902:12-16") → [{ id, start, end }] (Code-Point-Positionen). */
export function parseEmoteTag(tag) {
  const out = [];
  if (!tag) return out;
  for (const part of tag.split('/')) {
    const [id, ranges] = part.split(':');
    if (!id || !ranges) continue;
    for (const r of ranges.split(',')) {
      const [a, b] = r.split('-').map(Number);
      if (Number.isInteger(a) && Number.isInteger(b) && b >= a) out.push({ id, start: a, end: b });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

/**
 * Nachricht in Stücke: { text } oder { emote, name, url }. [extra]: Map Name → Bild (7TV/BTTV/FFZ).
 */
export function fragments(text, emoteTag, extra = null) {
  const chars = Array.from(text);
  const out = [];
  let pos = 0;
  const pushText = (s) => {
    if (!s) return;
    if (!extra?.size) return out.push({ text: s });
    // Fremd-Emotes stehen als eigene Wörter im Text
    for (const piece of s.split(/(\s+)/)) {
      if (!piece) continue;
      const e = extra.get(piece);
      if (e) out.push({ emote: true, name: piece, url: e });
      else if (out.length && out[out.length - 1].text != null) out[out.length - 1].text += piece;
      else out.push({ text: piece });
    }
  };
  for (const e of parseEmoteTag(emoteTag)) {
    if (e.start < pos || e.end >= chars.length) continue;
    pushText(chars.slice(pos, e.start).join(''));
    const name = chars.slice(e.start, e.end + 1).join('');
    out.push({ emote: true, name, url: `https://static-cdn.jtvnw.net/emoticons/v2/${e.id}/default/dark/1.0` });
    pos = e.end + 1;
  }
  pushText(chars.slice(pos).join(''));
  return out;
}

/** Badges ("broadcaster/1,subscriber/12") → ['broadcaster', 'subscriber', …]. */
function badgeNames(tag) {
  return (tag || '')
    .split(',')
    .map((b) => b.split('/')[0])
    .filter(Boolean);
}

// ------------------------------------------------------------------ Fremd-Emotes

const emoteCache = new Map(); // roomId|'global' → Promise<Map>

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function addSeventv(map, emotes) {
  for (const e of emotes ?? []) {
    const host = e?.data?.host;
    if (!e?.name || !host?.url) continue;
    const file = host.files?.find((f) => f.name === '1x.webp') ?? host.files?.[0];
    if (file) map.set(e.name, `https:${host.url}/${file.name}`);
  }
}

function addBttv(map, emotes) {
  for (const e of emotes ?? []) if (e?.code && e.id) map.set(e.code, `https://cdn.betterttv.net/emote/${e.id}/1x`);
}

function addFfz(map, sets) {
  for (const set of Object.values(sets ?? {})) {
    for (const e of set?.emoticons ?? []) {
      const url = e?.urls?.['1'];
      if (e?.name && url) map.set(e.name, url.startsWith('//') ? `https:${url}` : url);
    }
  }
}

function loadEmotes(key, loader) {
  if (!emoteCache.has(key)) emoteCache.set(key, loader());
  return emoteCache.get(key);
}

/** Globale und Kanal-Emotes von 7TV, BTTV und FFZ (Fehler werden still übergangen). */
export async function thirdPartyEmotes(roomId) {
  const global = loadEmotes('global', async () => {
    const map = new Map();
    const [ffz, bttv, stv] = await Promise.all([
      getJson('https://api.frankerfacez.com/v1/set/global'),
      getJson('https://api.betterttv.net/3/cached/emotes/global'),
      getJson('https://7tv.io/v3/emote-sets/global'),
    ]);
    addFfz(map, ffz?.sets);
    addBttv(map, bttv);
    addSeventv(map, stv?.emotes);
    return map;
  });
  const room = roomId
    ? loadEmotes(roomId, async () => {
        const map = new Map();
        const [ffz, bttv, stv] = await Promise.all([
          getJson(`https://api.frankerfacez.com/v1/room/id/${roomId}`),
          getJson(`https://api.betterttv.net/3/cached/users/twitch/${roomId}`),
          getJson(`https://7tv.io/v3/users/twitch/${roomId}`),
        ]);
        addFfz(map, ffz?.sets);
        addBttv(map, [...(bttv?.channelEmotes ?? []), ...(bttv?.sharedEmotes ?? [])]);
        addSeventv(map, stv?.emote_set?.emotes);
        return map;
      })
    : Promise.resolve(new Map());
  const [g, r] = await Promise.all([global, room]);
  return new Map([...g, ...r]);
}

// ------------------------------------------------------------------ Verbindung

/**
 * Chat eines Kanals. Ereignisse (Callbacks):
 *  onMessage(msg)       – { id, login, name, color, badges, frags, action, self, system?, highlight? }
 *  onDelete({ id?, login? }) – Nachricht/Nutzer gelöscht (ohne beides: Chat geleert)
 *  onInfo(text)         – Hinweis von Twitch (Slow-Mode, Fehler …)
 *  onState(state)       – 'connecting' | 'open' | 'closed'
 *  onAuthFailed()       – Twitch lehnt die Anmeldung ab
 */
export class TwitchChat {
  constructor(handlers = {}) {
    this.h = handlers;
    this.ws = null;
    this.channel = null;
    this.auth = null;
    this.backoff = 1000;
    this.timer = null;
    this.emotes = new Map();
    this.me = null; // USERSTATE: Farbe, Name
    this.roomId = null;
  }

  get canSend() {
    return Boolean(this.auth && this.ws?.readyState === WebSocket.OPEN);
  }

  /** Kanal betreten. auth: { login, token } zum Schreiben, sonst nur lesen. */
  join(channel, auth = null) {
    const login = String(channel).toLowerCase();
    if (this.channel === login && this.ws && JSON.stringify(auth) === JSON.stringify(this.auth)) return;
    this.close();
    this.channel = login;
    this.auth = auth;
    this.backoff = 1000;
    this.#connect();
  }

  #connect() {
    clearTimeout(this.timer);
    if (!this.channel) return;
    this.h.onState?.('connecting');
    const ws = new WebSocket(IRC_URL);
    this.ws = ws;
    ws.onopen = () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      if (this.auth) {
        ws.send(`PASS oauth:${this.auth.token}`);
        ws.send(`NICK ${this.auth.login}`);
      } else {
        ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
      }
      ws.send(`JOIN #${this.channel}`);
    };
    ws.onmessage = (e) => {
      for (const line of String(e.data).split('\r\n')) if (line) this.#line(line);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.h.onState?.('closed');
      // Neu verbinden, mit wachsender Pause
      this.timer = setTimeout(() => this.#connect(), this.backoff);
      this.backoff = Math.min(MAX_BACKOFF, this.backoff * 2);
    };
    ws.onerror = () => {};
  }

  #line(line) {
    const m = parseIrc(line);
    switch (m.command) {
      case 'PING':
        this.ws?.send(`PONG :${m.text ?? 'tmi.twitch.tv'}`);
        break;
      case 'RECONNECT':
        this.ws?.close();
        break;
      case 'JOIN':
        if (m.nick === (this.auth?.login ?? m.nick)) {
          this.backoff = 1000;
          this.h.onState?.('open');
        }
        break;
      case 'ROOMSTATE':
        if (m.tags['room-id'] && m.tags['room-id'] !== this.roomId) {
          this.roomId = m.tags['room-id'];
          const room = this.roomId;
          thirdPartyEmotes(room).then((map) => {
            if (room === this.roomId) this.emotes = map;
          });
        }
        break;
      case 'USERSTATE':
      case 'GLOBALUSERSTATE':
        this.me = { name: m.tags['display-name'] || this.auth?.login, color: m.tags.color || null, badges: badgeNames(m.tags.badges) };
        break;
      case 'PRIVMSG':
        this.h.onMessage?.(this.#message(m));
        break;
      case 'USERNOTICE': {
        // Abos, Raids, Geschenke …
        const sys = m.tags['system-msg'];
        if (sys) this.h.onMessage?.({ id: `sys-${m.tags.id ?? Date.now()}`, system: true, frags: [{ text: sys }] });
        if (m.text) this.h.onMessage?.({ ...this.#message(m), highlight: true });
        break;
      }
      case 'CLEARCHAT':
        this.h.onDelete?.(m.text ? { login: m.text.toLowerCase() } : {});
        break;
      case 'CLEARMSG':
        this.h.onDelete?.({ id: m.tags['target-msg-id'] });
        break;
      case 'NOTICE':
        if (/authentication failed|improperly formatted auth|invalid nick/i.test(m.text ?? '')) {
          this.h.onAuthFailed?.();
          // Ohne Anmeldung weiterlesen
          const channel = this.channel;
          setTimeout(() => this.join(channel, null), 0);
        } else if (m.text) this.h.onInfo?.(m.text);
        break;
      default:
        break;
    }
  }

  #message(m) {
    let text = m.text ?? '';
    // "/me": ACTION
    const action = /^\u0001ACTION (.*)\u0001$/.exec(text);
    if (action) text = action[1];
    const login = m.nick ?? '';
    return {
      id: m.tags.id ?? `${Date.now()}-${Math.random()}`,
      login,
      name: m.tags['display-name'] || login,
      color: m.tags.color || null,
      badges: badgeNames(m.tags.badges),
      frags: fragments(text, m.tags.emotes, this.emotes),
      action: Boolean(action),
      self: false,
      mention: Boolean(this.auth && new RegExp(`(^|\\W)@?${this.auth.login}(\\W|$)`, 'i').test(text)),
    };
  }

  /** Nachricht schreiben (Twitch schickt die eigene nicht zurück – deshalb gleich anzeigen). */
  send(text) {
    const msg = String(text).replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
    if (!msg || !this.canSend) return false;
    this.ws.send(`PRIVMSG #${this.channel} :${msg}`);
    const action = /^\/me (.*)$/.exec(msg);
    this.h.onMessage?.({
      id: `self-${Date.now()}`,
      login: this.auth.login,
      name: this.me?.name || this.auth.login,
      color: this.me?.color ?? null,
      badges: this.me?.badges ?? [],
      frags: fragments(action ? action[1] : msg, '', this.emotes),
      action: Boolean(action),
      self: true,
    });
    return true;
  }

  close() {
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    this.channel = null;
    this.roomId = null;
    this.emotes = new Map();
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // egal
      }
    }
    this.h.onState?.('closed');
  }
}
