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
  assert.equal(yt.clientsLeft(all), yt.ACCOUNT_CLIENTS.length);
  assert.equal(yt.clientsLeft([...all, ...yt.ACCOUNT_CLIENTS.map((c) => 'Konto ' + c)]), 0);
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
