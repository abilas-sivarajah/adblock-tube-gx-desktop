import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolError, isDiscoveryRequest, isLocalAddress, parseCommand, sanitizeChannel, sanitizeTwitchChannel, sanitizeVideo } from '../src/main/protocol.js';

test('Video wird geprüft und gekürzt', () => {
  const v = sanitizeVideo({ id: 'dQw4w9WgXcQ', title: 'x'.repeat(500), channelName: 'Rick', thumbnail: 'http://evil/x.png', durationSec: 213.4, extra: 1 });
  assert.equal(v.title.length, 300);
  assert.equal(v.thumbnail, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  assert.equal(v.durationSec, 213);
  assert.equal(v.extra, undefined);
  assert.throws(() => sanitizeVideo({ id: '../../etc' }), ProtocolError);
  assert.throws(() => sanitizeVideo(null), ProtocolError);
  assert.equal(v.channelId, null);
  assert.equal(sanitizeVideo({ id: 'dQw4w9WgXcQ', channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw' }).channelId, 'UCuAXFkgsw1L7xaCfnd5JJOw');
  assert.equal(sanitizeVideo({ id: 'dQw4w9WgXcQ', channelId: 'javascript:alert(1)' }).channelId, null);
});

test('Kanal fürs Abonnieren wird geprüft', () => {
  assert.deepEqual(sanitizeChannel({ id: 'UCuAXFkgsw1L7xaCfnd5JJOw', name: 'Rick', thumbnail: 'http://x/y.png', extra: 1 }), { id: 'UCuAXFkgsw1L7xaCfnd5JJOw', name: 'Rick', thumbnail: null });
  assert.throws(() => sanitizeChannel({ id: 'nope' }), ProtocolError);
});

test('Befehle werden erkannt und Werte begrenzt', () => {
  assert.deepEqual(parseCommand('{"type":"pause"}'), { type: 'pause' });
  assert.deepEqual(parseCommand({ type: 'volume', value: 250 }), { type: 'volume', value: 100 });
  assert.deepEqual(parseCommand({ type: 'speed', value: 10 }), { type: 'speed', value: 3 });
  assert.deepEqual(parseCommand({ type: 'seek', positionMs: -5 }), { type: 'seek', positionMs: 0 });
  assert.deepEqual(parseCommand({ type: 'seekBy', deltaMs: 'abc' }), { type: 'seekBy', deltaMs: 0 });
  const play = parseCommand({ type: 'play', video: { id: 'dQw4w9WgXcQ' }, queue: [{ id: 'dQw4w9WgXcQ' }, { id: 'kaputt' }], startMs: 5000 });
  assert.equal(play.queue.length, 1);
  assert.equal(play.startMs, 5000);
  assert.equal(parseCommand({ type: 'hello' }).name, 'Handy');
  assert.throws(() => parseCommand({ type: 'jump', index: 1.5 }), ProtocolError);
  assert.throws(() => parseCommand('kein json'), ProtocolError);
  assert.throws(() => parseCommand({ type: 'rm -rf' }), ProtocolError);
});

test('Nur Adressen aus dem eigenen Netz', () => {
  for (const a of ['192.168.178.20', '10.0.0.5', '172.20.1.1', '127.0.0.1', '::1', '::ffff:192.168.1.2', 'fe80::1', 'fd12:3456::1', '169.254.3.4', '100.80.1.2']) {
    assert.ok(isLocalAddress(a), a);
  }
  for (const a of ['8.8.8.8', '172.32.0.1', '2a02:810::1', '', undefined, '999.1.1.1']) {
    assert.ok(!isLocalAddress(a), String(a));
  }
});

test('Suchanfrage im WLAN', () => {
  assert.ok(isDiscoveryRequest(Buffer.from('{"type":"discover","protocol":1}')));
  assert.ok(!isDiscoveryRequest(Buffer.from('hallo')));
  assert.ok(!isDiscoveryRequest(Buffer.alloc(4096, 32)));
});

test('Vollbild und Bildschirm vom Handy', () => {
  assert.deepEqual(parseCommand('{"type":"fullscreen"}'), { type: 'fullscreen', on: null });
  assert.deepEqual(parseCommand({ type: 'fullscreen', on: true }), { type: 'fullscreen', on: true });
  assert.deepEqual(parseCommand({ type: 'fullscreen', on: 'ja' }), { type: 'fullscreen', on: null });
  assert.deepEqual(parseCommand({ type: 'display', id: 2528732444 }), { type: 'display', id: 2528732444 });
  assert.throws(() => parseCommand({ type: 'display', id: 'eins' }), ProtocolError);
  assert.throws(() => parseCommand({ type: 'display' }), ProtocolError);
});

test('Twitch-Streams und -VODs vom Handy', () => {
  const live = sanitizeVideo({ id: 'twitch:trymacs', title: 'Craft Attack', channelName: 'Trymacs', thumbnail: 'javascript:alert(1)', durationSec: 99 });
  assert.deepEqual(live, {
    id: 'twitch:trymacs',
    platform: 'twitch',
    title: 'Craft Attack',
    channelName: 'Trymacs',
    channelId: null,
    channelLogin: 'trymacs',
    thumbnail: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_trymacs-440x248.jpg',
    durationSec: -1,
    isLive: true,
  });
  const vod = sanitizeVideo({ id: 'twitch-vod:2906596560', channelLogin: 'MontanaBlack88', durationSec: 15270.2 });
  assert.equal(vod.isLive, false);
  assert.equal(vod.durationSec, 15270);
  assert.equal(vod.channelLogin, null, 'nur kleingeschriebene Logins');
  assert.equal(sanitizeVideo({ id: 'twitch-vod:1', channelLogin: 'montanablack88' }).channelLogin, 'montanablack88');
  for (const id of ['twitch:', 'twitch:Trymacs', 'twitch:../x', 'twitch-vod:abc', 'twitch:' + 'a'.repeat(26)]) assert.throws(() => sanitizeVideo({ id }), ProtocolError, id);
  // In der Warteschlange gemischt mit YouTube
  const play = parseCommand({ type: 'play', video: { id: 'twitch:papaplatte' }, queue: [{ id: 'dQw4w9WgXcQ' }, { id: 'twitch:papaplatte' }] });
  assert.deepEqual(play.queue.map((v) => v.id), ['dQw4w9WgXcQ', 'twitch:papaplatte']);
});

test('Twitch-Kanal fürs Folgen wird geprüft', () => {
  assert.deepEqual(sanitizeTwitchChannel({ login: 'Trymacs', userId: '64342766', name: 'Trymacs', avatar: 'https://static-cdn.jtvnw.net/a.png', extra: 1 }), { login: 'trymacs', userId: '64342766', name: 'Trymacs', avatar: 'https://static-cdn.jtvnw.net/a.png' });
  assert.equal(sanitizeTwitchChannel({ login: 'x', userId: 'abc' }).userId, null);
  assert.throws(() => sanitizeTwitchChannel({ login: 'bad login' }), ProtocolError);
});

test('Twitch-Chat und PC ausschalten vom Handy', () => {
  assert.deepEqual(parseCommand('{"type":"twitchChat"}'), { type: 'twitchChat', on: null });
  assert.deepEqual(parseCommand({ type: 'twitchChat', on: false }), { type: 'twitchChat', on: false });
  assert.deepEqual(parseCommand({ type: 'power', action: 'restart' }), { type: 'power', action: 'restart' });
  assert.deepEqual(parseCommand({ type: 'power', action: 'shutdown', force: false }), { type: 'power', action: 'shutdown' });
  assert.throws(() => parseCommand({ type: 'power' }), ProtocolError);
  assert.throws(() => parseCommand({ type: 'power', action: 'rm -rf /' }), ProtocolError);
});
