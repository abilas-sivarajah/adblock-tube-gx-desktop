import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as TW from '../src/main/twitch.js';
import { fragments, parseEmoteTag, parseIrc } from '../src/renderer/twitch-chat.js';

test('Twitch-IDs', () => {
  assert.deepEqual(TW.parseId('twitch:trymacs'), { vod: null, login: 'trymacs' });
  assert.deepEqual(TW.parseId('twitch-vod:2906596560'), { vod: '2906596560', login: null });
  assert.equal(TW.parseId('twitch:v123').login, 'v123', 'Logins dürfen mit v anfangen');
  assert.equal(TW.parseId('dQw4w9WgXcQ'), null);
  assert.equal(TW.parseId('twitch:Groß'), null);
  assert.equal(TW.liveId('TryMacs'), 'twitch:trymacs');
  assert.equal(TW.vodId('42'), 'twitch-vod:42');
});

test('Stream, VOD, Kategorie und Kanal aus GraphQL', () => {
  const s = TW.toStream({
    title: 'Craft Attack',
    viewersCount: 54160,
    createdAt: '2026-10-24T14:42:41Z',
    previewImageURL: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_trymacs-440x248.jpg',
    game: { id: '27471', name: 'Minecraft', displayName: 'Minecraft' },
    broadcaster: { id: '64342766', login: 'TryMacs', displayName: 'Trymacs', profileImageURL: 'https://x/a.png' },
  });
  assert.equal(s.id, 'twitch:trymacs');
  assert.equal(s.channelLogin, 'trymacs');
  assert.equal(s.viewers, 54160);
  assert.equal(s.isLive, true);
  assert.equal(s.startedAt, Date.parse('2026-10-24T14:42:41Z'));
  assert.equal(s.game.displayName, 'Minecraft');
  assert.equal(TW.toStream({ title: 'x' }), null);

  // Noch laufendes VOD: Twitch hat noch kein Vorschaubild ("404_processing") → Live-Vorschau
  const v = TW.toVod({ id: '2909502093', title: 'Opening', lengthSeconds: 30480, viewCount: 6330, publishedAt: '2026-10-24T14:42:47Z', previewThumbnailURL: 'https://vod-secure.twitch.tv/_404/404_processing_320x180.png' }, { login: 'trymacs', displayName: 'Trymacs' });
  assert.equal(v.id, 'twitch-vod:2909502093');
  assert.equal(v.durationSec, 30480);
  assert.equal(v.thumbnail, 'https://static-cdn.jtvnw.net/previews-ttv/live_user_trymacs-320x180.jpg');
  assert.equal(v.isLive, false);
  assert.equal(TW.toVod({ id: 'abc' }), null);

  assert.deepEqual(TW.toGame({ id: '509658', name: 'Just Chatting', displayName: 'Just Chatting', viewersCount: 3, boxArtURL: 'https://b' }), { kind: 'game', id: '509658', name: 'Just Chatting', displayName: 'Just Chatting', boxArt: 'https://b', viewers: 3 });
  const c = TW.toChannel({ id: '1', login: 'Papaplatte', displayName: 'Papaplatte', followers: { totalCount: 10 }, stream: { title: 'live', viewersCount: 5 } });
  assert.equal(c.login, 'papaplatte');
  assert.equal(c.followers, 10);
  assert.equal(c.live.id, 'twitch:papaplatte');
});

test('Suchvorschläge: Kanäle, Kategorien und Suchbegriffe', () => {
  const list = TW.toSuggestions({
    edges: [
      { node: { text: 'xRohat', matchingCharacters: { start: 0, end: 1 }, content: { __typename: 'SearchSuggestionChannel', isLive: true, isVerified: true, login: 'xrohat', profileImageURL: 'https://x/50.png', user: { id: '430023505', login: 'xrohat', displayName: 'xRohat', profileImageURL: 'https://x/70.png', stream: { title: 'Charity', viewersCount: 2208, game: { name: 'Fortnite', displayName: 'Fortnite' } } } } } },
      { node: { text: 'MontanaBlack88', matchingCharacters: { start: 0, end: 0 }, content: { __typename: 'SearchSuggestionChannel', isLive: false, isVerified: false, login: 'montanablack88', profileImageURL: 'https://x/m.png', user: { id: '1', login: 'montanablack88', displayName: 'MontanaBlack88', stream: null } } } },
      { node: { text: 'Minecraft', matchingCharacters: { start: 0, end: 4 }, content: { __typename: 'SearchSuggestionCategory', game: { id: '27471', name: 'Minecraft', displayName: 'Minecraft', viewersCount: 13642, boxArtURL: 'https://b' } } } },
      { node: { text: 'minecraft cape', matchingCharacters: { start: 0, end: 99 }, content: null } },
      // Doppelt, leer oder kaputt: weg
      { node: { text: 'Minecraft Cape', content: null } },
      { node: { text: '  ', content: null } },
      { node: { text: 'Kaputt', content: { __typename: 'SearchSuggestionChannel', login: 'nicht gültig!' } } },
      { node: { text: 'Ohne Spiel', content: { __typename: 'SearchSuggestionCategory', game: null } } },
      null,
    ],
  });
  assert.deepEqual(list.map((s) => [s.type, s.text]), [['channel', 'xRohat'], ['channel', 'MontanaBlack88'], ['category', 'Minecraft'], ['query', 'minecraft cape']]);
  const [live, offline, cat, query] = list;
  assert.deepEqual(live.match, [0, 1]);
  assert.equal(live.verified, true);
  assert.equal(live.avatar, 'https://x/70.png');
  assert.equal(live.live.id, 'twitch:xrohat');
  assert.equal(live.live.viewers, 2208);
  assert.equal(live.live.channelName, 'xRohat');
  assert.equal(offline.live, null);
  assert.equal(offline.match, null, 'Leere Stelle → nichts hervorheben');
  assert.equal(cat.game.name, 'Minecraft');
  assert.equal(cat.game.viewers, 13642);
  assert.equal(query.match, null, 'Stelle außerhalb des Texts → nichts hervorheben');
  assert.deepEqual(TW.toSuggestions(null), []);
});

