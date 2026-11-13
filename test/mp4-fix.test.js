// Twitch-fMP4 mit Bild und Ton in einer Datei: Die Bildspur muss im ersten Fragment vorn stehen, sonst
// setzt Shaka die Stücke an falsche Stellen (Zeitstempel der Tonspur, Zeitbasis der Bildspur).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoTrackId, videoTrafFirst } from '../src/renderer/mp4-fix.js';

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const fourcc = (s) => [...s].map((c) => c.charCodeAt(0));
/** Eine MP4-Box aus Typ und Inhalt (Bytes oder weitere Boxen). */
const box = (type, ...content) => {
  const body = content.flat();
  return [...u32(8 + body.length), ...fourcc(type), ...body];
};
const bytes = (...parts) => Uint8Array.from(parts.flat());

// So baut Twitch seine Stücke: Spur 1 = Ton (48 000 Einheiten/s), Spur 2 = Bild (1 000 000 Einheiten/s)
const AUDIO = 1;
const VIDEO = 2;
const tkhd = (id, version = 0) => box('tkhd', [version, 0, 0, 7], version === 1 ? new Array(16).fill(0) : new Array(8).fill(0), u32(id), new Array(8).fill(0));
const mdhd = (timescale) => box('mdhd', [0, 0, 0, 0], u32(0), u32(0), u32(timescale), u32(0));
const hdlr = (kind) => box('hdlr', [0, 0, 0, 0], u32(0), fourcc(kind), new Array(12).fill(0));
const trak = (id, kind, timescale, version = 0) => box('trak', tkhd(id, version), box('mdia', mdhd(timescale), hdlr(kind)));
const init = (...traks) => bytes(box('ftyp', fourcc('iso5'), u32(0)), box('moov', box('mvhd', new Array(20).fill(0)), ...traks));

const tfhd = (track, flags = 0x020000) => box('tfhd', u32(flags), u32(track));
const tfdt = (time) => box('tfdt', [1, 0, 0, 0], u32(0), u32(time));
const trun = (samples) => box('trun', u32(0x000201), u32(samples), u32(100), new Array(samples * 4).fill(7));
const traf = (track, time, samples, flags) => box('traf', tfhd(track, flags), tfdt(time), trun(samples));
const moof = (...trafs) => box('moof', box('mfhd', u32(0), u32(1)), ...trafs);
const mdat = (n, fill) => box('mdat', new Array(n).fill(fill));

/** Was Shaka liest: den Zeitstempel (tfdt) der ersten Spur im ersten Fragment. */
function firstTfdt(b) {
  const at = b.findIndex((_, i) => b[i] === 0x74 && b[i + 1] === 0x66 && b[i + 2] === 0x64 && b[i + 3] === 0x74);
  return ((b[at + 12] << 24) | (b[at + 13] << 16) | (b[at + 14] << 8) | b[at + 15]) >>> 0;
}
/** Spur-IDs (tfhd) der Reihe nach. */
function trackOrder(b) {
  const out = [];
  for (let i = 0; i + 16 <= b.length; i++) if (b[i] === 0x74 && b[i + 1] === 0x66 && b[i + 2] === 0x68 && b[i + 3] === 0x64) out.push(b[i + 11]);
  return out;
}

test('Bildspur aus dem Init-Stück: Ton zuerst, Bild als zweite Spur', () => {
  assert.equal(videoTrackId(init(trak(AUDIO, 'soun', 48000), trak(VIDEO, 'vide', 1_000_000))), 2);
  assert.equal(videoTrackId(init(trak(7, 'vide', 90000, 1), trak(3, 'soun', 44100))), 7, 'auch mit tkhd Version 1');
  assert.equal(videoTrackId(init(trak(AUDIO, 'soun', 48000))), null, 'nur Ton');
});

test('Kein Init-Stück: Videostück, MPEG-TS und Müll liefern null', () => {
  assert.equal(videoTrackId(bytes(moof(traf(AUDIO, 1, 2), traf(VIDEO, 2, 2)), mdat(8, 1))), null);
  const ts = new Uint8Array(376);
  ts[0] = ts[188] = 0x47;
  assert.equal(videoTrackId(ts), null);
  assert.equal(videoTrackId(new Uint8Array(0)), null);
  assert.equal(videoTrackId(Uint8Array.from([0, 0, 0, 200, 109, 111, 111, 118, 1, 2])), null, 'abgeschnitten');
});

