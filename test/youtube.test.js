import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toVideo } from '../src/main/youtube.js';

test('LockupView (ähnliche Videos) wird zu einem Video', () => {
  const v = toVideo({
    type: 'LockupView',
    content_type: 'VIDEO',
    content_id: 'C6Vwl8bD33s',
    content_image: { image: [{ url: 'https://i.ytimg.com/a.jpg', width: 168 }, { url: 'https://i.ytimg.com/b.jpg', width: 336 }], overlays: [{ badges: [{ text: '1:01:35' }] }] },
    metadata: { title: { text: 'Together Forever' }, metadata: { metadata_rows: [{ metadata_parts: [{ text: { text: 'Jacob' } }] }, { metadata_parts: [{ text: { text: '400.610 Aufrufe' } }, { text: { text: 'vor 11 Jahren' } }] }] } },
  });
  assert.equal(v.id, 'C6Vwl8bD33s');
  assert.equal(v.title, 'Together Forever');
  assert.equal(v.channelName, 'Jacob');
  assert.equal(v.durationSec, 3695);
  assert.equal(v.thumbnail, 'https://i.ytimg.com/b.jpg');
  assert.equal(v.viewsText, '400.610 Aufrufe');
  assert.equal(v.publishedText, 'vor 11 Jahren');
});

test('Playlists und Mixe sind keine Videos', () => {
  assert.equal(toVideo({ type: 'LockupView', content_type: 'PLAYLIST', content_id: 'RDxyz' }), null);
  assert.equal(toVideo({ type: 'Shelf' }), null);
  assert.equal(toVideo(null), null);
});

test('Suchergebnis-Video', () => {
  const v = toVideo({ type: 'Video', video_id: 'dQw4w9WgXcQ', title: { text: 'Rick' }, author: { name: 'Rick Astley' }, duration: { seconds: 213 }, short_view_count: { text: '1,8 Mrd. Aufrufe' }, published: { text: 'vor 16 Jahren' }, thumbnails: [{ url: '//i.ytimg.com/x.jpg', width: 720 }] });
  assert.equal(v.durationSec, 213);
  assert.equal(v.thumbnail, 'https://i.ytimg.com/x.jpg');
  assert.equal(v.channelName, 'Rick Astley');
});

test('Online: Suche und Stream (nur mit GXTUBE_ONLINE_TESTS=1)', { skip: !process.env.GXTUBE_ONLINE_TESTS }, async () => {
  const yt = await import('../src/main/youtube.js');
  const res = await yt.search('Rick Astley Never Gonna Give You Up');
  assert.ok(res.items.some((i) => i.kind === 'video'));
  const s = await yt.stream('dQw4w9WgXcQ');
  assert.equal(s.kind, 'dash');
  assert.match(s.manifest, /<MPD/);
});

test('Clients, die mitten im Video abgelehnt wurden, kommen ans Ende', async () => {
  const yt = await import('../src/main/youtube.js');
  const first = yt.STREAM_CLIENTS[0];
  assert.equal(yt.preferredClients()[0], first);
  yt.reportClientFailure(first);
  const order = yt.preferredClients();
  assert.equal(order.at(-1), first);
  assert.equal(order.length, yt.STREAM_CLIENTS.length);
  assert.ok(!yt.preferredClients([yt.STREAM_CLIENTS[1]]).includes(yt.STREAM_CLIENTS[1]));
});

test('ytcfg der YouTube-Startseite: angemeldet, Besucher- und DataSync-ID', async () => {
  const { parseYtcfg } = await import('../src/main/youtube.js');
  const html = '<script>ytcfg.set({"LOGGED_IN":true,"VISITOR_DATA":"CgtBQkNkZWYxMjM0NSi\\u003d","DATASYNC_ID":"10987654321||","X":"a\\"b"});</script>';
  assert.deepEqual(parseYtcfg(html), { loggedIn: true, visitorData: 'CgtBQkNkZWYxMjM0NSi=', dataSyncId: '10987654321||' });
  assert.deepEqual(parseYtcfg('{"LOGGED_IN":false}'), { loggedIn: false, visitorData: null, dataSyncId: null });
  assert.deepEqual(parseYtcfg('<html>Einwilligung</html>'), { loggedIn: null, visitorData: null, dataSyncId: null });
});