test('Suche: Kanäle, Kategorien, Live mit Tag, VODs und weitere Kanäle', async () => {
  const bodies = [];
  const user = (login, stream = null) => ({ id: login, login, displayName: login, profileImageURL: null, followers: { totalCount: 1 }, stream });
  TW.configure({
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const data = body.variables.after
        ? { searchFor: { channels: { cursor: '', items: [user('papaplatte_73'), user('trymacs')] } } }
        : {
            channels: { channels: { cursor: 'MTU=', items: [user('papaplatte_afk'), user('fan', { viewersCount: 5 }), user('papaplatte'), user('big', { viewersCount: 900 })] } },
            more: {
              channelsWithTag: { items: [user('a', { viewersCount: 10, freeformTags: [{ name: 'Deutsch' }] }), user('b', { viewersCount: 99 }), user('offline'), user('a', { viewersCount: 10 })] },
              videos: { items: [{ id: '42', title: 'VOD', lengthSeconds: 60, owner: { login: 'papaplatte', displayName: 'Papaplatte' } }, { id: 'kaputt' }] },
            },
            searchCategories: { edges: [{ node: { name: 'Just Chatting', displayName: 'Just Chatting' } }] },
          };
      return new Response(JSON.stringify({ data }), { status: 200 });
    },
  });
  const r = await TW.search('Papaplatte');
  assert.equal(bodies[0].variables.q, 'Papaplatte');
  // Genau der gesuchte zuerst, dann live nach Zuschauern, dann offline in Twitchs Reihenfolge
  assert.deepEqual(r.channels.map((c) => c.login), ['papaplatte', 'big', 'fan', 'papaplatte_afk']);
  assert.equal(r.next, 'MTU=');
  assert.deepEqual(r.games.map((g) => g.name), ['Just Chatting']);
  assert.deepEqual(r.live.map((v) => [v.id, v.viewers]), [['twitch:b', 99], ['twitch:a', 10]]);
  assert.deepEqual(r.live[1].tags, ['Deutsch']);
  assert.deepEqual(r.videos.map((v) => [v.id, v.channelLogin]), [['twitch-vod:42', 'papaplatte']]);

  const more = await TW.searchChannels('trymacs', 'MTU=');
  assert.equal(bodies[1].variables.after, 'MTU=');
  assert.deepEqual(more.items.map((c) => c.login), ['trymacs', 'papaplatte_73']);
  assert.equal(more.next, null, 'Leerer Cursor → Ende');
  TW.configure({ fetch: (...a) => fetch(...a) });
});

test('Wiedergabe-Adresse (usher)', () => {
  const live = new URL(TW.usherUrl({ login: 'trymacs', token: { value: '{"a":1}', signature: 'abc' } }));
  assert.equal(live.origin + live.pathname, 'https://usher.ttvnw.net/api/channel/hls/trymacs.m3u8');
  assert.equal(live.searchParams.get('sig'), 'abc');
  assert.equal(live.searchParams.get('token'), '{"a":1}');
  assert.equal(live.searchParams.get('supported_codecs'), 'avc1');
  assert.equal(live.searchParams.get('allow_source'), 'true');
  const vod = new URL(TW.usherUrl({ vod: '42', token: { value: 'v', signature: 's' } }));
  assert.equal(vod.pathname, '/vod/42.m3u8');
});

test('GraphQL: Fehler und Konto', async () => {
  const calls = [];
  let expired = 0;
  TW.configure({
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      if (init.headers.Authorization === 'OAuth alt') return new Response(JSON.stringify({ error: 'Unauthorized', status: 401 }), { status: 401 });
      return new Response(JSON.stringify({ data: { user: null } }), { status: 200 });
    },
    auth: () => ({ token: 'alt', clientId: TW.TV_CLIENT }),
    unauthorized: () => expired++,
  });
  // Ohne Konto: Fernseher-Client (kein Integritäts-Check beim Weiterblättern)
  await assert.rejects(TW.channel('niemand'), /Kanal nicht gefunden/);
  assert.equal(calls[0].headers['Client-ID'], TW.TV_CLIENT);
  assert.equal(calls[0].headers.Authorization, undefined);
  // Mit abgelaufenem Konto: gemeldet und als Anmeldefehler geworfen
  await assert.rejects(TW.currentUser(), (e) => e.signIn === true && e.code === 401);
  assert.equal(expired, 1);
  await assert.rejects(TW.channel('UNGÜLTIG!'), /Ungültiger Kanal/);
  TW.configure({ fetch: (...a) => fetch(...a), auth: () => null, unauthorized: () => {} });
});

