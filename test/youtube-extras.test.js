// Neue YouTube-Teile: abgeschottete Entschlüsselung, Kapitel, Playlists, Suchfilter, Untertitel,
// Vorschaubilder, SponsorBlock-Extras, DeArrow/Return YouTube Dislike und die Helfer der Oberfläche.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captionTracks,
  chaptersFromDescription,
  chaptersOf,
  detailsFrom,
  evalPlayerScript,
  searchFilters,
  storyboardOf,
  StreamAborted,
  timedTextToVtt,
  toPlaylist,
} from '../src/main/youtube.js';
import { parseSegments } from '../src/main/sponsorblock.js';
import { brandingFor, cleanTitle, parseBranding, votes } from '../src/main/community.js';
import { chapterAt, createBrandingLoader, startFromUrl, storyboardFrame, textParts, videoIdFromUrl } from '../src/renderer/yt-extras.js';

// ------------------------------------------------------------------ Player-Skript abgeschottet

test('Player-Skript läuft ohne Node-Zugriff und liefert nur einfache Werte', () => {
  const r = evalPlayerScript('return { n: "abc", sig: "xyz", obj: { a: 1 }, fn: () => 1, process: typeof process, req: typeof require };');
  assert.deepEqual(r, { n: 'abc', sig: 'xyz', process: 'undefined', req: 'undefined' });
});

test('Player-Skript: kein eval/new Function im Kontext und kein Ausbruch über constructor', () => {
  assert.throws(() => evalPlayerScript('return { x: eval("1+1") };'), /Code generation from strings disallowed/);
  assert.throws(() => evalPlayerScript('return { x: (function(){}).constructor("return process")() };'), /Code generation from strings disallowed/);
});

test('Player-Skript: Endlosschleife wird nach dem Zeitlimit abgebrochen', () => {
  const t0 = Date.now();
  assert.throws(() => evalPlayerScript('while (true) {}'), /timed out/);
  assert.ok(Date.now() - t0 < 10_000);
});

// ------------------------------------------------------------------ Kapitel

test('Kapitel aus der Beschreibung (wie YouTube: ab 0:00, mindestens drei, 10 s Abstand)', () => {
  const desc = 'Mein Video\n\n0:00 Intro\n1:30 - Teil eins\n(12:05) Teil zwei\nAbschluss – 1:02:03\nhttps://example.com 3:00';
  assert.deepEqual(chaptersFromDescription(desc), [
    { title: 'Intro', startMs: 0, thumbnail: null },
    { title: 'Teil eins', startMs: 90_000, thumbnail: null },
    { title: 'Teil zwei', startMs: 725_000, thumbnail: null },
    { title: 'Abschluss', startMs: 3_723_000, thumbnail: null },
  ]);
  assert.deepEqual(chaptersFromDescription('0:00 a\n0:05 b\n1:00 c'), [], 'zu dicht');
  assert.deepEqual(chaptersFromDescription('0:10 a\n1:00 b\n2:00 c'), [], 'nicht ab 0:00');
  assert.deepEqual(chaptersFromDescription('0:00 a\n1:00 b'), [], 'nur zwei');
});

test('Kapitel aus der Zeitleiste der /next-Antwort, Details zusammengestellt', () => {
  const info = {
    primary_info: { title: { text: 'Titel' }, view_count: { view_count: { text: '1.234 Aufrufe' }, is_live: false }, published: { text: '01.02.2026' }, relative_date: { text: 'vor 3 Tagen' } },
    secondary_info: { owner: { author: { name: 'Kanal', id: 'UC1234567890123456789012', thumbnails: [{ url: 'https://yt3/a.jpg', width: 88 }] }, subscriber_count: { text: '5 Abonnenten' } }, description: { text: 'Hallo https://a.de' } },
    basic_info: { like_count: 42 },
    player_overlays: { decorated_player_bar: { player_bar: { markers_map: [{ marker_key: 'DESCRIPTION_CHAPTERS', value: { chapters: [
      { title: { text: 'Zwei' }, time_range_start_millis: 60000, thumbnail: [] },
      { title: { text: 'Eins' }, time_range_start_millis: 0, thumbnail: [{ url: 'https://i.ytimg.com/c.jpg', width: 120 }] },
    ] } }] } } },
    watch_next_feed: [],
  };
  assert.deepEqual(chaptersOf(info).map((c) => [c.title, c.startMs]), [['Eins', 0], ['Zwei', 60000]]);
  const d = detailsFrom('dQw4w9WgXcQ', info);
  assert.equal(d.title, 'Titel');
  assert.equal(d.channelName, 'Kanal');
  assert.equal(d.channelId, 'UC1234567890123456789012');
  assert.equal(d.viewsText, '1.234 Aufrufe');
  assert.equal(d.likeCount, 42);
  assert.equal(d.chapters.length, 2);
  assert.equal(d.description, 'Hallo https://a.de');
  assert.equal(d.isLive, false);
});

