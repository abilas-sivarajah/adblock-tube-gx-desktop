// Twitch-Chat-Extras für den Hauptprozess: Abzeichen-Bilder, Profilkarten, Chat-Wiedergabe bei VODs
// und die /-Befehle über die offizielle Twitch-API (Helix) – Twitch hat sie aus dem IRC-Chat entfernt.
// Ohne Electron-Abhängigkeit (Anfragen und Konto kommen aus twitch.js/configure).

import * as TW from './twitch.js';
import { NAMED_COLORS, allowed, findCommand, humanDuration, parseDuration } from '../renderer/chat-commands.js';

const LOGIN = /^[a-z0-9_]{1,25}$/;

// ------------------------------------------------------------------ Abzeichen und Profilkarte

const badgeCache = new Map();
const BADGE_FIELDS = 'setID version imageURL(size: DOUBLE)';

/** "set/version" → Bild (global und die eigenen des Kanals). */
export async function badges(login) {
  const key = String(login ?? '').toLowerCase();
  if (!LOGIN.test(key)) return {};
  if (badgeCache.has(key)) return badgeCache.get(key);
  const data = await TW.gql(`query($login: String!) { badges { ${BADGE_FIELDS} } user(login: $login) { broadcastBadges { ${BADGE_FIELDS} } } }`, { login: key });
  const out = {};
  for (const b of [...(data.badges ?? []), ...(data.user?.broadcastBadges ?? [])]) if (b?.setID && b.version && b.imageURL) out[`${b.setID}/${b.version}`] = b.imageURL;
  if (Object.keys(out).length) badgeCache.set(key, out);
  return out;
}

const userCache = new Map();

/** Profilkarte: Name, Bild, Konto-Alter, Follower, folgt dem Kanal seit. */
export async function chatUser(login, channel) {
  const l = String(login ?? '').toLowerCase();
  const ch = String(channel ?? '').toLowerCase();
  if (!LOGIN.test(l)) throw new TW.TwitchError('Ungültiger Nutzer');
  const key = `${l}@${ch}`;
  if (userCache.has(key)) return userCache.get(key);
  const data = await TW.gql('query($login: String!) { user(login: $login) { id login displayName profileImageURL(width: 150) createdAt description followers { totalCount } } }', { login: l });
  const u = data.user;
  if (!u) throw new TW.TwitchError('Nutzer nicht gefunden');
  const info = {
    id: u.id ?? null,
    login: u.login?.toLowerCase() ?? l,
    name: u.displayName || u.login || l,
    avatar: u.profileImageURL ?? null,
    createdAt: Date.parse(u.createdAt ?? '') || null,
    followers: u.followers?.totalCount ?? null,
    description: u.description?.trim() || null,
    followedAt: null,
  };
  // Seit wann folgt der Nutzer dem Kanal? (nicht immer verfügbar – dann eben ohne)
  if (LOGIN.test(ch) && ch !== l) {
    try {
      const f = await TW.gql('query($login: String!, $channel: String!) { user(login: $login) { follow(targetLogin: $channel) { followedAt } } }', { login: l, channel: ch });
      info.followedAt = Date.parse(f.user?.follow?.followedAt ?? '') || null;
    } catch {
      // egal
    }
  }
  userCache.set(key, info);
  return info;
}

// ------------------------------------------------------------------ Chat-Wiedergabe (VODs)

const REPLAY_QUERY =
  'query($id: ID!, $offset: Int, $cursor: Cursor) { video(id: $id) { comments(contentOffsetSeconds: $offset, after: $cursor) {' +
  ' edges { cursor node { id contentOffsetSeconds commenter { id login displayName }' +
  ' message { fragments { text emote { emoteID } } userBadges { setID version } userColor } } } pageInfo { hasNextPage } } } }';

/** Eine Nachricht der Chat-Wiedergabe: { id, offset, login, name, color, badges: ['set/version'], frags: [{ text } | { emoteId, name }] }. */
export function toReplayMessage(node) {
  if (!node) return null;
  const offset = Math.floor(Number(node.contentOffsetSeconds));
  if (!Number.isFinite(offset)) return null;
  const login = node.commenter?.login?.toLowerCase() ?? '';
  const frags = (node.message?.fragments ?? []).map((f) => (f?.emote?.emoteID ? { emoteId: String(f.emote.emoteID), name: f.text ?? '' } : { text: f?.text ?? '' }));
  return {
    id: node.id ?? `r-${offset}-${login}-${Math.random()}`,
    offset,
    login,
    name: node.commenter?.displayName || login,
    color: node.message?.userColor || null,
    badges: (node.message?.userBadges ?? []).filter((b) => b?.setID).map((b) => `${b.setID}/${b.version || '1'}`),
    frags,
  };
}