test('Chat: IRC-Zeilen lesen', () => {
  const m = parseIrc('@badge-info=;badges=moderator/1,subscriber/12;color=#1E90FF;display-name=Semi_58er;emotes=25:0-4,12-16;id=abc;room-id=64342766 :semi_58er!semi_58er@semi_58er.tmi.twitch.tv PRIVMSG #trymacs :Kappa hallo Kappa');
  assert.equal(m.command, 'PRIVMSG');
  assert.equal(m.nick, 'semi_58er');
  assert.deepEqual(m.params, ['#trymacs']);
  assert.equal(m.text, 'Kappa hallo Kappa');
  assert.equal(m.tags['display-name'], 'Semi_58er');
  assert.equal(m.tags.badges, 'moderator/1,subscriber/12');
  assert.equal(parseIrc('PING :tmi.twitch.tv').command, 'PING');
  assert.equal(parseIrc('PING :tmi.twitch.tv').text, 'tmi.twitch.tv');
  assert.equal(parseIrc('@system-msg=5\\sMonate\\sdabei! :tmi.twitch.tv USERNOTICE #x').tags['system-msg'], '5 Monate dabei!');
  assert.deepEqual(parseEmoteTag('25:0-4,12-16/1902:6-10'), [
    { id: '25', start: 0, end: 4 },
    { id: '1902', start: 6, end: 10 },
    { id: '25', start: 12, end: 16 },
  ]);
});

test('Chat: Emotes von Twitch und 7TV/BTTV/FFZ', () => {
  const extra = new Map([['KEKW', 'https://cdn.7tv.app/emote/1/1x.webp']]);
  const f = fragments('Kappa 😀 KEKW nice', '25:0-4', extra);
  assert.deepEqual(f, [
    { emote: true, name: 'Kappa', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0' },
    { text: ' 😀 ' },
    { emote: true, name: 'KEKW', url: 'https://cdn.7tv.app/emote/1/1x.webp' },
    { text: ' nice' },
  ]);
  // Positionen zählen Zeichen (Code Points), nicht UTF-16-Einheiten
  assert.equal(fragments('😀 Kappa', '25:2-6')[1].name, 'Kappa');
  // Kaputte Positionen werden ignoriert
  assert.deepEqual(fragments('hi', '25:5-9'), [{ text: 'hi' }]);
});

test('Gefolgte über die offizielle Twitch-API (mit Weiterblättern)', async () => {
  const seen = [];
  let expired = 0;
  TW.configure({
    fetch: async (url, init) => {
      seen.push({ url, headers: init?.headers });
      const after = new URL(url).searchParams.get('after');
      const page = after
        ? { data: [{ broadcaster_id: '2', broadcaster_login: 'papaplatte', broadcaster_name: 'Papaplatte', followed_at: '2024-01-01T00:00:00Z' }], pagination: {} }
        : { total: 2, data: [{ broadcaster_id: '1', broadcaster_login: 'TryMacs', broadcaster_name: 'Trymacs', followed_at: '2023-01-01T00:00:00Z' }], pagination: { cursor: 'abc' } };
      return new Response(JSON.stringify(page), { status: 200 });
    },
    auth: () => ({ token: 'tok', clientId: TW.TV_CLIENT }),
    unauthorized: () => expired++,
  });
  const list = await TW.followedChannels('42');
  assert.deepEqual(list.map((c) => [c.login, c.userId, c.name]), [['trymacs', '1', 'Trymacs'], ['papaplatte', '2', 'Papaplatte']]);
  assert.equal(seen.length, 2);
  assert.match(seen[0].url, /^https:\/\/api\.twitch\.tv\/helix\/channels\/followed\?user_id=42&first=100$/);
  assert.match(seen[1].url, /after=abc/);
  assert.equal(seen[0].headers['Client-Id'], TW.TV_CLIENT);
  assert.equal(seen[0].headers.Authorization, 'Bearer tok');

  // Fehlende Berechtigung: verständlicher Fehler, Anmeldung bleibt gültig
  TW.configure({
    fetch: async (url) =>
      url.includes('/helix/')
        ? new Response(JSON.stringify({ error: 'Unauthorized', status: 401, message: 'Missing scope: user:read:follows' }), { status: 401 })
        : new Response(JSON.stringify({ data: { currentUser: null } }), { status: 200 }),
    auth: () => ({ token: 'tok', clientId: TW.TV_CLIENT }),
    unauthorized: () => expired++,
  });
  await assert.rejects(TW.followedChannels('42'), /Berechtigung|Lesen der gefolgten/);
  assert.equal(expired, 0);
  TW.configure({ fetch: (...a) => fetch(...a), auth: () => null, unauthorized: () => {} });
});
