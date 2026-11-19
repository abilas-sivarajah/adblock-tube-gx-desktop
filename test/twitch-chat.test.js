import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as TW from '../src/main/twitch.js';
import * as TwChat from '../src/main/twitch-extras.js';
import { badgeList, fragments, noticeText, shiftEmoteTag } from '../src/renderer/twitch-chat.js';
import { allowed, commandSuggestions, findCommand, parseCommand, parseDuration } from '../src/renderer/chat-commands.js';

const online = process.env.GXTUBE_ONLINE_TESTS === '1';

test('Chat: Erwähnungen, Links, Abzeichen mit Version, Antworten', () => {
  assert.deepEqual(fragments('@Trymacs schau mal twitch.tv/papaplatte, ok?', ''), [
    { mention: 'Trymacs' },
    { text: ' schau mal ' },
    { link: 'twitch.tv/papaplatte' },
    { text: ', ok?' },
  ]);
  assert.deepEqual(fragments('hi @abc_12!', ''), [{ text: 'hi ' }, { mention: 'abc_12' }, { text: '!' }]);
  assert.deepEqual(fragments('z.B. so', ''), [{ text: 'z.B. so' }], 'normale Wörter mit Punkt sind keine Links');
  assert.deepEqual(badgeList('moderator/1,subscriber/3012,vip'), ['moderator/1', 'subscriber/3012', 'vip/1']);
  assert.equal(shiftEmoteTag('25:12-16,18-22/1902:24-28', -12), '25:0-4,6-10/1902:12-16');
  assert.equal(noticeText('msg_duplicate', 'x'), 'Du kannst dieselbe Nachricht nicht zweimal hintereinander schicken.');
  assert.equal(noticeText('unbekannt', 'Original'), 'Original');
});

test('/-Befehle: Rollen, Aliase, Dauer, Eingabe', () => {
  const viewer = { mod: false, broadcaster: false };
  const mod = { mod: true };
  const streamer = { broadcaster: true };
  const names = (me) => commandSuggestions('', me).map((c) => c.name);
  assert.ok(names(viewer).includes('me') && names(viewer).includes('color') && !names(viewer).includes('ban'));
  assert.ok(names(mod).includes('ban') && names(mod).includes('slow') && !names(mod).includes('raid'));
  assert.ok(names(streamer).includes('raid') && names(streamer).includes('ban'));
  assert.deepEqual(commandSuggestions('time', mod).map((c) => c.name), ['timeout']);
  assert.equal(findCommand('unbanuser').name, 'unban');
  assert.equal(findCommand('so').name, 'shoutout');
  assert.equal(findCommand('gibtsnicht'), null);
  assert.equal(allowed(findCommand('raid'), mod), false);
  assert.equal(parseDuration('10m'), 600);
  assert.equal(parseDuration('1w'), 604800);
  assert.equal(parseDuration('bald'), null);
  assert.deepEqual(parseCommand('/ban  Troll  zu laut'), { name: 'ban', args: 'Troll  zu laut', words: ['Troll', 'zu', 'laut'] });
  assert.equal(parseCommand('.timeout x').name, 'timeout');
  assert.equal(parseCommand('...ok'), null, 'Punkte am Anfang sind kein Befehl');
  assert.equal(parseCommand('hallo'), null);
});

test('Befehle laufen über die Twitch-API (Helix)', async () => {
  const calls = [];
  TW.configure({
    fetch: async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers });
      if (url.includes('/helix/users?')) return new Response(JSON.stringify({ data: [{ id: '777', login: 'troll' }] }), { status: 200 });
      return new Response(null, { status: 204 });
    },
    auth: () => ({ token: 'tok', clientId: TW.TV_CLIENT }),
    unauthorized: () => {},
  });
  const ctx = { me: { userId: '42', mod: true }, roomId: '100', scopes: [] };
  assert.equal(await TwChat.runCommand('timeout', '@Troll 1h spam', ctx), 'Troll ist für 1 Stunden gesperrt.');
  const ban = calls.find((c) => c.url.includes('/moderation/bans'));
  assert.equal(ban.method, 'POST');
  assert.match(ban.url, /broadcaster_id=100&moderator_id=42/);
  assert.deepEqual(ban.body, { data: { user_id: '777', duration: 3600, reason: 'spam' } });
  assert.equal(ban.headers.Authorization, 'Bearer tok');
  await TwChat.runCommand('slow', '45', ctx);
  assert.deepEqual(calls.at(-1).body, { slow_mode: true, slow_mode_wait_time: 45 });
  assert.equal(calls.at(-1).method, 'PATCH');
  await TwChat.runCommand('color', 'HotPink', ctx);
  assert.match(calls.at(-1).url, /chat\/color\?user_id=42&color=hot_pink/);
  await TwChat.runCommand('announceblue', 'Gleich geht es los', ctx);
  assert.deepEqual(calls.at(-1).body, { message: 'Gleich geht es los', color: 'blue' });
  // Rolle und fehlende Rechte
  await assert.rejects(TwChat.runCommand('raid', 'x', ctx), /nur der Streamer/);
  await assert.rejects(TwChat.runCommand('ban', 'x', { ...ctx, me: { userId: '42' } }), /nur Moderatoren/);
  await assert.rejects(TwChat.runCommand('ban', 'x', { ...ctx, scopes: ['chat:read'] }), /mehr Rechte/);
  await assert.rejects(TwChat.runCommand('ban', '', ctx), /So geht's/);
  // Twitch meldet fehlende Berechtigung
  TW.configure({ fetch: async () => new Response(JSON.stringify({ status: 401, message: 'Missing scope: moderator:manage:banned_users' }), { status: 401 }) });
  await assert.rejects(TwChat.runCommand('clear', '', ctx), /fehlen dafür Rechte/);
  TW.configure({ fetch: (...a) => fetch(...a), auth: () => null, unauthorized: () => {} });
});

