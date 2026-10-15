// Electron-Testskript: PO-Token erzeugen und prüfen, ob damit gesperrte Videos abspielbar werden.
// Aufruf: xvfb-run electron test-e2e/potoken-test.mjs [Video-IDs …]
import { app, net } from 'electron';

// Kein Top-Level-await vor "ready" – das blockiert Electron
app.whenReady().then(async () => {
const YT = await import('../src/main/youtube.js');
const PT = await import('../src/main/potoken.js');
YT.configure({ lang: 'de', location: 'DE', fetch: (u, i) => net.fetch(u instanceof URL ? u.toString() : u, i) });
const ids = process.argv.slice(2).filter((a) => /^[\w-]{11}$/.test(a));
const videos = ids.length ? ids : ['VpkqL98Ualo', 'jNQXAC9IVRw', 'dQw4w9WgXcQ'];
try {
  const yt = await YT.client();
  const visitor = yt.session.context.client.visitorData;
  let t = Date.now();
  const sessionPot = await PT.mint(visitor);
  console.log('PO-Token (Visitor):', sessionPot.slice(0, 24) + '…', sessionPot.length, 'Zeichen,', Date.now() - t, 'ms');
  t = Date.now();
  await PT.mint('dQw4w9WgXcQ');
  console.log('Zweites Token:', Date.now() - t, 'ms');
  for (const id of videos) {
    const contentPot = await PT.mint(id);
    for (const client of ['MWEB', 'WEB', 'IOS']) {
      try {
        yt.session.player.po_token = sessionPot;
        const info = await yt.getBasicInfo(id, { client, po_token: contentPot });
        const st = info.playability_status;
        if (st?.status !== 'OK') { console.log(id, client, '→', st?.status, (st?.reason || '').slice(0, 50)); continue; }
        const formats = info.streaming_data?.adaptive_formats ?? [];
        const v = formats.filter((f) => f.has_video && f.height <= 1080).sort((a, b) => b.height - a.height)[0];
        if (!v) { console.log(id, client, '→ OK, aber keine Formate'); continue; }
        const url = await v.decipher(yt.session.player);
        const mid = Math.floor(Number(v.content_length) * 0.5);
        const r = await net.fetch(`${url}&range=${mid}-${mid + 1023}`);
        console.log(id, client, '→ OK', v.quality_label, 'Mitte der Datei:', r.status, url.includes('pot=') ? '(mit pot)' : '');
      } catch (e) {
        console.log(id, client, 'Fehler', e.message?.slice(0, 100));
      } finally {
        yt.session.player.po_token = undefined;
      }
    }
  }
} catch (e) {
  console.log('FEHLER', e?.stack || e);
}
PT.dispose();
app.quit();
});
