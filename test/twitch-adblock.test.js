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
function fakeTwitch({ clearOnSpoof = false, tailLiveOnSpoof = false, failSpoof = false, slowSpoofMs = 0, timing = undefined } = {}) {
  // slow: Sitzungen (playerType), deren Token-Anfrage hängt · tagsOnly: nur noch die Werbe-Markierung im Fenster
  const tw = { head: 50, ads: new Set(), tailLive: new Set(), tagsOnly: new Set(), slow: new Map(), adDuration: 30, lag: {}, tokens: [], spoofCalls: [], events: [] };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const offsetOf = (s) => [...s].reduce((a, c) => a + c.charCodeAt(0), 0) * 10; // jede Sitzung nummeriert anders
  tw.playlist = (session) => {
    const end = tw.head - (tw.lag[session] ?? 0);
    const ad = tw.ads.has(session);
    const tailLive = tw.tailLive.has(session);
    let b = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${end - 5 + offsetOf(session)}\n`;
    if (ad || tailLive || tw.tagsOnly.has(session)) {
      b += `#EXT-X-DATERANGE:ID="stitched-ad-${tw.head}",CLASS="twitch-stitched-ad",START-DATE="${new Date(T0).toISOString()}",DURATION=${tw.adDuration.toFixed(1)},X-TV-TWITCH-AD-RADS-TOKEN="rads-tok-${tw.head}",X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL",X-TV-TWITCH-AD-POD-POSITION="0",X-TV-TWITCH-AD-POD-LENGTH="1"\n`;
    }
    for (let n = end - 5; n < end; n++) {
      const segAd = ad || (tailLive && n < end - 2);
      b += `#EXT-X-PROGRAM-DATE-TIME:${new Date(T0 + n * 2000).toISOString()}\n${segAd ? '#EXTINF:2.000,Amazon|1' : '#EXTINF:2.000,live'}\nhttps://video-edge.example/${session}/${n}.ts\n`;
    }
    return b;
  };
  const master = (session) => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3422999,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p60",FRAME-RATE=60.000\n' +
    `https://video-weaver.example.hls.ttvnw.net/v1/playlist/${session}-720.m3u8\n`;
  const fakeFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    let body;
    if (url.startsWith('https://gql.twitch.tv/')) {
      const parsed = JSON.parse(init.body);
      if (Array.isArray(parsed) && parsed[0]?.operationName === 'ClientSideAdEventHandling_RecordAdEvent') {
        tw.spoofCalls.push({ headers: init.headers, batch: parsed });
        if (slowSpoofMs) await pause(slowSpoofMs);
        if (failSpoof) return new Response(JSON.stringify(parsed.map(() => ({ errors: [{ message: 'service error' }] }))), { status: 200 });
        if (clearOnSpoof) tw.ads.delete('native');
        if (tailLiveOnSpoof) {
          tw.ads.delete('native');
          tw.tailLive.add('native');
        }
        body = JSON.stringify(parsed.map(() => ({ data: { recordAdEvent: { __typename: 'RecordAdEventPayload' } } })));
      } else {
        const v = parsed.variables;
        tw.tokens.push(`${v.playerType}/${v.platform}`);
        if (tw.slow.has(v.playerType)) await pause(tw.slow.get(v.playerType));
        body = JSON.stringify({ data: { streamPlaybackAccessToken: { value: v.playerType, signature: 'sig', authorization: { isForbidden: false } } } });
      }
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
  vm.runInContext(SRC.replace('__AB_WORKER_INIT__', JSON.stringify({ clientId: 'x', channel: 'test', relay: false, adSpoofing: true, timing }))
    .replace('__AB_HOLD_SEGMENT__', JSON.stringify(HOLD)), ctx);
  const usher = 'https://usher.ttvnw.net/api/channel/hls/streamer.m3u8?token=native&sig=x&supported_codecs=avc1';
  const media = 'https://video-weaver.example.hls.ttvnw.net/v1/playlist/native-720.m3u8';
  tw.start = () => self.fetch(usher);
  tw.refresh = async () => self.__abTwitchTest.parseMedia(await (await self.fetch(media)).text(), media);
  tw.testApi = self.__abTwitchTest;
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
  assert.equal(tw.spoofCalls.length, 1, 'Ad-Spoofing wurde zuerst versucht');
});

