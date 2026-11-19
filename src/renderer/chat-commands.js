// /-Befehle im Twitch-Chat (wie auf twitch.tv und in der GX Tube Android-App): Liste mit Erklärung
// für die Vorschläge beim Tippen, Rollen und Dauer-Angaben. Ohne DOM und ohne Electron – wird im
// Fenster (Vorschläge) und im Hauptprozess (Ausführen über die Twitch-API) benutzt.

export const ROLE = { ALL: 'all', MOD: 'mod', BROADCASTER: 'broadcaster' };

const c = (name, args, description, role = ROLE.ALL, scope = null, user = false) => ({ name, args, description, role, scope, user });

export const COMMANDS = [
  c('me', '<Nachricht>', 'Nachricht als Aktion (farbig, kursiv)'),
  c('color', '<Farbe>', 'Namensfarbe ändern (z. B. blue, hotpink oder #9146FF)', ROLE.ALL, 'user:manage:chat_color'),
  c('w', '<Nutzer> <Nachricht>', 'Flüstern (private Nachricht)', ROLE.ALL, 'user:manage:whispers', true),
  c('user', '<Nutzer>', 'Profilkarte öffnen', ROLE.ALL, null, true),
  c('block', '<Nutzer>', 'Nutzer blockieren', ROLE.ALL, 'user:manage:blocked_users', true),
  c('unblock', '<Nutzer>', 'Blockierung aufheben', ROLE.ALL, 'user:manage:blocked_users', true),
  c('help', '', 'Alle Befehle anzeigen'),
  // Moderatoren
  c('timeout', '<Nutzer> [Dauer] [Grund]', 'Nutzer vorübergehend sperren (Dauer z. B. 10m, 1h, 1d – Standard 10 Min.)', ROLE.MOD, 'moderator:manage:banned_users', true),
  c('untimeout', '<Nutzer>', 'Timeout aufheben', ROLE.MOD, 'moderator:manage:banned_users', true),
  c('ban', '<Nutzer> [Grund]', 'Nutzer dauerhaft bannen', ROLE.MOD, 'moderator:manage:banned_users', true),
  c('unban', '<Nutzer>', 'Bann aufheben', ROLE.MOD, 'moderator:manage:banned_users', true),
  c('warn', '<Nutzer> <Grund>', 'Nutzer verwarnen', ROLE.MOD, 'moderator:manage:warnings', true),
  c('clear', '', 'Chat für alle leeren', ROLE.MOD, 'moderator:manage:chat_messages'),
  c('slow', '[Sekunden]', 'Langsamer Modus (Standard 30 s)', ROLE.MOD, 'moderator:manage:chat_settings'),
  c('slowoff', '', 'Langsamen Modus aus', ROLE.MOD, 'moderator:manage:chat_settings'),
  c('followers', '[Dauer]', 'Nur Follower (z. B. 10m, 1d – Standard: alle Follower)', ROLE.MOD, 'moderator:manage:chat_settings'),
  c('followersoff', '', 'Nur-Follower-Modus aus', ROLE.MOD, 'moderator:manage:chat_settings'),
  c('subscribers', '', 'Nur Abonnenten', ROLE.MOD, 'moderator:manage:chat_settings'),
  c('subscribersoff', '', 'Nur-Abonnenten-Modus aus', ROLE.MOD, 'moderator:manage:chat_settings'),
  c('emoteonly', '', 'Nur Emotes', ROLE.MOD, 'moderator:manage:chat_settings'),
  c('emoteonlyoff', '', 'Nur-Emotes-Modus aus', ROLE.MOD, 'moderator:manage:chat_settings'),
  c('uniquechat', '', 'Einzigartiger Chat (keine doppelten Nachrichten)', ROLE.MOD, 'moderator:manage:chat_settings'),
  c('uniquechatoff', '', 'Einzigartigen Chat aus', ROLE.MOD, 'moderator:manage:chat_settings'),
  c('announce', '<Nachricht>', 'Ankündigung (hervorgehoben)', ROLE.MOD, 'moderator:manage:announcements'),
  c('announceblue', '<Nachricht>', 'Ankündigung in Blau', ROLE.MOD, 'moderator:manage:announcements'),
  c('announcegreen', '<Nachricht>', 'Ankündigung in Grün', ROLE.MOD, 'moderator:manage:announcements'),
  c('announceorange', '<Nachricht>', 'Ankündigung in Orange', ROLE.MOD, 'moderator:manage:announcements'),
  c('announcepurple', '<Nachricht>', 'Ankündigung in Lila', ROLE.MOD, 'moderator:manage:announcements'),
  c('shoutout', '<Kanal>', 'Shoutout für einen Kanal', ROLE.MOD, 'moderator:manage:shoutouts', true),
  // Streamer
  c('mod', '<Nutzer>', 'Zum Moderator machen', ROLE.BROADCASTER, 'channel:manage:moderators', true),
  c('unmod', '<Nutzer>', 'Moderator entfernen', ROLE.BROADCASTER, 'channel:manage:moderators', true),
  c('mods', '', 'Moderatoren anzeigen', ROLE.BROADCASTER, 'moderation:read'),
  c('vip', '<Nutzer>', 'Zum VIP machen', ROLE.BROADCASTER, 'channel:manage:vips', true),
  c('unvip', '<Nutzer>', 'VIP entfernen', ROLE.BROADCASTER, 'channel:manage:vips', true),
  c('vips', '', 'VIPs anzeigen', ROLE.BROADCASTER, 'channel:read:vips'),
  c('raid', '<Kanal>', 'Anderen Kanal raiden', ROLE.BROADCASTER, 'channel:manage:raids', true),
  c('unraid', '', 'Raid abbrechen', ROLE.BROADCASTER, 'channel:manage:raids'),
  c('commercial', '[Sekunden]', 'Werbung starten (30–180 s)', ROLE.BROADCASTER, 'channel:edit:commercial'),
  c('marker', '[Beschreibung]', 'Stream-Markierung setzen', ROLE.BROADCASTER, 'channel:manage:broadcast'),
];

