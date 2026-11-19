// Twitch-Chat über IRC (WebSocket), wie twitch.tv selbst. Ohne Anmeldung nur lesen (justinfan),
// mit Twitch-Konto auch schreiben und antworten. Emotes: Twitch selbst plus 7TV, BTTV und FFZ.
// Dazu: Raum-Modi (langsam, nur Follower …), Abos/Raids/Ankündigungen, beim Betreten die letzten
// Nachrichten (recent-messages.robotty.de) und wer zuletzt geschrieben hat (für @-Vorschläge).

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

const LINK = /^(https?:\/\/\S+|(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.(tv|com|de|net|org|gg|io|me|be|ly|at|ch|co|app|dev|eu|info|uk)(\/\S*)?)$/i;
const MENTION = /^@[A-Za-z0-9_]{2,25}$/;
const TRAILING = /[.,!?:;)]+$/;

/**
 * Nachricht in Stücke: { text }, { emote, name, url }, { mention } (Name ohne @) oder { link }.
 * [extra]: Map Name → Bild (7TV/BTTV/FFZ).
 */
export function fragments(text, emoteTag, extra = null) {
  const chars = Array.from(text);
  const out = [];
  let pos = 0;
  const addText = (piece) => {
    if (out.length && out[out.length - 1].text != null) out[out.length - 1].text += piece;
    else out.push({ text: piece });
  };
  const pushText = (s) => {
    if (!s) return;
    // Fremd-Emotes, Erwähnungen und Links stehen als eigene Wörter im Text
    for (const piece of s.split(/(\s+)/)) {
      if (!piece) continue;
      const e = extra?.get?.(piece);
      const core = piece.replace(TRAILING, '');
      if (e) out.push({ emote: true, name: piece, url: e });
      else if (MENTION.test(core)) {
        out.push({ mention: core.slice(1) });
        if (core.length < piece.length) addText(piece.slice(core.length));
      } else if (core.length > 4 && LINK.test(core)) {
        out.push({ link: core });
        if (core.length < piece.length) addText(piece.slice(core.length));
      } else addText(piece);
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

/** Emote-Positionen verschieben (wenn vorne Text wegfällt, z. B. "@name " bei Antworten). */
export function shiftEmoteTag(tag, by) {
  if (!tag || !by) return tag;
  const groups = new Map();
  for (const e of parseEmoteTag(tag)) {
    if (e.start + by < 0) continue;
    if (!groups.has(e.id)) groups.set(e.id, []);
    groups.get(e.id).push(`${e.start + by}-${e.end + by}`);
  }
  return [...groups].map(([id, r]) => `${id}:${r.join(',')}`).join('/') || null;
}

/** Badges ("broadcaster/1,subscriber/12") → ['broadcaster', 'subscriber', …]. */
export function badgeNames(tag) {
  return badgeList(tag).map((b) => b.split('/')[0]);
}

/** Badges mit Version ("subscriber/12") – für die Bilder. */
export function badgeList(tag) {
  return (tag || '')
    .split(',')
    .filter((b) => b && b.split('/')[0])
    .map((b) => (b.includes('/') && b.split('/')[1] ? b : `${b.split('/')[0]}/1`));
}

/** Häufige Twitch-Hinweise (NOTICE) auf Deutsch, sonst Twitchs Text. */
export function noticeText(id, text) {
  const map = {
    msg_slowmode: 'Langsamer Modus: Bitte kurz warten, bevor du wieder schreibst.',
    msg_followersonly: 'Dieser Chat ist nur für Follower.',
    msg_followersonly_zero: 'Dieser Chat ist nur für Follower.',
    msg_followersonly_followed: 'Dieser Chat ist nur für Follower, die schon länger folgen.',
    msg_subsonly: 'Dieser Chat ist nur für Abonnenten.',
    msg_emoteonly: 'In diesem Chat sind gerade nur Emotes erlaubt.',
    msg_r9k: 'Einzigartiger Chat: Deine Nachricht ist nicht einzigartig genug.',
    msg_duplicate: 'Du kannst dieselbe Nachricht nicht zweimal hintereinander schicken.',
    msg_ratelimit: 'Du schreibst zu schnell – bitte kurz warten.',
    msg_banned: 'Du bist in diesem Kanal gebannt.',
    msg_timedout: `Du bist gerade gesperrt (Timeout). ${text ?? ''}`.trim(),
    msg_verified_email: 'Zum Schreiben in diesem Chat musst du deine E-Mail-Adresse bei Twitch bestätigen.',
    msg_requires_verified_phone_number: 'Zum Schreiben in diesem Chat brauchst du eine bestätigte Telefonnummer bei Twitch.',
    msg_channel_suspended: 'Dieser Kanal ist gesperrt.',
    msg_suspended: 'Dein Konto ist gesperrt.',
  };
  return map[id] ?? text;
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

/** Kanal- und globale Emotes getrennt (für die Emote-Auswahl): [kanal, global]. */
export async function thirdPartyEmoteSets(roomId) {
  const all = await thirdPartyEmotes(roomId, true);
  return all;
}

/** Globale und Kanal-Emotes von 7TV, BTTV und FFZ (Fehler werden still übergangen). */
export async function thirdPartyEmotes(roomId, split = false) {
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
  return split ? [r, g] : new Map([...g, ...r]);
}

// ------------------------------------------------------------------ Verbindung

const ANNOUNCE = { BLUE: '#00d6d6', GREEN: '#00db84', ORANGE: '#ffb31a', PURPLE: '#9146ff', PRIMARY: '#9146ff' };
const NOTICE_LABELS = {
  sub: '⭐ Abo',
  resub: '⭐ Abo',
  subgift: '🎁 Geschenk-Abo',
  anonsubgift: '🎁 Geschenk-Abo',
  submysterygift: '🎁 Geschenk-Abos',
  anonsubmysterygift: '🎁 Geschenk-Abos',
  giftpaidupgrade: '🎁 Abo verlängert',
  anongiftpaidupgrade: '🎁 Abo verlängert',
  primepaidupgrade: '⭐ Abo',
  raid: '🚀 Raid',
  bitsbadgetier: '💎 Bits',
  viewermilestone: '🏆 Meilenstein',
};

/**
 * Chat eines Kanals. Ereignisse (Callbacks):
 *  onMessage(msg)       – { id, login, name, color, badges, badgeList, frags, text, action, self, system?, highlight?,
 *                           mention?, reply?: { id, login, name, text }, label?, accent?, time, history? }
 *  onDelete({ id?, login? }) – Nachricht/Nutzer gelöscht (ohne beides: Chat geleert)
 *  onUpdate({ id, newId?, failed? }) – eigene Nachricht: richtige ID von Twitch bzw. abgelehnt
 *  onInfo(text)         – Hinweis von Twitch (Slow-Mode, Fehler …)
 *  onState(state)       – 'connecting' | 'open' | 'closed'
 *  onRoom(room)         – { slow, followersOnly, subsOnly, emoteOnly, uniqueChat, roomId }
 *  onMe(me)             – { name, color, badges, badgeList, mod, vip, broadcaster }
 *  onEmotes()           – Emotes (7TV/BTTV/FFZ) geladen
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
    this.emotes = new Map(); // 7TV/BTTV/FFZ: Name → Bild
    this.twitchEmotes = new Map(); // eigene Twitch-Emotes (für die eigene Nachricht und die Auswahl)
    this.channelEmotes = new Map();
    this.globalEmotes = new Map();
    this.me = null; // USERSTATE: Farbe, Name, Abzeichen
    this.roomId = null;
    this.room = { slow: 0, followersOnly: -1, subsOnly: false, emoteOnly: false, uniqueChat: false };
    this.chatters = new Map(); // login → Anzeigename, zuletzt aktive zuletzt
    this.pendingSelf = [];
    this.lastSent = 0;
    this.historyLoaded = null;
  }

  get canSend() {
    return Boolean(this.auth && this.ws?.readyState === WebSocket.OPEN);
  }

  /** Kanal betreten. auth: { login, token } zum Schreiben, sonst nur lesen. */
  join(channel, auth = null) {
    const login = String(channel).toLowerCase();
    if (this.channel === login && this.ws && JSON.stringify(auth) === JSON.stringify(this.auth)) return;
    const same = this.channel === login;
    this.close();
    this.channel = login;
    this.auth = auth;
    this.backoff = 1000;
    if (!same) {
      this.chatters.clear();
      this.twitchEmotes = new Map();
      this.room = { slow: 0, followersOnly: -1, subsOnly: false, emoteOnly: false, uniqueChat: false };
    }
    this.#connect();
  }

  /** Die letzten Nachrichten des Kanals (vor dem Betreten geschrieben) – einmal pro Kanal. */
  async loadHistory(limit = 100) {
    const channel = this.channel;
    if (!channel || this.historyLoaded === channel) return;
    this.historyLoaded = channel;
    try {
      const res = await fetch(`https://recent-messages.robotty.de/api/v2/recent-messages/${encodeURIComponent(channel)}?limit=${limit}`);
      const json = res.ok ? await res.json() : null;
      const lines = Array.isArray(json?.messages) ? json.messages : [];
      if (this.channel !== channel || !lines.length) return;
      const room = parseIrc(lines[0]).tags['room-id'];
      if (room && room !== this.roomId) await this.#loadEmotes(room);
      for (const raw of lines) {
        const m = parseIrc(raw);
        if (m.command === 'PRIVMSG') this.h.onMessage?.({ ...this.#message(m), history: true });
        else if (m.command === 'USERNOTICE') for (const msg of this.#userNotice(m)) this.h.onMessage?.({ ...msg, history: true });
      }
    } catch {
      // ohne Verlauf geht's auch
    }
  }

  async #loadEmotes(room) {
    this.roomId = room;
    const [channel, global] = await thirdPartyEmoteSets(room).catch(() => [new Map(), new Map()]);
    if (room !== this.roomId) return;
    this.channelEmotes = channel;
    this.globalEmotes = global;
    this.emotes = new Map([...global, ...channel]);
    this.h.onEmotes?.();
  }

  /** Eigene Twitch-Emotes setzen (kommen über die Twitch-API aus dem Hauptprozess). */
  setTwitchEmotes(map) {
    this.twitchEmotes = new Map(Object.entries(map ?? {}));
    this.h.onEmotes?.();
  }

  /** Wer im Chat geschrieben hat, passend zu [prefix] (für @-Vorschläge), zuletzt aktive zuerst. */
  chattersMatching(prefix, limit = 8) {
    const p = String(prefix ?? '').toLowerCase();
    const list = [...this.chatters].reverse();
    if (this.channel && !this.chatters.has(this.channel)) list.push([this.channel, this.channel]);
    return list
      .filter(([login, name]) => login !== this.auth?.login && (login.startsWith(p) || name.toLowerCase().startsWith(p)))
      .slice(0, limit)
      .map(([login, name]) => ({ login, name }));
  }

  /** Langsamer Modus: Restzeit in ms (0 = darf schreiben). */
  cooldownLeft(now = Date.now()) {
    if (!this.room.slow || this.me?.mod || this.me?.vip || this.me?.broadcaster) return 0;
    return Math.max(0, this.lastSent + this.room.slow * 1000 - now);
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
      for (const line of String(e.data).split('\r\n')) {
        if (!line) continue;
        try {
          this.#line(line);
        } catch (err) {
          console.warn('[chat]', err);
        }
      }
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
      case 'ROOMSTATE': {
        const t = m.tags;
        const r = this.room;
        if (t.slow != null) r.slow = Number(t.slow) || 0;
        if (t['followers-only'] != null) r.followersOnly = Number(t['followers-only']);
        if (t['subs-only'] != null) r.subsOnly = t['subs-only'] === '1';
        if (t['emote-only'] != null) r.emoteOnly = t['emote-only'] === '1';
        if (t.r9k != null) r.uniqueChat = t.r9k === '1';
        if (t['room-id'] && t['room-id'] !== this.roomId) this.#loadEmotes(t['room-id']);
        this.h.onRoom?.({ ...r, roomId: this.roomId });
        break;
      }
      case 'USERSTATE':
      case 'GLOBALUSERSTATE': {
        // Nach dem Senden schickt Twitch die richtige ID der eigenen Nachricht
        if (m.command === 'USERSTATE' && m.tags.id) {
          const tmp = this.pendingSelf.shift();
          if (tmp) this.h.onUpdate?.({ id: tmp, newId: m.tags.id });
        }
        const list = m.command === 'USERSTATE' ? badgeList(m.tags.badges) : (this.me?.badgeList ?? badgeList(m.tags.badges));
        const names = list.map((b) => b.split('/')[0]);
        this.me = {
          name: m.tags['display-name'] || this.auth?.login,
          color: m.tags.color || null,
          badges: names,
          badgeList: list,
          broadcaster: Boolean(this.auth?.login && this.auth.login === this.channel),
          mod: names.includes('moderator') || names.includes('broadcaster'),
          vip: names.includes('vip'),
        };
        this.h.onMe?.(this.me);
        break;
      }
      case 'PRIVMSG':
        this.h.onMessage?.(this.#message(m));
        break;
      case 'USERNOTICE':
        for (const msg of this.#userNotice(m)) this.h.onMessage?.(msg);
        break;
      case 'CLEARCHAT': {
        const user = m.text?.toLowerCase();
        this.h.onDelete?.(user ? { login: user } : {});
        if (user && (this.me?.mod || user === this.auth?.login)) {
          const secs = Number(m.tags['ban-duration']);
          const who = user === this.auth?.login ? 'Du wurdest' : `${user} wurde`;
          this.h.onInfo?.(secs ? `${who} für ${secs < 60 ? `${secs} Sekunden` : secs < 3600 ? `${Math.floor(secs / 60)} Minuten` : `${Math.floor(secs / 3600)} Stunden`} gesperrt (Timeout).` : `${who} dauerhaft gebannt.`);
        }
        break;
      }
      case 'CLEARMSG':
        this.h.onDelete?.({ id: m.tags['target-msg-id'] });
        break;
      case 'NOTICE':
        if (/authentication failed|improperly formatted auth|invalid nick/i.test(m.text ?? '')) {
          this.h.onAuthFailed?.();
          // Ohne Anmeldung weiterlesen
          const channel = this.channel;
          setTimeout(() => this.join(channel, null), 0);
        } else {
          // Eigene Nachricht abgelehnt (langsamer Modus, doppelt, gesperrt …)
          if (String(m.tags['msg-id'] ?? '').startsWith('msg_')) {
            const tmp = this.pendingSelf.shift();
            if (tmp) this.h.onUpdate?.({ id: tmp, failed: true });
          }
          if (m.text) this.h.onInfo?.(noticeText(m.tags['msg-id'], m.text));
        }
        break;
      default:
        break;
    }
  }

  /** Abos, Raids, Ankündigungen … */
  #userNotice(m) {
    const kind = m.tags['msg-id'] ?? '';
    const sys = m.tags['system-msg']?.trim() || null;
    const time = Number(m.tags['tmi-sent-ts']) || Date.now();
    if (kind === 'announcement') {
      return m.text ? [{ ...this.#message(m), label: '📣 Ankündigung', accent: ANNOUNCE[(m.tags['msg-param-color'] || 'PRIMARY').toUpperCase()] ?? ANNOUNCE.PRIMARY, highlight: true }] : [];
    }
    const label = NOTICE_LABELS[kind] ?? null;
    const accent = kind === 'raid' ? '#ff6905' : '#9146ff';
    if (m.text) return [{ ...this.#message(m), label: [label, sys].filter(Boolean).join('  '), accent, highlight: true }];
    if (sys) return [{ id: m.tags.id ?? `sys-${time}-${Math.random()}`, system: true, highlight: true, label, accent, frags: [{ text: sys }], text: sys, time }];
    return [];
  }

  #message(m) {
    let text = m.text ?? '';
    // "/me": ACTION
    const action = /^\u0001ACTION (.*)\u0001$/.exec(text);
    if (action) text = action[1];
    const login = m.nick ?? m.tags.login ?? '';
    const name = m.tags['display-name'] || login;
    if (login) {
      this.chatters.delete(login);
      this.chatters.set(login, name);
      if (this.chatters.size > 800) this.chatters.delete(this.chatters.keys().next().value);
    }
    const t = m.tags;
    const reply = t['reply-parent-msg-id']
      ? { id: t['reply-parent-msg-id'], login: t['reply-parent-user-login'] ?? '', name: t['reply-parent-display-name'] || t['reply-parent-user-login'] || '', text: t['reply-parent-msg-body'] ?? '' }
      : null;
    // Bei Antworten steht "@name " vorne – Twitch blendet das aus (Emote-Positionen verschieben sich mit)
    let emoteTag = t.emotes;
    if (reply) {
      const prefix = new RegExp(`^@(${escapeRe(reply.login)}|${escapeRe(reply.name)})\\s+`, 'i').exec(text);
      if (prefix) {
        text = text.slice(prefix[0].length);
        emoteTag = shiftEmoteTag(emoteTag, -Array.from(prefix[0]).length);
      }
    }
    const mine = this.auth?.login;
    const first = t['first-msg'] === '1';
    const highlighted = t['msg-id'] === 'highlighted-message';
    const bits = Number(t.bits) || 0;
    const list = badgeList(t.badges);
    return {
      id: t.id ?? `${Date.now()}-${Math.random()}`,
      login,
      name,
      color: t.color || null,
      badges: list.map((b) => b.split('/')[0]),
      badgeList: list,
      frags: fragments(text, emoteTag, this.emotes),
      text,
      action: Boolean(action),
      self: Boolean(mine && login === mine),
      mention: Boolean(mine && login !== mine && (new RegExp(`(^|\\W)@?${escapeRe(mine)}(\\W|$)`, 'i').test(text) || reply?.login === mine)),
      reply,
      highlight: first || highlighted || bits > 0,
      label: first ? '👋 Erste Nachricht im Chat' : highlighted ? '✨ Hervorgehoben (Kanalpunkte)' : bits ? `💎 ${bits} Bits` : null,
      accent: first ? '#00db84' : highlighted ? '#00d6d6' : bits ? '#9146ff' : null,
      time: Number(t['tmi-sent-ts']) || Date.now(),
    };
  }

  /**
   * Nachricht schreiben (Twitch schickt die eigene nicht zurück – deshalb gleich anzeigen).
   * [replyTo]: { id, login, name, text } – Antwort auf diese Nachricht. [action]: als /me.
   */
  send(text, { replyTo = null, action = false } = {}) {
    let msg = String(text).replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
    if (!msg || !this.canSend) return false;
    const me = /^\/me (.+)$/.exec(msg);
    if (me) {
      msg = me[1];
      action = true;
    }
    const left = this.cooldownLeft();
    if (left > 0) {
      this.h.onInfo?.(`Langsamer Modus: Du kannst in ${Math.ceil(left / 1000)} Sekunden wieder schreiben.`);
      return false;
    }
    const reply = replyTo?.id && !/^(self-|sys-|info-)/.test(replyTo.id) ? replyTo : null;
    const body = action ? `\u0001ACTION ${msg}\u0001` : msg;
    this.ws.send(`${reply ? `@reply-parent-msg-id=${reply.id} ` : ''}PRIVMSG #${this.channel} :${body}`);
    this.lastSent = Date.now();
    const id = `self-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    this.pendingSelf.push(id);
    if (this.pendingSelf.length > 10) this.pendingSelf.shift();
    const list = this.me?.badgeList ?? [];
    this.h.onMessage?.({
      id,
      login: this.auth.login,
      name: this.me?.name || this.auth.login,
      color: this.me?.color ?? null,
      badges: list.map((b) => b.split('/')[0]),
      badgeList: list,
      frags: fragments(msg, '', new Map([...this.twitchEmotes, ...this.emotes])),
      text: msg,
      action,
      self: true,
      reply: reply ? { id: reply.id, login: reply.login, name: reply.name, text: reply.text } : null,
      time: Date.now(),
    });
    return true;
  }

  close() {
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    this.channel = null;
    this.pendingSelf = [];
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

function escapeRe(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