test('Primär Ad-Spoofing: beendet Werbung sofort auf eigener Sitzung ohne Wechsel', async () => {
  const tw = fakeTwitch({ clearOnSpoof: true });
  await tw.start();
  await tw.refresh();
  tw.ads.add('native');
  tw.head++;
  const p = await tw.refresh();
  assert.equal(tw.spoofCalls.length, 1, 'RecordAdEvent gesendet');
  const call = tw.spoofCalls[0];
  assert.match(call.headers['X-Device-Id'], /^[0-9a-f]{32}$/i, 'echte 32-stellige Device-ID statt oauth');
  assert.equal(call.batch.length, 6, 'Impression + 4 Quartile + Pod-Complete');
  assert.equal(tw.tokens.length, 0, 'keine Ersatz-Sitzung nötig, wenn Spoofing greift');
  assert.match(last(p).uri, /\/native\//, 'bleibt auf der eigenen Sitzung');
  assert.ok(!p.segs.some((s) => s.ad));
});

test('Ad-Spoofing: schneidet Rest-Werbung im oberen HLS-Fenster lückenlos heraus, sobald am Ende wieder Live-Stücke liegen', async () => {
  const tw = fakeTwitch({ tailLiveOnSpoof: true });
  await tw.start();
  const first = await tw.refresh();
  const prevLastSeq = last(first).seq;
  tw.ads.add('native');
  tw.head += 2;
  const p = await tw.refresh();
  assert.equal(tw.spoofCalls.length, 1, 'RecordAdEvent gesendet');
  assert.equal(tw.tokens.length, 0, 'kein Wechsel auf 360p-Brücke nötig');
  assert.match(last(p).uri, /\/native\//, 'bleibt auf eigener Sitzung');
  assert.ok(!p.segs.some((s) => s.ad), 'alte Werbestücke wurden herausgeschnitten');
  assert.ok(last(p).seq > prevLastSeq, 'Segmentnummern steigen lückenlos weiter');
  for (let i = 1; i < p.segs.length; i++) {
    assert.equal(p.segs[i].seq, p.segs[i - 1].seq + 1, 'keine Lücke in der Nummerierung');
  }
});

test('Prefetch-Werbung am Playlist-Ende wird herausgefiltert, Live-Prefetch bleibt', () => {
  const tw = fakeTwitch();
  const raw =
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:10\n' +
    '#EXTINF:2.000,live\nhttps://video-edge.example/native/10.ts\n' +
    '#EXT-X-TWITCH-PREFETCH:https://video-edge.example/stitched-ad/ad1.ts\n' +
    '#EXT-X-TWITCH-PREFETCH:https://video-edge.example/native/11.ts\n';
  const parsed = tw.testApi.parseMedia(raw, 'https://video-weaver.example/native.m3u8');
  assert.deepEqual([...parsed.tail], ['#EXT-X-TWITCH-PREFETCH:https://video-edge.example/native/11.ts']);
});

test('Ad-Spoofing fehlgeschlagen: kein neuer Versuch bei jeder Aktualisierung, Ersatz-Sitzung übernimmt', async () => {
  const tw = fakeTwitch({ failSpoof: true });
  await tw.start();
  await tw.refresh();
  tw.ads.add('native');
  tw.head++;
  const p = await tw.refresh();
  assert.equal(tw.spoofCalls.length, 1, 'einmal versucht');
  assert.ok(!p.segs.some((s) => s.ad), 'Werbung trotzdem weg (Ersatz-Sitzung)');
  await tw.refresh();
  await tw.refresh();
  assert.equal(tw.spoofCalls.length, 1, 'gleiche Werbung nicht sofort wieder gemeldet');
});

test('Ad-Spoofing abgeschaltet: nichts wird gemeldet', async () => {
  const tw = fakeTwitch({ clearOnSpoof: true });
  tw.testApi.setAdSpoofing(false);
  await tw.start();
  await tw.refresh();
  tw.ads.add('native');
  tw.head++;
  const p = await tw.refresh();
  assert.equal(tw.spoofCalls.length, 0);
  assert.ok(!p.segs.some((s) => s.ad));
});

// ---- Nach der Werbung: Twitch lässt die Werbestücke noch im Fenster stehen (nach Start-Werbung minutenlang)

/** Werbepause in der eigenen Sitzung und allen in voller Qualität: der Player landet auf einer 360p-Brücke. */
async function onBridge(options) {
  const tw = fakeTwitch(options);
  await tw.start();
  await tw.refresh();
  for (const s of ['native', ...ALL_HQ]) tw.ads.add(s);
  tw.head++;
  const p = await tw.refresh();
  assert.match(last(p).uri, /\/(autoplay|picture-by-picture)\//, 'während der Werbung trägt die Brücke');
  return { tw, seq: last(p).seq };
}

test('Werbung vorbei, Werbestücke noch im Fenster: gleich zurück zur eigenen Sitzung', async () => {
  const { tw, seq } = await onBridge();
  tw.ads.delete('native');
  tw.tailLive.add('native'); // am Ende wieder Live-Stücke, davor noch die Werbung
  tw.head++;
  const p = await tw.refresh();
  assert.match(last(p).uri, /\/native\//, 'eigene Sitzung statt weiter 360p');
  assert.ok(!p.segs.some((s) => s.ad), 'ohne die Werbestücke');
  assert.doesNotMatch(p.text, /stitched-ad/, 'und ohne die Werbe-Markierung');
  assert.equal(holds(p), 0);
  assert.ok(last(p).seq > seq, 'Nummern steigen weiter');
  assert.ok(tw.events.some((e) => e.event === 'native-back' && e.early), 'als früher Rückweg gemeldet');
  assert.ok(tw.events.some((e) => e.event === 'ad-end'));
  assert.ok(tw.events.some((e) => e.event === 'bridge' && e.on === false), 'Brücken-Hinweis verschwindet');
  // danach läuft es auf der eigenen Sitzung weiter
  tw.tailLive.clear();
  tw.ads.clear();
  let before = last(p).seq;
  for (let i = 0; i < 3; i++) {
    tw.head++;
    const q = await tw.refresh();
    assert.match(last(q).uri, /\/native\//);
    assert.ok(last(q).seq > before, 'Nummern steigen nur');
    before = last(q).seq;
  }
});

test('Erst wenn genug Live-Stücke hinter der Werbung liegen, geht es von der Ersatz-Sitzung zurück', async () => {
  const { tw } = await onBridge({ timing: { nativeTail: 3 } });
  tw.ads.delete('native');
  tw.tailLive.add('native'); // nur zwei Live-Stücke am Ende
  tw.head++;
  const p = await tw.refresh();
  assert.match(last(p).uri, /\/(autoplay|picture-by-picture)\//, 'bleibt vorerst auf der Brücke');
  assert.ok(!p.segs.some((s) => s.ad));
});

test('Nur noch die Werbe-Markierung im Fenster, Werbezeit vorbei: eigene Sitzung läuft weiter', async () => {
  const tw = fakeTwitch();
  await tw.start();
  await tw.refresh();
  tw.tagsOnly.add('native');
  tw.head++;
  const p = await tw.refresh();
  assert.match(last(p).uri, /\/native\//);
  assert.doesNotMatch(p.text, /stitched-ad/, 'Markierung herausgefiltert');
  assert.equal(tw.tokens.length, 0, 'keine Ersatz-Sitzung nötig');
  assert.equal(tw.spoofCalls.length, 0, 'alte Werbung wird nicht noch einmal gemeldet');
});

test('Werbe-Markierung, deren Zeit noch läuft: vorsichtshalber Ersatz-Sitzung', async () => {
  const tw = fakeTwitch();
  tw.adDuration = 100_000; // Werbung läuft laut Markierung noch – auch wenn kein Stück markiert ist
  await tw.start();
  await tw.refresh();
  tw.tagsOnly.add('native');
  tw.head++;
  const p = await tw.refresh();
  assert.doesNotMatch(last(p).uri, /\/native\//, 'nicht die eigene Sitzung');
  assert.ok(tw.tokens.length > 0);
});

test('Alte Werbung weiter oben im Fenster wird nicht (noch einmal) als gesehen gemeldet', async () => {
  const tw = fakeTwitch();
  await tw.start();
  await tw.refresh();
  tw.tailLive.add('native');
  tw.head++;
  const p = await tw.refresh();
  assert.equal(tw.spoofCalls.length, 0);
  assert.match(last(p).uri, /\/native\//);
  assert.ok(!p.segs.some((s) => s.ad));
  // Das Format (hier MPEG-TS) steht fest, auch solange noch Werbung im Fenster steht – wichtig fürs Ersatzbild
  assert.equal(tw.testApi.contexts.get('live:streamer').fmp4, false);
});

// ---- Der Player darf nicht auf langsame Anfragen warten (sonst läuft sein Puffer leer und das Bild steht)

test('Eine hängende 360p-Brücke hält den Player nicht auf: die andere übernimmt sofort', async () => {
  const tw = fakeTwitch();
  await tw.start();
  await tw.refresh();
  for (const s of ['native', ...ALL_HQ]) tw.ads.add(s);
  tw.slow.set('autoplay', 2000);
  tw.head++;
  const t0 = Date.now();
  const p = await tw.refresh();
  assert.ok(Date.now() - t0 < 1000, `Antwort nach ${Date.now() - t0} ms`);
  assert.match(last(p).uri, /\/picture-by-picture\//);
  assert.equal(holds(p), 0, 'kein schwarzes Bild');
  assert.ok(!p.segs.some((s) => s.ad));
});

test('Hängt das Melden der Werbung, wartet der Player nicht darauf', async () => {
  const tw = fakeTwitch({ slowSpoofMs: 2000, timing: { spoofWait: 150 } });
  await tw.start();
  await tw.refresh();
  for (const s of ['native', ...ALL_HQ]) tw.ads.add(s);
  tw.head++;
  const t0 = Date.now();
  const p = await tw.refresh();
  assert.ok(Date.now() - t0 < 1200, `Antwort nach ${Date.now() - t0} ms`);
  assert.equal(tw.spoofCalls.length, 1, 'gemeldet wird trotzdem (im Hintergrund)');
  assert.ok(!p.segs.some((s) => s.ad), 'Werbung weg (Brücke)');
  assert.equal(holds(p), 0);
});