test('Mit Google-Konto gibt es weitere Clients zum Ausweichen', async () => {
  const yt = await import('../src/main/youtube.js');
  let loggedIn = false;
  yt.configure({ account: { loggedIn: () => loggedIn, cookieHeader: async () => null, fetch: globalThis.fetch } });
  const all = [...yt.STREAM_CLIENTS, 'SABR WEB'];
  assert.equal(yt.clientsLeft(yt.STREAM_CLIENTS), 1, 'SABR bleibt als Ausweg');
  assert.equal(yt.clientsLeft(all), 0);
  loggedIn = true;
  assert.equal(yt.clientsLeft(all), yt.ACCOUNT_CLIENTS.length + 1, 'Konto-Clients und SABR mit Konto');
  assert.equal(yt.clientsLeft([...all, ...yt.ACCOUNT_CLIENTS.map((c) => 'Konto ' + c)]), 1);
  assert.equal(yt.clientsLeft([...all, ...yt.ACCOUNT_CLIENTS.map((c) => 'Konto ' + c), 'Konto SABR TV']), 0);
  yt.configure({ account: null });
});

test('Notlösung: höchste Qualität gewinnt, bei Gleichstand DASH', async () => {
  const { bestCandidate } = await import('../src/main/youtube.js');
  assert.equal(bestCandidate([]), null);
  const file = { kind: 'progressive', maxHeight: 360, client: 'MWEB' };
  const dash360 = { kind: 'dash', maxHeight: 360, client: 'IOS' };
  const dash720 = { kind: 'dash', maxHeight: 720, client: 'Konto TV' };
  assert.equal(bestCandidate([file, dash360]), dash360);
  assert.equal(bestCandidate([file, dash720, dash360]), dash720);
});

test('Zuletzt erfolgreicher Client kommt zuerst (nur wenn vorhanden)', async () => {
  const { withLastGoodFirst, STREAM_CLIENTS } = await import('../src/main/youtube.js');
  assert.deepEqual(withLastGoodFirst(STREAM_CLIENTS, 'Test '), STREAM_CLIENTS);
});

test('Kanal-ID aus ähnlichen Videos (LockupView) und Suchergebnissen', async () => {
  const { toVideo } = await import('../src/main/youtube.js');
  const lockup = toVideo({
    type: 'LockupView',
    content_type: 'VIDEO',
    content_id: 'PXC_PYeB6F8',
    content_image: { image: [{ url: 'https://i.ytimg.com/a.jpg', width: 1 }] },
    metadata: {
      title: { text: 'Angels On My Side' },
      image: { renderer_context: { command_context: { on_tap: { payload: { browseId: 'UCuAXFkgsw1L7xaCfnd5JJOw' } } } } },
      metadata: { metadata_rows: [{ metadata_parts: [{ text: { text: '109.546 Aufrufe' } }, { text: { text: 'vor 3 Monaten' } }] }] },
    },
  });
  assert.equal(lockup.channelId, 'UCuAXFkgsw1L7xaCfnd5JJOw');
  assert.equal(lockup.channelName, '', 'Aufrufe sind kein Kanalname');
  assert.equal(lockup.viewsText, '109.546 Aufrufe');
  const video = toVideo({ type: 'Video', video_id: 'dQw4w9WgXcQ', title: { text: 'Rick' }, author: { name: 'Rick Astley', id: 'UCuAXFkgsw1L7xaCfnd5JJOw' }, duration: { seconds: 213 } });
  assert.equal(video.channelId, 'UCuAXFkgsw1L7xaCfnd5JJOw');
  assert.equal(toVideo({ type: 'Video', video_id: 'dQw4w9WgXcQ', author: { name: 'X', id: 'N/A' } }).channelId, null);
});

test('Abo-Feed (RSS) wird gelesen, Shorts erkannt', async () => {
  const { parseFeed } = await import('../src/main/youtube.js');
  const xml = `<feed><entry><id>yt:video:E_MGy41IYVw</id><yt:videoId>E_MGy41IYVw</yt:videoId><yt:channelId>UCuAXFkgsw1L7xaCfnd5JJOw</yt:channelId>
    <title>Kurz &amp; gut</title><link rel="alternate" href="https://www.youtube.com/shorts/E_MGy41IYVw"/><author><name>Rick Astley</name></author>
    <published>2026-09-20T08:52:27+00:00</published><media:statistics views="1234"/></entry>
    <entry><yt:videoId>dQw4w9WgXcQ</yt:videoId><title>Never Gonna Give You Up</title><link rel="alternate" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"/>
    <author><name>Rick Astley</name></author><published>2009-10-25T06:57:33+00:00</published></entry><entry><yt:videoId>kaputt</yt:videoId></entry></feed>`;
  const list = parseFeed(xml, { id: 'UCuAXFkgsw1L7xaCfnd5JJOw', name: 'Rick' });
  assert.equal(list.length, 2);
  assert.equal(list[0].title, 'Kurz & gut');
  assert.equal(list[0].isShort, true);
  assert.equal(list[0].viewsText, '1.234 Aufrufe');
  assert.equal(list[1].isShort, false);
  assert.equal(list[1].channelId, 'UCuAXFkgsw1L7xaCfnd5JJOw');
  assert.ok(list[0].publishedAt > list[1].publishedAt);
});
