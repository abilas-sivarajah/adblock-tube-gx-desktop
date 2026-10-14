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