test('Chat-Wiedergabe und Clips umwandeln', () => {
  const page = TwChat.toReplayPage({
    edges: [
      { cursor: 'c1', node: { id: 'a', contentOffsetSeconds: 598, commenter: { login: 'Max', displayName: 'Max' }, message: { fragments: [{ text: 'hallo ', emote: null }, { text: 'Kappa', emote: { emoteID: '25' } }], userBadges: [{ setID: 'subscriber', version: '12' }], userColor: '#FF0000' } } },
      { cursor: 'c2', node: { id: 'b', contentOffsetSeconds: 604.5, commenter: null, message: { fragments: [{ text: 'x' }], userBadges: [], userColor: null } } },
    ],
    pageInfo: { hasNextPage: true },
  });
  assert.equal(page.next, 'c2');
  assert.deepEqual(page.messages[0], { id: 'a', offset: 598, login: 'max', name: 'Max', color: '#FF0000', badges: ['subscriber/12'], frags: [{ text: 'hallo ' }, { emoteId: '25', name: 'Kappa' }] });
  assert.equal(page.messages[1].offset, 604);
  assert.deepEqual(TW.parseId('twitch-clip:Abc-1_x'), { vod: null, login: null, clip: 'Abc-1_x' });
  assert.equal(TW.parseId('twitch-clip:../x'), null);
  const c = TW.toClip({ slug: 'Abc', title: 'wow', viewCount: 5, durationSeconds: 43, createdAt: '2026-11-17T17:29:00Z', thumbnailURL: 'https://t/x.jpg', broadcaster: { login: 'Papaplatte', displayName: 'Papaplatte' }, curator: { displayName: 'Fan' } });
  assert.equal(c.id, 'twitch-clip:Abc');
  assert.equal(c.channelLogin, 'papaplatte');
  assert.equal(c.curator, 'Fan');
  assert.equal(c.durationSec, 43);
});

test('Clip-Adresse mit Token in der gewünschten Qualität', async () => {
  TW.configure({
    fetch: async () =>
      new Response(
        JSON.stringify({ data: { clip: { broadcaster: { login: 'papaplatte' }, playbackAccessToken: { signature: 'sig1', value: '{"a":1}' }, videoQualities: [{ quality: '1080', sourceURL: 'https://c/1080.mp4' }, { quality: '720', sourceURL: 'https://c/720.mp4' }, { quality: '360', sourceURL: 'https://c/360.mp4' }] } } }),
        { status: 200 },
      ),
  });
  const p = await TW.playback('twitch-clip:Abc');
  assert.equal(p.clip, 'Abc');
  assert.equal(p.height, 1080);
  assert.equal(p.url, 'https://c/1080.mp4?sig=sig1&token=%7B%22a%22%3A1%7D');
  assert.equal((await TW.clipPlayback('Abc', 720)).height, 720);
  TW.configure({ fetch: (...a) => fetch(...a) });
});

test('Online: Clips, Clip-Datei, Chat-Wiedergabe, Abzeichen, Profilkarte', { skip: !online }, async () => {
  const clips = await TW.clips('papaplatte', 'all');
  assert.ok(clips.length > 0);
  const p = await TW.playback(clips[0].id);
  const res = await fetch(p.url, { headers: { Range: 'bytes=0-100' } });
  assert.ok(res.ok, `Clip-Datei: HTTP ${res.status}`);
  const info = await TW.watchInfo(clips[0].id);
  assert.equal(info.channelLogin, 'papaplatte');
  const ch = await TW.channel('papaplatte');
  if (ch.items[0]?.vod) {
    const page = await TwChat.replay(ch.items[0].vod, { offset: 600 });
    assert.ok(page.messages.length > 0);
    const next = await TwChat.replay(ch.items[0].vod, { cursor: page.next });
    assert.ok(next.messages[0].offset >= page.messages[0].offset);
  }
  const b = await TwChat.badges('papaplatte');
  assert.ok(Object.keys(b).some((k) => k.startsWith('subscriber/')));
  const u = await TwChat.chatUser('trymacs', 'papaplatte');
  assert.equal(u.name, 'Trymacs');
  assert.ok(u.createdAt > 0);
});