test('Bildspur kommt im ersten Fragment nach vorn – Shaka liest dann den Zeitstempel des Bildes', () => {
  // 66,016 s Ton (48 kHz) und 65,933 s Bild (1 MHz): wie in einem echten Twitch-Stück
  const seg = bytes(box('emsg', new Array(40).fill(3)), moof(traf(AUDIO, 3_168_768, 3), traf(VIDEO, 65_933_000, 2)), mdat(64, 9), moof(traf(AUDIO, 3_169_792, 1), traf(VIDEO, 66_033_000, 1)), mdat(16, 8));
  const before = seg.slice();
  assert.equal(firstTfdt(seg), 3_168_768, 'vorher: Zeitstempel der Tonspur');
  assert.equal(videoTrafFirst(seg, VIDEO), true);
  assert.equal(firstTfdt(seg), 65_933_000, 'nachher: Zeitstempel der Bildspur');
  assert.deepEqual(trackOrder(seg), [VIDEO, AUDIO, AUDIO, VIDEO], 'nur das erste Fragment wird umsortiert');
  assert.equal(seg.length, before.length, 'gleiche Länge');
  // Alles außerhalb des ersten Fragments bleibt Byte für Byte gleich (die Daten-Verweise stimmen weiter)
  const moofAt = 48;
  const moofLen = (seg[moofAt] << 24) | (seg[moofAt + 1] << 16) | (seg[moofAt + 2] << 8) | seg[moofAt + 3];
  assert.deepEqual([...seg.slice(0, moofAt + 8)], [...before.slice(0, moofAt + 8)], 'Kopf des Fragments unverändert');
  assert.deepEqual([...seg.slice(moofAt + moofLen)], [...before.slice(moofAt + moofLen)], 'Rest unverändert');
  // Die Spuren selbst sind nur vertauscht, nicht verändert
  const mfhd = 16;
  const audioLen = traf(AUDIO, 3_168_768, 3).length;
  const videoLen = traf(VIDEO, 65_933_000, 2).length;
  const start = moofAt + 8 + mfhd;
  assert.deepEqual([...seg.slice(start, start + videoLen)], [...before.slice(start + audioLen, start + audioLen + videoLen)], 'Bildspur unverändert');
  assert.deepEqual([...seg.slice(start + videoLen, start + videoLen + audioLen)], [...before.slice(start, start + audioLen)], 'Tonspur unverändert');
  assert.equal(videoTrafFirst(seg, VIDEO), false, 'ein zweites Mal ändert nichts');
});

test('Nichts anfassen, wenn es nichts zu tun gibt oder die Reihenfolge wichtig ist', () => {
  const same = (seg, track = VIDEO) => {
    const before = seg.slice();
    assert.equal(videoTrafFirst(seg, track), false);
    assert.deepEqual([...seg], [...before]);
  };
  same(bytes(moof(traf(VIDEO, 5, 2), traf(AUDIO, 6, 2)), mdat(8, 1))); // Bild steht schon vorn
  same(bytes(moof(traf(VIDEO, 5, 2)), mdat(8, 1))); // nur eine Spur (z. B. YouTube-artig getrennt)
  same(bytes(moof(traf(AUDIO, 5, 2), traf(3, 6, 2)), mdat(8, 1))); // Bildspur nicht dabei
  // Alte Schreibweise ohne feste Basis: Die Daten-Verweise hängen an der Reihenfolge
  same(bytes(moof(traf(AUDIO, 5, 2, 0), traf(VIDEO, 6, 2, 0)), mdat(8, 1)));
  same(bytes(mdat(8, 1))); // kein Fragment
  const ts = new Uint8Array(376);
  ts[0] = ts[188] = 0x47;
  same(ts); // MPEG-TS
  same(new Uint8Array(0));
});

test('Mit absoluter Daten-Adresse (base-data-offset) darf umsortiert werden', () => {
  const seg = bytes(moof(traf(AUDIO, 5, 2, 0x000001), traf(VIDEO, 6, 2, 0x000001)), mdat(8, 1));
  assert.equal(videoTrafFirst(seg, VIDEO), true);
  assert.deepEqual(trackOrder(seg), [VIDEO, AUDIO]);
});