// ------------------------------------------------------------------ Playlists, Suchfilter

test('Playlist aus einem Suchergebnis (LockupView) – Mixe nicht', () => {
  const node = {
    type: 'LockupView',
    content_type: 'PLAYLIST',
    content_id: 'PLF3eNE6vR-4WsBf8qnJLqBywqX39QczxJ',
    metadata: { title: { text: 'Lofi' }, metadata: { metadata_rows: [{ metadata_parts: [{ text: { text: 'the bootleg boy' } }, { text: { text: 'Playlist' } }] }] } },
    content_image: { primary_thumbnail: { image: [{ url: 'https://i.ytimg.com/p.jpg', width: 480 }], overlays: [{ badges: [{ text: '75 Videos' }] }] } },
  };
  assert.deepEqual(toPlaylist(node), { kind: 'playlist', id: node.content_id, title: 'Lofi', channelName: 'the bootleg boy', channelId: null, thumbnail: 'https://i.ytimg.com/p.jpg', countText: '75 Videos' });
  assert.equal(toPlaylist({ ...node, content_id: 'RDdQw4w9WgXcQ' }), null);
  assert.equal(toPlaylist({ ...node, content_type: 'VIDEO' }), null);
});

test('Suchfilter: Unbekanntes wird zu "egal"', () => {
  assert.deepEqual(searchFilters({ type: 'playlist', upload_date: 'week', duration: 'bogus', prioritize: 'popularity' }), { type: 'playlist', upload_date: 'week', duration: 'all', prioritize: 'popularity' });
  assert.deepEqual(searchFilters(null), { type: 'all', upload_date: 'all', duration: 'all', prioritize: 'relevance' });
});

// ------------------------------------------------------------------ Untertitel, Vorschaubilder

test('Untertitel-Spuren: absolute Adressen, automatisch erzeugte erkannt', () => {
  const tracks = captionTracks({ captions: { caption_tracks: [
    { base_url: '/api/timedtext?v=x&lang=en', language_code: 'en', name: { text: 'Englisch' }, kind: 'asr', is_translatable: true },
    { base_url: 'https://www.youtube.com/api/timedtext?v=x&lang=de', language_code: 'de', name: { text: 'Deutsch' } },
    { language_code: 'fr' },
  ] } });
  assert.deepEqual(tracks, [
    { lang: 'en', label: 'Englisch', auto: true, translatable: true, url: 'https://www.youtube.com/api/timedtext?v=x&lang=en' },
    { lang: 'de', label: 'Deutsch', auto: false, translatable: false, url: 'https://www.youtube.com/api/timedtext?v=x&lang=de' },
  ]);
});

test('YouTube-XML-Untertitel werden zu WebVTT', () => {
  const xml = '<timedtext format="3"><body><p t="1500" d="2000">Hallo &amp; <s>Welt</s></p><p d="10" t="4000"></p><p t="3723000" d="1000">Ende</p></body></timedtext>';
  assert.equal(timedTextToVtt(xml), 'WEBVTT\n\n00:00:01.500 --> 00:00:03.500\nHallo & Welt\n\n01:02:03.000 --> 01:02:04.000\nEnde\n');
  assert.equal(timedTextToVtt('<transcript><text start="1.25" dur="2">Alt&#39;es Format</text></transcript>'), "WEBVTT\n\n00:00:01.250 --> 00:00:03.250\nAlt'es Format\n");
  assert.equal(timedTextToVtt('<html>Fehler</html>'), '');
});

