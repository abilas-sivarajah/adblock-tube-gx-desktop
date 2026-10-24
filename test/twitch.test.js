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