const ALIASES = {
  unbanuser: 'unban',
  untimeoutuser: 'untimeout',
  whisper: 'w',
  followersonly: 'followers',
  followersonlyoff: 'followersoff',
  subs: 'subscribers',
  subsoff: 'subscribersoff',
  r9kbeta: 'uniquechat',
  r9kbetaoff: 'uniquechatoff',
  so: 'shoutout',
};

/** me: { broadcaster, mod } */
export function allowed(cmd, me) {
  if (cmd.role === ROLE.BROADCASTER) return Boolean(me?.broadcaster);
  if (cmd.role === ROLE.MOD) return Boolean(me?.broadcaster || me?.mod);
  return true;
}

export function findCommand(name) {
  const n = String(name ?? '').toLowerCase();
  return COMMANDS.find((cmd) => cmd.name === (ALIASES[n] ?? n)) ?? null;
}

/** Befehle für die Vorschläge beim Tippen. */
export function commandSuggestions(prefix, me) {
  const p = String(prefix ?? '').toLowerCase();
  return COMMANDS.filter((cmd) => allowed(cmd, me) && cmd.name.startsWith(p));
}

/** Sekunden aus "10m", "1h", "2d", "1w", "30s" oder "600" (sonst null). */
export function parseDuration(s) {
  const m = /^(\d+)([smhdw]?)$/i.exec(String(s ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  const f = { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2].toLowerCase()];
  return Math.min(n * f, 2 ** 31 - 1);
}

export function humanDuration(secs) {
  if (secs < 60) return `${secs} Sekunden`;
  if (secs < 3600) return `${Math.floor(secs / 60)} Minuten`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} Stunden`;
  return `${Math.floor(secs / 86400)} Tage`;
}

/** Twitchs feste Namensfarben (Eingabe ohne Unterstrich, z. B. "hotpink") → Wert für die API. */
export const NAMED_COLORS = {
  blue: 'blue',
  blueviolet: 'blue_violet',
  cadetblue: 'cadet_blue',
  chocolate: 'chocolate',
  coral: 'coral',
  dodgerblue: 'dodger_blue',
  firebrick: 'firebrick',
  goldenrod: 'golden_rod',
  green: 'green',
  hotpink: 'hot_pink',
  orangered: 'orange_red',
  red: 'red',
  seagreen: 'sea_green',
  springgreen: 'spring_green',
  yellowgreen: 'yellow_green',
};

/** "/ban x grund" → { name, args, words } (name klein, ohne "/"), sonst null. ".ban" geht auch. */
export function parseCommand(text) {
  const t = String(text ?? '').trim();
  const m = /^[/.]([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(t);
  if (!m) return null;
  if (t.startsWith('.') && !findCommand(m[1])) return null;
  const args = (m[2] ?? '').trim();
  return { name: m[1].toLowerCase(), args, words: args ? args.split(/\s+/) : [] };
}