test('Vorschaubilder: größtes Raster bis 320 px, Ausschnitt an der richtigen Stelle', () => {
  const sb = storyboardOf({ storyboards: { boards: [
    { template_url: 'https://i.ytimg.com/sb/x/L0/default.jpg', thumbnail_width: 48, thumbnail_height: 27, thumbnail_count: 100, interval: 0, columns: 10, rows: 10 },
    { template_url: 'https://i.ytimg.com/sb/x/L2/M$M.jpg', thumbnail_width: 160, thumbnail_height: 90, thumbnail_count: 100, interval: 10000, columns: 5, rows: 5 },
    { template_url: 'https://i.ytimg.com/sb/x/L3/M$M.jpg', thumbnail_width: 640, thumbnail_height: 360, thumbnail_count: 100, interval: 10000, columns: 2, rows: 2 },
  ] } });
  assert.equal(sb.width, 160);
  // Bild 33 = Raster 1, darin Position 8 → Spalte 3, Zeile 1
  assert.deepEqual(storyboardFrame(sb, 335_000, 1_000_000), { url: 'https://i.ytimg.com/sb/x/L2/M1.jpg', x: 480, y: 90, width: 160, height: 90 });
  // Ohne Abstand: gleichmäßig über die Dauer verteilt
  assert.equal(storyboardFrame({ ...sb, intervalMs: 0 }, 999_999, 1_000_000).url, 'https://i.ytimg.com/sb/x/L2/M3.jpg');
  assert.equal(storyboardFrame(null, 1000, 1000), null);
});

test('Abgebrochene Stream-Suche ist ein AbortError', () => {
  const e = new StreamAborted();
  assert.equal(e.name, 'AbortError');
});

// ------------------------------------------------------------------ SponsorBlock

test('SponsorBlock: Überspringen, Stummschalten, Highlight, ganzes Video, Kapitel', () => {
  const id = 'dQw4w9WgXcQ';
  const list = [{ videoID: id, segments: [
    { segment: [10, 20], category: 'sponsor', actionType: 'skip', UUID: 'a' },
    { segment: [30, 40], category: 'music_offtopic', actionType: 'mute', UUID: 'b' },
    { segment: [50, 60], category: 'intro', actionType: 'skip', UUID: 'c' },
    { segment: [95.5, 95.5], category: 'poi_highlight', actionType: 'poi', UUID: 'd' },
    { segment: [0, 0], category: 'selfpromo', actionType: 'full', UUID: 'e' },
    { segment: [0, 100], category: 'chapter', actionType: 'chapter', description: 'Anfang', UUID: 'f' },
    { segment: [100, 200], category: 'chapter', actionType: 'chapter', description: 'Ende', UUID: 'g' },
  ] }];
  const r = parseSegments(list, id, ['sponsor', 'music_offtopic']);
  assert.deepEqual(r.segments.map((s) => [s.category, s.action, s.startMs, s.endMs]), [['sponsor', 'skip', 10000, 20000], ['music_offtopic', 'mute', 30000, 40000]]);
  assert.deepEqual(r.highlight, { startMs: 95500, uuid: 'd' });
  assert.deepEqual(r.full, { category: 'selfpromo', label: 'Eigenwerbung' });
  assert.deepEqual(r.chapters.map((c) => [c.title, c.startMs]), [['Anfang', 0], ['Ende', 100000]]);
  assert.deepEqual(parseSegments([], id, ['sponsor']), { segments: [], highlight: null, full: null, chapters: [] });
});

// ------------------------------------------------------------------ DeArrow, Return YouTube Dislike

test('DeArrow: nur Community-Titel/-Bilder mit genug Stimmen, ">" heißt nur "nicht formatieren"', () => {
  assert.equal(cleanTitle('>  Der  echte Titel '), 'Der echte Titel');
  assert.deepEqual(parseBranding({ titles: [{ title: 'Original', original: true, votes: 5 }, { title: '>Besser', original: false, votes: 0 }], thumbnails: [{ timestamp: 12.5, original: false, votes: 1 }] }), { title: 'Besser', thumbnailTime: 12.5 });
  assert.equal(parseBranding({ titles: [{ title: 'Schlecht', original: false, votes: -1 }], thumbnails: [{ original: true, votes: 3 }] }), null);
  assert.deepEqual(parseBranding({ titles: [{ title: 'Gesperrt', original: false, votes: -2, locked: true }] }), { title: 'Gesperrt' });
});