export function toReplayPage(conn) {
  const list = Array.isArray(conn?.edges) ? conn.edges : [];
  return {
    messages: list.map((e) => toReplayMessage(e?.node)).filter(Boolean),
    next: conn?.pageInfo?.hasNextPage && list.length ? (list[list.length - 1].cursor ?? null) : null,
  };
}

/** Ab Sekunde [offset] oder mit [cursor] weiter. */
export async function replay(vod, { offset = 0, cursor = null } = {}) {
  if (!/^\d{1,15}$/.test(String(vod))) throw new TW.TwitchError('Ungültiges Video');
  const vars = cursor ? { id: String(vod), cursor: String(cursor) } : { id: String(vod), offset: Math.max(0, Math.floor(Number(offset) || 0)) };
  const data = await TW.gql(REPLAY_QUERY, vars);
  if (!data.video?.comments) throw new TW.TwitchError('Für dieses Video gibt es keinen Chat');
  return toReplayPage(data.video.comments);
}

// ------------------------------------------------------------------ Helix (offizielle API)

const ids = new Map();

/** Anfrage an api.twitch.tv/helix mit dem angemeldeten Konto. */
export async function helix(method, path, { query = {}, body = null } = {}) {
  const account = TW.account();
  if (!account) throw new TW.TwitchError('Nicht bei Twitch angemeldet', { signIn: true });
  const u = new URL(`https://api.twitch.tv/helix/${path}`);
  for (const [k, v] of Object.entries(query)) if (v != null) u.searchParams.set(k, String(v));
  const headers = { 'Client-Id': account.clientId, Authorization: `Bearer ${account.token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await TW.request(u.toString(), { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  const message = String(json?.message ?? '');
  if (res.ok) return json ?? {};
  if (res.status === 401 && /scope/i.test(message)) throw new TW.TwitchError('GX Tube fehlen dafür Rechte bei Twitch – Einstellungen → Twitch → abmelden und neu anmelden.', { code: 'scope', signIn: true });
  if (res.status === 401) {
    TW.markUnauthorized();
    throw new TW.TwitchError('Twitch-Anmeldung abgelaufen', { code: 401, signIn: true });
  }
  if (res.status === 403) throw new TW.TwitchError(`Dafür fehlen dir in diesem Kanal die Rechte${message ? ` (${message})` : ''}`);
  if (res.status === 429) throw new TW.TwitchError('Zu viele Anfragen – bitte kurz warten');
  throw new TW.TwitchError(message || `Twitch-API: HTTP ${res.status}`);
}

export async function userId(login) {
  const l = String(login ?? '').replace(/^@/, '').toLowerCase();
  if (!LOGIN.test(l)) throw new TW.TwitchError(`Nutzer „${login}“ gibt es nicht`);
  if (ids.has(l)) return ids.get(l);
  const j = await helix('GET', 'users', { query: { login: l } });
  const id = j.data?.[0]?.id;
  if (!id) throw new TW.TwitchError(`Nutzer „${login}“ gibt es nicht`);
  ids.set(l, id);
  return id;
}

async function names(path, room) {
  const out = [];
  let after = null;
  do {
    const j = await helix('GET', path, { query: { broadcaster_id: room, first: 100, after } });
    for (const e of j.data ?? []) if (e?.user_name) out.push(e.user_name);
    after = j.pagination?.cursor ?? null;
  } while (after && out.length < 1000);
  return out.sort((a, b) => a.localeCompare(b));
}

const emoteUrl = (id) => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;

/** Twitch-Emotes, die man benutzen darf (eigene Abos, global …), sonst nur die globalen. { name: url } */
export async function usableEmotes(room, { userId: me, scopes = [] } = {}) {
  const out = {};
  const add = (j) => {
    for (const e of j?.data ?? []) if (e?.name && e.id && !out[e.name]) out[e.name] = emoteUrl(e.id);
  };
  if (me && scopes.includes('user:read:emotes')) {
    try {
      let after = null;
      let pages = 0;
      do {
        const j = await helix('GET', 'chat/emotes/user', { query: { user_id: me, broadcaster_id: room, after } });
        add(j);
        after = j.pagination?.cursor ?? null;
      } while (after && ++pages < 20);
    } catch {
      // dann eben die globalen
    }
  }
  if (!Object.keys(out).length) add(await helix('GET', 'chat/emotes/global'));
  return out;
}

/**
 * /-Befehl ausführen. ctx: { me: { userId, broadcaster, mod }, roomId, scopes }.
 * Gibt einen Hinweis für den Chat zurück (oder null) und wirft TwitchError mit verständlicher Meldung.
 */
export async function runCommand(name, args, ctx = {}) {
  const cmd = findCommand(name);
  if (!cmd) throw new TW.TwitchError(`Unbekannter Befehl: /${name} – /help zeigt alle Befehle.`);
  if (!allowed(cmd, ctx.me)) throw new TW.TwitchError(cmd.role === 'broadcaster' ? `/${cmd.name} kann nur der Streamer benutzen.` : `/${cmd.name} können nur Moderatoren benutzen.`);
  if (!TW.account()) throw new TW.TwitchError(`Für /${cmd.name} musst du bei Twitch angemeldet sein.`, { signIn: true });
  const scopes = ctx.scopes ?? [];
  if (cmd.scope && scopes.length && !scopes.includes(cmd.scope)) {
    throw new TW.TwitchError(`Für /${cmd.name} braucht GX Tube mehr Rechte bei Twitch: Einstellungen → Twitch → abmelden und neu anmelden.`, { code: 'scope' });
  }
  const text = String(args ?? '').trim();
  const words = text ? text.split(/\s+/) : [];
  if (cmd.args.startsWith('<') && !words.length) throw new TW.TwitchError(`So geht's: /${cmd.name} ${cmd.args} – ${cmd.description}`);
  if ((cmd.name === 'w' || cmd.name === 'warn') && words.length < 2) throw new TW.TwitchError(`So geht's: /${cmd.name} ${cmd.args} – ${cmd.description}`);
  const me = ctx.me?.userId;
  const room = ctx.roomId;
  if (!me) throw new TW.TwitchError('Konto nicht gefunden – bitte neu bei Twitch anmelden.');
  if (!room) throw new TW.TwitchError('Chat noch nicht verbunden');
  const target = words[0]?.replace(/^@/, '');
  const rest = (from) => words.slice(from).join(' ');
  const mod = { broadcaster_id: room, moderator_id: me };
  const settings = async (body) => {
    await helix('PATCH', 'chat/settings', { query: mod, body });
    return null; // Twitch meldet die Änderung selbst im Chat
  };
  switch (cmd.name) {
    case 'color': {
      const c = words[0].toLowerCase().replace(/_/g, '');
      const value = NAMED_COLORS[c] ?? (/^#?[0-9a-f]{6}$/.test(c) ? `#${c.replace('#', '').toUpperCase()}` : null);
      if (!value) throw new TW.TwitchError('Unbekannte Farbe – z. B. blue, red, hotpink, seagreen oder #9146FF (Hex nur mit Turbo/Prime)');
      await helix('PUT', 'chat/color', { query: { user_id: me, color: value } });
      return `Deine Namensfarbe ist jetzt ${words[0]}.`;
    }
    case 'w':
      await helix('POST', 'whispers', { query: { from_user_id: me, to_user_id: await userId(target) }, body: { message: rest(1) } });
      return `Geflüstert an ${target}: ${rest(1)}`;
    case 'block':
      await helix('PUT', 'users/blocks', { query: { target_user_id: await userId(target) } });
      return `${target} ist blockiert.`;
    case 'unblock':
      await helix('DELETE', 'users/blocks', { query: { target_user_id: await userId(target) } });
      return `${target} ist nicht mehr blockiert.`;
    case 'timeout':
    case 'ban': {
      const secs = cmd.name === 'timeout' ? parseDuration(words[1]) : null;
      const reason = cmd.name === 'timeout' ? rest(secs != null ? 2 : 1) : rest(1);
      const duration = cmd.name === 'timeout' ? Math.min(Math.max(secs ?? 600, 1), 1209600) : null;
      const data = { user_id: await userId(target) };
      if (duration != null) data.duration = duration;
      if (reason) data.reason = reason;
      await helix('POST', 'moderation/bans', { query: mod, body: { data } });
      return duration != null ? `${target} ist für ${humanDuration(duration)} gesperrt.` : `${target} ist gebannt.`;
    }
    case 'untimeout':
    case 'unban':
      await helix('DELETE', 'moderation/bans', { query: { ...mod, user_id: await userId(target) } });
      return cmd.name === 'unban' ? `${target} ist entbannt.` : `Timeout von ${target} aufgehoben.`;
    case 'warn':
      await helix('POST', 'moderation/warnings', { query: mod, body: { data: { user_id: await userId(target), reason: rest(1) } } });
      return `${target} wurde verwarnt.`;
    case 'clear':
      await helix('DELETE', 'moderation/chat', { query: mod });
      return null;
    case 'slow':
      return settings({ slow_mode: true, slow_mode_wait_time: Math.min(Math.max(parseDuration(words[0]) ?? 30, 3), 120) });
    case 'slowoff':
      return settings({ slow_mode: false });
    case 'followers':
      return settings({ follower_mode: true, follower_mode_duration: Math.min(Math.max(Math.floor((parseDuration(words[0]) ?? 0) / 60), 0), 129600) });
    case 'followersoff':
      return settings({ follower_mode: false });
    case 'subscribers':
      return settings({ subscriber_mode: true });
    case 'subscribersoff':
      return settings({ subscriber_mode: false });
    case 'emoteonly':
      return settings({ emote_mode: true });
    case 'emoteonlyoff':
      return settings({ emote_mode: false });
    case 'uniquechat':
      return settings({ unique_chat_mode: true });
    case 'uniquechatoff':
      return settings({ unique_chat_mode: false });
    case 'announce':
    case 'announceblue':
    case 'announcegreen':
    case 'announceorange':
    case 'announcepurple':
      await helix('POST', 'chat/announcements', { query: mod, body: { message: text, color: cmd.name.slice(8) || 'primary' } });
      return null;
    case 'shoutout':
      await helix('POST', 'chat/shoutouts', { query: { from_broadcaster_id: room, to_broadcaster_id: await userId(target), moderator_id: me } });
      return `Shoutout für ${target} gesendet.`;
    case 'mod':
    case 'unmod':
      await helix(cmd.name === 'mod' ? 'POST' : 'DELETE', 'moderation/moderators', { query: { broadcaster_id: room, user_id: await userId(target) } });
      return cmd.name === 'mod' ? `${target} ist jetzt Moderator.` : `${target} ist kein Moderator mehr.`;
    case 'vip':
    case 'unvip':
      await helix(cmd.name === 'vip' ? 'POST' : 'DELETE', 'channels/vips', { query: { broadcaster_id: room, user_id: await userId(target) } });
      return cmd.name === 'vip' ? `${target} ist jetzt VIP.` : `${target} ist kein VIP mehr.`;
    case 'mods':
      return `Moderatoren: ${(await names('moderation/moderators', room)).join(', ') || 'keine'}`;
    case 'vips':
      return `VIPs: ${(await names('channels/vips', room)).join(', ') || 'keine'}`;
    case 'raid':
      await helix('POST', 'raids', { query: { from_broadcaster_id: room, to_broadcaster_id: await userId(target) } });
      return `Raid zu ${target} startet …`;
    case 'unraid':
      await helix('DELETE', 'raids', { query: { broadcaster_id: room } });
      return 'Raid abgebrochen.';
    case 'commercial': {
      const len = Math.min(Math.max(parseDuration(words[0]) ?? 30, 30), 180);
      await helix('POST', 'channels/commercial', { body: { broadcaster_id: room, length: len } });
      return `Werbung läuft für ${len} Sekunden.`;
    }
    case 'marker':
      await helix('POST', 'streams/markers', { body: { user_id: room, ...(text ? { description: text.slice(0, 140) } : {}) } });
      return 'Markierung gesetzt.';
    default:
      throw new TW.TwitchError('Befehl nicht unterstützt');
  }
}

/** Einzelne Nachricht löschen (Moderatoren). */
export async function deleteMessage(messageId, ctx = {}) {
  if (!ctx.roomId || !ctx.me?.userId) throw new TW.TwitchError('Chat noch nicht verbunden');
  await helix('DELETE', 'moderation/chat', { query: { broadcaster_id: ctx.roomId, moderator_id: ctx.me.userId, message_id: String(messageId) } });
}
