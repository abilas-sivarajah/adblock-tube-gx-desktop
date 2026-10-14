import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/main/session.js';

const v = (id, extra = {}) => ({ id: id.padEnd(11, '_'), title: id, durationSec: 100, ...extra });

function record(session) {
  const loads = [];
  session.on('load', (l) => loads.push(l.video.id.replace(/_+$/, '')));
  return loads;
}

test('Abspielen ersetzt die Warteschlange, Playlist wird übernommen', () => {
  const s = new Session();
  const loads = record(s);
  s.play(v('a'));
  assert.equal(s.items.length, 1);
  s.play(v('c'), { queue: [v('b'), v('c'), v('d')] });
  assert.equal(s.index, 1);
  assert.deepEqual(loads, ['a', 'c']);
});

test('Anhängen und als Nächstes', () => {
  const s = new Session();
  const loads = record(s);
  s.add(v('a')); // läuft nichts → startet
  s.add(v('c'));
  s.add(v('b'), { next: true });
  assert.deepEqual(s.items.map((x) => x.title), ['a', 'b', 'c']);
  assert.ok(s.next());
  assert.ok(s.next());
  assert.ok(!s.hasNext);
  assert.deepEqual(loads, ['a', 'b', 'c']);
});

test('Zurück: nach 5 Sekunden an den Anfang, sonst vorheriges Video', () => {
  const s = new Session();
  s.play(v('b'), { queue: [v('a'), v('b')] });
  assert.equal(s.previous(12000), false);
  assert.equal(s.index, 1);
  assert.equal(s.previous(2000), true);
  assert.equal(s.index, 0);
  assert.equal(s.previous(0), false);
});

test('Entfernen verschiebt die Position richtig', () => {
  const s = new Session();
  const loads = record(s);
  s.play(v('c'), { queue: [v('a'), v('b'), v('c'), v('d')] });
  s.remove(0);
  assert.equal(s.current.title, 'c');
  s.remove(1); // das laufende → nächstes startet
  assert.equal(s.current.title, 'd');
  assert.deepEqual(loads, ['c', 'd']);
  let stopped = false;
  s.on('stop', () => (stopped = true));
  s.remove(1);
  s.remove(0);
  assert.ok(stopped);
  assert.equal(s.current, null);
});

test('Autoplay nimmt ein ähnliches, noch nicht gesehenes Video', () => {
  const s = new Session({ recentlyWatched: () => ['seen'.padEnd(11, '_')] });
  s.play(v('a'));
  s.setRelated(s.current.id, [v('seen'), v('live', { isLive: true }), v('short', { isShort: true }), v('fresh')]);
  assert.ok(s.ended());
  assert.equal(s.current.title, 'fresh');
  assert.equal(s.current.autoplay, true);
  s.setAutoplay(false);
  assert.equal(s.ended(), false);
});

test('Ähnliche Videos eines alten Videos zählen nicht', () => {
  const s = new Session();
  s.play(v('a'));
  s.setRelated('anderes_id', [v('x')]);
  assert.equal(s.nextRelated(), null);
});