test('DeArrow: eine Anfrage pro Hash-Präfix, Ergebnisse gemerkt', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ aaaaaaaaaaa: { titles: [{ title: 'Neu', original: false, votes: 2 }], thumbnails: [] } }), { status: 200 });
  };
  const r1 = await brandingFor(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'kaputt'], fetchImpl);
  assert.deepEqual(r1, { aaaaaaaaaaa: { title: 'Neu', thumbnail: null } });
  assert.ok(calls.every((u) => /^https:\/\/sponsor\.ajay\.app\/api\/branding\/[0-9a-f]{4}$/.test(u)), 'nur der Präfix, nie die Video-ID');
  const before = calls.length;
  await brandingFor(['aaaaaaaaaaa', 'bbbbbbbbbbb'], fetchImpl);
  assert.equal(calls.length, before, 'aus dem Zwischenspeicher');
});

test('Return YouTube Dislike: Zahlen oder null', async () => {
  const ok = await votes('ccccccccccc', async () => new Response(JSON.stringify({ likes: 10, dislikes: 3 }), { status: 200 }));
  assert.deepEqual(ok, { likes: 10, dislikes: 3 });
  assert.equal(await votes('ddddddddddd', async () => new Response('x', { status: 500 })), null);
  assert.equal(await votes('kaputt', async () => assert.fail('keine Anfrage')), null);
});

// ------------------------------------------------------------------ Helfer der Oberfläche

test('Kapitel an einer Stelle', () => {
  const ch = [{ startMs: 0 }, { startMs: 60_000 }, { startMs: 120_000 }];
  assert.equal(chapterAt(ch, 0), 0);
  assert.equal(chapterAt(ch, 119_999), 1);
  assert.equal(chapterAt(ch, 500_000), 2);
  assert.equal(chapterAt([], 5), -1);
});

test('Text mit Links und Zeitstempeln', () => {
  assert.deepEqual(textParts('Ab 1:02:03 und 4:05 siehe https://example.com/a?b=1). Ende'), [
    { type: 'text', text: 'Ab ' },
    { type: 'time', text: '1:02:03', ms: 3_723_000 },
    { type: 'text', text: ' und ' },
    { type: 'time', text: '4:05', ms: 245_000 },
    { type: 'text', text: ' siehe ' },
    { type: 'link', text: 'https://example.com/a?b=1', url: 'https://example.com/a?b=1' },
    { type: 'text', text: ').' },
    { type: 'text', text: ' Ende' },
  ]);
  assert.deepEqual(textParts('12:345 keine Zeit'), [{ type: 'text', text: '12:345 keine Zeit' }]);
});

test('YouTube-Links: Video-ID und Startzeit', () => {
  assert.equal(videoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFromUrl('https://youtu.be/dQw4w9WgXcQ?t=1m30s'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFromUrl('https://m.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFromUrl('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(startFromUrl('https://youtu.be/dQw4w9WgXcQ?t=42'), 42_000);
  assert.equal(startFromUrl('https://youtu.be/dQw4w9WgXcQ?t=1h2m3s'), 3_723_000);
  assert.equal(startFromUrl('https://youtu.be/dQw4w9WgXcQ'), null);
});

test('DeArrow im Fenster: Abfragen gebündelt, "nichts" gemerkt, Fehler nicht', async () => {
  const batches = [];
  let fail = true;
  const loader = createBrandingLoader(async (ids) => {
    batches.push(ids);
    if (fail) throw new Error('weg');
    return { aaaaaaaaaaa: { title: 'T' } };
  }, { delayMs: 5 });
  const got = [];
  loader.get('aaaaaaaaaaa', (v) => got.push(v));
  loader.get('bbbbbbbbbbb', (v) => got.push(v));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(batches, [['aaaaaaaaaaa', 'bbbbbbbbbbb']]);
  assert.equal(got.length, 0, 'Dienst weg: nichts');
  fail = false;
  loader.get('aaaaaaaaaaa', (v) => got.push(v));
  loader.get('bbbbbbbbbbb', (v) => got.push(v));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(got, [{ title: 'T' }]);
  assert.equal(loader.peek('bbbbbbbbbbb'), null);
  loader.get('bbbbbbbbbbb', () => assert.fail('"nichts" ist gemerkt'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(batches.length, 2);
});
