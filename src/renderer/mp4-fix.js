// Twitch liefert manche Kanäle (und deren Werbung) als fMP4 mit Bild und Ton in einer Datei. In jedem
// Stück steht dabei die Tonspur vor der Bildspur. Shaka (bis mindestens 5.3) liest für die Platzierung im
// Puffer den Zeitstempel der ERSTEN Spur, rechnet aber mit der Zeitbasis der Bildspur (z. B. 48 000 gegen
// 1 000 000 Einheiten pro Sekunde). Jedes Stück landet dann an einer falschen Stelle, zwischen den Stücken
// klaffen Lücken – das Bild friert ein. Abhilfe: die Bildspur im ersten Fragment nach vorn holen. Die Größen
// bleiben gleich, die Verweise auf die Bild-/Tondaten (relativ zum Fragment) stimmen also weiter.

const MOOV = 0x6d6f6f76;
const TRAK = 0x7472616b;
const TKHD = 0x746b6864;
const MDIA = 0x6d646961;
const HDLR = 0x68646c72;
const VIDE = 0x76696465;
const MOOF = 0x6d6f6f66;
const TRAF = 0x74726166;
const TFHD = 0x74666864;

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/** Boxen zwischen [start] und [end]: { type, start, body, end }. Bricht bei kaputten Größen ab. */
function boxes(b, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    let head = 8;
    if (size === 1) {
      // 64-Bit-Größe: nur brauchbar, wenn sie in 32 Bit passt
      if (o + 16 > end || u32(b, o + 8) !== 0) break;
      size = u32(b, o + 12);
      head = 16;
    } else if (size === 0) size = end - o;
    if (size < head || o + size > end) break;
    out.push({ type: u32(b, o + 4), start: o, body: o + head, end: o + size });
    o += size;
  }
  return out;
}

const find = (list, type) => list.find((x) => x.type === type) ?? null;

/** Spur-ID der Bildspur aus einem Init-Stück (moov) – null, wenn [bytes] kein Init-Stück ist. */
export function videoTrackId(bytes) {
  const moov = find(boxes(bytes, 0, bytes.length), MOOV);
  if (!moov) return null;
  for (const trak of boxes(bytes, moov.body, moov.end)) {
    if (trak.type !== TRAK) continue;
    const inTrak = boxes(bytes, trak.body, trak.end);
    const tkhd = find(inTrak, TKHD);
    const mdia = find(inTrak, MDIA);
    const hdlr = mdia ? find(boxes(bytes, mdia.body, mdia.end), HDLR) : null;
    if (!tkhd || !hdlr || hdlr.body + 12 > hdlr.end) continue;
    if (u32(bytes, hdlr.body + 8) !== VIDE) continue;
    // tkhd: Version (1) + Flags (3), dann Zeiten (je 4 oder 8 Byte), dann die Spur-ID
    const at = tkhd.body + (bytes[tkhd.body] === 1 ? 20 : 12);
    return at + 4 <= tkhd.end ? u32(bytes, at) : null;
  }
  return null;
}

/**
 * Im ersten Fragment (moof) eines Stücks die Bildspur [videoTrack] vor die anderen Spuren setzen.
 * Ändert [bytes] an Ort und Stelle; true, wenn umsortiert wurde.
 */
export function videoTrafFirst(bytes, videoTrack) {
  const moof = find(boxes(bytes, 0, bytes.length), MOOF);
  if (!moof) return false;
  const children = boxes(bytes, moof.body, moof.end);
  // Nur wenn die Boxen das Fragment lückenlos füllen (sonst lieber nichts anfassen)
  if (!children.length || children.at(-1).end !== moof.end) return false;
  const trafs = [];
  for (const c of children) {
    if (c.type !== TRAF) continue;
    const tfhd = find(boxes(bytes, c.body, c.end), TFHD);
    if (!tfhd || tfhd.body + 8 > tfhd.end) return false;
    const flags = u32(bytes, tfhd.body) & 0xffffff;
    // Ohne feste Basis (weder "default-base-is-moof" noch absolute Adresse) hängen die Daten-Verweise
    // von der Reihenfolge der Spuren ab – dann darf nicht umsortiert werden
    if (!(flags & 0x020000) && !(flags & 0x000001)) return false;
    trafs.push({ box: c, track: u32(bytes, tfhd.body + 4) });
  }
  if (trafs.length < 2 || trafs[0].track === videoTrack) return false;
  const video = trafs.find((t) => t.track === videoTrack);
  if (!video) return false;
  const order = children.filter((c) => c !== video.box);
  order.splice(order.indexOf(trafs[0].box), 0, video.box);
  const copy = bytes.slice(moof.body, moof.end);
  let at = moof.body;
  for (const c of order) {
    bytes.set(copy.subarray(c.start - moof.body, c.end - moof.body), at);
    at += c.end - c.start;
  }
  return true;
}
