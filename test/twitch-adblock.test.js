// Werbepause gegen ein nachgebautes Twitch (ohne Netz): Der Player soll statt Werbung oder schwarzem
// Bild gleich eine werbefreie Sitzung bekommen. Gleiche Fälle wie TwitchAdSkipTest in der Android-App.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../third_party/adblock-gx/twitch_worker.js', import.meta.url), 'utf8');
const HOLD = fs.readFileSync(new URL('../third_party/adblock-gx/twitch_hold.ts', import.meta.url)).toString('base64');
const T0 = 1_792_872_000_000;
const ALL_HQ = ['popout', 'frontpage', 'mobile_web', 'site'];

/** Nachgebautes Twitch: jede Sitzung (playerType) hat ihre eigene Playlist, mit oder ohne Werbung. */
function fakeTwitch() {
  const tw = { head: 50, ads: new Set(), lag: {}, tokens: [], events: [] };
  const offsetOf = (s) => [...s].reduce((a, c) => a + c.charCodeAt(0), 0) * 10; // jede Sitzung nummeriert anders
  tw.playlist = (session) => {
    const end = tw.head - (tw.lag[session] ?? 0);
    const ad = tw.ads.has(session);
    let b = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${end - 5 + offsetOf(session)}\n`;
    if (ad) b += `#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="${new Date(T0).toISOString()}",DURATION=30.0\n`;
    for (let n = end - 5; n < end; n++) {
      b += `#EXT-X-PROGRAM-DATE-TIME:${new Date(T0 + n * 2000).toISOString()}\n${ad ? '#EXTINF:2.000,Amazon|1' : '#EXTINF:2.000,live'}\nhttps://video-edge.example/${session}/${n}.ts\n`;
    }
    return b;
  };
  const master = (session) => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3422999,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p60",FRAME-RATE=60.000\n' +
    `https://video-weaver.example.hls.ttvnw.net/v1/playlist/${session}-720.m3u8\n`;
  const fakeFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    let body;
    if (url.startsWith('https://gql.twitch.tv/')) {
      const v = JSON.parse(init.body).variables;
      tw.tokens.push(`${v.playerType}/${v.platform}`);
      body = JSON.stringify({ data: { streamPlaybackAccessToken: { value: v.playerType, signature: 'sig', authorization: { isForbidden: false } } } });
    } else if (url.includes('usher.ttvnw.net/')) body = master(new URL(url).searchParams.get('token'));
    else if (url.includes('/v1/playlist/')) body = tw.playlist(url.split('/').pop().replace('-720.m3u8', ''));
    else throw new Error('unerwartet: ' + url);
    return new Response(body, { status: 200 });
  };
  class Channel {
    postMessage(m) { tw.events.push(m); }
    addEventListener() {}
  }
  const self = { fetch: fakeFetch };
  const ctx = vm.createContext({ self, Response, URL, URLSearchParams, setTimeout, clearTimeout, console, atob, btoa, TextEncoder, TextDecoder, BroadcastChannel: Channel, crypto });
  vm.runInContext(SRC.replace('__AB_WORKER_INIT__', JSON.stringify({ clientId: 'x', channel: 'test', relay: false, adSpoofing: false }))
    .replace('__AB_HOLD_SEGMENT__', JSON.stringify(HOLD)), ctx);
  const usher = 'https://usher.ttvnw.net/api/channel/hls/streamer.m3u8?token=native&sig=x&supported_codecs=avc1';
  const media = 'https://video-weaver.example.hls.ttvnw.net/v1/playlist/native-720.m3u8';
  tw.start = () => self.fetch(usher);
  tw.refresh = async () => self.__abTwitchTest.parseMedia(await (await self.fetch(media)).text(), media);
  return tw;
}

const holds = (p) => p.segs.filter((s) => s.uri.startsWith('https://www.twitch.tv/__adblock_gx_hold.ts')).length;
const last = (p) => p.segs[p.segs.length - 1];

test('Zweite 360p-Brücke, wenn die erste auch Werbung hat', async () => {
  const tw = fakeTwitch();
  await tw.start();
  await tw.refresh();
  for (const s of ['native', ...ALL_HQ, 'autoplay']) tw.ads.add(s);
  tw.head++;
  const p = await tw.refresh();
  assert.equal(holds(p), 0, 'kein schwarzes Bild');
  assert.match(last(p).uri, /\/picture-by-picture\//);
  assert.ok(!p.segs.some((s) => s.ad));
  assert.ok(tw.tokens.includes('picture-by-picture/ios') && tw.tokens.includes('autoplay/android'), tw.tokens.join());
  assert.ok(tw.events.some((e) => e.event === 'bridge' && e.on));
});

test('Brücke, die ein paar Sekunden zurückliegt, sofort statt schwarz', async () => {
  const tw = fakeTwitch();
  await tw.start();
  await tw.refresh();
  for (const s of ['native', ...ALL_HQ, 'picture-by-picture']) tw.ads.add(s);
  tw.lag.autoplay = 3; // 6 s hinter dem, was der Player schon hat
  tw.head++;
  const p = await tw.refresh();
  assert.equal(holds(p), 0, 'kein schwarzes Bild');
  assert.match(last(p).uri, /\/autoplay\//);
  let seq = last(p).seq;
  for (let i = 0; i < 5; i++) {
    tw.head++;
    const q = await tw.refresh();
    assert.equal(holds(q), 0);
    assert.ok(last(q).seq > seq, 'Nummern steigen nur');
    seq = last(q).seq;
  }
  tw.ads.clear();
  for (let i = 0; i < 4; i++) {
    tw.head++;
    await tw.refresh();
  }
  assert.match(last(await tw.refresh()).uri, /\/native\//, 'nach der Werbung zurück zur eigenen Sitzung');
});

test('Alles mit Werbung: schwarzes Ersatzbild, nie die Werbung', async () => {
  const tw = fakeTwitch();
  await tw.start();
  await tw.refresh();
  for (const s of ['native', ...ALL_HQ, 'autoplay', 'picture-by-picture']) tw.ads.add(s);
  tw.head++;
  const p = await tw.refresh();
  assert.ok(holds(p) > 0);
  assert.ok(p.segs.every((s) => !s.ad || s.uri.startsWith('https://www.twitch.tv/__adblock_gx_hold.ts')));
});
