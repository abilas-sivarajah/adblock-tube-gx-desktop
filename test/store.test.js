import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/main/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gxtube-store-'));
const video = (id) => ({ id, title: id, channelName: 'K', durationSec: 600 });

test('Einstellungen: Standardwerte, Gerätekennung, nur bekannte Felder', () => {
  const dir = tmp();
  const s = new Store(dir);
  assert.ok(s.settings.deviceId.length > 10);
  assert.ok(s.settings.deviceName);
  s.updateSettings({ maxQuality: 720, autoplay: false, hacker: true, deviceId: 'x', volume: 300, deviceName: '  Wohnzimmer  ' });
  const again = new Store(dir);
  assert.equal(again.settings.maxQuality, 720);
  assert.equal(again.settings.autoplay, false);
  assert.equal(again.settings.hacker, undefined);
  assert.equal(again.settings.deviceId, s.settings.deviceId);
  assert.equal(again.settings.volume, 100);
  assert.equal(again.settings.deviceName, 'Wohnzimmer');
});

test('Verlauf und Weiterschauen', () => {
  const dir = tmp();
  const s = new Store(dir);
  s.recordWatch(video('aaaaaaaaaaa'));
  s.updateProgress('aaaaaaaaaaa', 120000, 600000);
  assert.equal(s.resumePosition('aaaaaaaaaaa'), 120000);
  s.updateProgress('aaaaaaaaaaa', 595000, 600000);
  assert.equal(s.resumePosition('aaaaaaaaaaa'), 0, 'fast fertig → von vorn');
  s.recordWatch(video('bbbbbbbbbbb'));
  assert.equal(s.history[0].video.id, 'bbbbbbbbbbb');
  s.saveLibraryNow();
  const again = new Store(dir);
  assert.equal(again.history.length, 2);
  again.removeHistory('aaaaaaaaaaa');
  assert.equal(again.history.length, 1);
});

test('Empfehlungen ohne Gesehenes und ohne Shorts', () => {
  const s = new Store(tmp());
  s.recordWatch(video('seen_______'));
  s.addRecommendations([video('seen_______'), { ...video('short______'), isShort: true }, video('new________')]);
  assert.deepEqual(s.recommendations.map((v) => v.id), ['new________']);
});

test('Abos: abonnieren, beenden, aus dem Konto dazunehmen, bleiben gespeichert', () => {
  const dir = tmp();
  const s = new Store(dir);
  const rick = { id: 'UCuAXFkgsw1L7xaCfnd5JJOw', name: 'Rick Astley', thumbnail: null };
  s.setSubscribed(rick, true);
  s.setSubscribed({ id: 'UC0000000000000000000001', name: 'Zwei', thumbnail: null }, true);
  assert.equal(s.subscriptions[0].name, 'Zwei', 'neueste zuerst');
  assert.ok(s.isSubscribed(rick.id));
  s.setSubscribed(rick, false);
  assert.equal(s.isSubscribed(rick.id), false);
  assert.equal(s.mergeSubscriptions([{ id: 'UC0000000000000000000001', name: 'Zwei', thumbnail: null }]), false, 'nichts Neues');
  assert.equal(s.mergeSubscriptions([rick, { id: 'UC0000000000000000000001', name: 'Zwei (neu)', thumbnail: null }]), true);
  s.saveLibraryNow();
  const again = new Store(dir);
  assert.deepEqual(again.subscriptions.map((c) => c.name).sort(), ['Rick Astley', 'Zwei (neu)']);
});
