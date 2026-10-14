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
