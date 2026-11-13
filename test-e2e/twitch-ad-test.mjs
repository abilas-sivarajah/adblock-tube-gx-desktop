// Werbepausen im echten Programm durchspielen (braucht Internet): Ein echter Twitch-Live-Stream läuft im
// echten Player, die Werbung wird nachgestellt – die Playlisten der betroffenen Sitzungen bekommen
// Werbe-Markierungen wie bei Twitch (DATERANGE "twitch-stitched-ad", Stücke mit Titel "Amazon|…").
// Geprüft wird, was der Zuschauer merkt: Läuft das Bild weiter? Wie lange hängt es? Wie lange 360p?
// Wie weit liegt der Player danach hinter live?
//
// Twitch liefert Kanäle in zwei Formaten: MPEG-TS und fMP4 (Bild und Ton in einer Datei). Beide werden
// geprüft – fMP4-Kanäle froren früher ein (siehe renderer/mp4-fix.js).
//
//   npm run test:twitch-ads                 beide Formate, alle Fälle
//   AD_FORMAT=mp4 npm run test:twitch-ads   nur ein Format (ts | mp4)
//   AD_CASES=bruecke,ueberall npm run …     nur einzelne Fälle (eigene | bruecke | ueberall)
//   AD_CHANNEL=<login>                      bestimmter Kanal statt der meistgesehenen
//
// Das Fenster bleibt unsichtbar und ohne Ton.
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Läuft im Fenster vor allen anderen Skripten: stellt sich vor fetch und markiert in den Playlisten der
 * betroffenen Sitzungen die Stücke der Werbepause wie Twitch (der Werbeblocker sieht nur das Ergebnis).
 * __adSim.mode: off | native (nur die eigene Sitzung) | hq (eigene + alle in voller Qualität) | all
 * Anders als über Playwright-Routen bleibt der Abruf der Videostücke dabei unberührt (Routen bremsen ihn
 * so sehr, dass der Player ins Stocken kommt).
 */
function installSim() {
  const real = window.fetch.bind(window);
  const sim = (window.__adSim = { mode: 'off', since: 0, until: 0, ads: 0, native: null, kinds: new Map(), mp4: new Map() });
  const LQ = ['autoplay', 'picture-by-picture'];
  const hit = (kind) => sim.mode !== 'off' && (sim.mode === 'all' || kind === 'native' || (sim.mode === 'hq' && kind === 'hq'));
  const adify = (text) => {
    const out = [];
    let pdt = null;
    let any = false;
    for (let line of text.split('\n')) {
      if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(line.slice(25));
      else if (line.startsWith('#EXTINF:')) {
        const dur = (parseFloat(line.slice(8)) || 2) * 1000;
        if (pdt !== null && pdt + dur > sim.since && pdt < sim.until) {
          line = line.replace(/,.*$/, ',Amazon|4242');
          any = true;
        }
        pdt = pdt !== null ? pdt + dur : null;
      } else if (line.startsWith('#EXT-X-TWITCH-PREFETCH:') && pdt !== null && pdt > sim.since && pdt < sim.until) {
        continue;
      }
      out.push(line);
    }
    if (!any) return text;
    const at = out.findIndex((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:') || l.startsWith('#EXTINF:'));
    out.splice(
      at,
      0,
      `#EXT-X-DATERANGE:ID="stitched-ad-${sim.ads}",CLASS="twitch-stitched-ad",START-DATE="${new Date(sim.since).toISOString()}",DURATION=${((sim.until - sim.since) / 1000).toFixed(3)},X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL",X-TV-TWITCH-AD-POD-LENGTH="1",X-TV-TWITCH-AD-POD-POSITION="0"`,
    );
    return out.join('\n');
  };
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    const resp = await real(input, init);
    try {
      if (!resp.ok) return resp;
      if (url.includes('usher.ttvnw.net/api/channel/hls/')) {
        // Welche Playlist gehört zu welcher Sitzung?
        const text = await resp.clone().text();
        let type = '';
        try {
          type = JSON.parse(new URL(url).searchParams.get('token')).player_type ?? '';
        } catch {
          // egal
        }
        const kind = url === sim.native ? 'native' : LQ.includes(type) ? 'lq' : 'hq';
        const lines = text.split('\n');
        for (let i = 0; i < lines.length - 1; i++) if (lines[i].startsWith('#EXT-X-STREAM-INF')) sim.kinds.set(lines[i + 1].trim(), kind);
        return resp;
      }
      const kind = sim.kinds.get(url);
      if (kind) {
        const text = await resp.text();
        sim.mp4.set(kind, text.includes('#EXT-X-MAP'));
        return new Response(hit(kind) ? adify(text) : text, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
      }
    } catch {
      // egal
    }
    return resp;
  };
  document.addEventListener('DOMContentLoaded', () => {
    window.gx?.onSource?.(({ stream }) => {
      if (stream?.kind === 'twitch') sim.native = stream.url;
    });
  });
}

/** Beobachten: Meldungen des Werbeblockers und alle 250 ms der Zustand des Videos. */
function installProbe() {
  window.__adEvents = [];
  const ch = new BroadcastChannel('gx-twitch-adblock');
  ch.addEventListener('message', (e) => {
    const d = { ...(e.data ?? {}) };
    delete d.playlist;
    delete d.headers;
    window.__adEvents.push({ t: Date.now(), ...d });
  });
  window.__samples = [];
  const v = document.getElementById('video');
  setInterval(() => {
    let ahead = 0;
    for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.3 && v.buffered.end(i) >= v.currentTime) ahead = v.buffered.end(i) - v.currentTime;
    const c = [...(window.__abTwitchTest?.contexts.values() ?? [])].findLast((x) => x.tl);
    // Abstand zu live: Zeitstempel des letzten Stücks, das der Player bekam, minus was noch im Puffer liegt
    const latency = c?.tl?.lastEnd ? (Date.now() - (c.tl.lastEnd - ahead * 1000)) / 1000 : null;
    window.__samples.push({ t: Date.now(), ct: v.currentTime, h: v.videoHeight, paused: v.paused, ahead, latency, source: c?.tl?.source ?? '', inAd: Boolean(c?.inAd), ranges: v.buffered.length });
  }, 250);
}

const describe = (e, t0) => {
  const at = `+${((e.t - t0) / 1000).toFixed(1).padStart(5)} s`;
  switch (e.event) {
    case 'ad-start': return `${at}  Werbung erkannt`;
    case 'backup': return `${at}  Ersatz-Sitzung: ${e.type} ${e.res ?? ''}${e.lq ? ' (360p-Brücke)' : ''}${e.forced ? ' – lag zurück, trotzdem genommen' : ''}`;
    case 'masked': return e.hold ? `${at}  schwarzes Ersatzbild` : `${at}  Werbung verdeckt und stumm`;
    case 'unmasked': return `${at}  Ersatzbild weg`;
    case 'native-back': return `${at}  zurück zur eigenen Sitzung (von ${e.from})`;
    case 'ad-end': return `${at}  Werbepause vorbei`;
    case 'backup-result': return e.result === 'frei' ? null : `${at}    · ${e.type}: ${e.result}${e.error ? ` (${e.error})` : ''}`;
    case 'error': return `${at}  FEHLER ${e.error}`;
    default: return null;
  }
};

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-twitch-ads-'));
const app = await electron.launch({
  args: [root, '--no-sandbox', '--hidden', '--mute-audio'],
  cwd: root,
  env: { ...process.env, GXTUBE_USER_DATA: userData, GXTUBE_PORT: '19985', GXTUBE_DISCOVERY_PORT: '19986', GXTUBE_NO_UPDATES: '1' },
});
const failures = [];
let where = '';
const check = (ok, what) => {
  console.log(ok ? '  ✔' : '  ✘', what);
  if (!ok) failures.push(`${where}: ${what}`);
};
try {
  // Fenster nie zeigen und nie nach vorne holen – auch nicht, wenn ein Stream startet
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.show = () => {};
      w.focus = () => {};
      w.moveTop = () => {};
      w.setFullScreen = () => {};
    }
  });
  // Das Simulations-Skript muss vor dem Werbeblocker laufen: eintragen und das Fenster neu laden
  await app.context().addInitScript(installSim);
  const win = await app.firstWindow();
  const logs = [];
  win.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text().slice(0, 200));
  });
  await win.waitForSelector('#castHero h1', { timeout: 30_000 });
  await win.evaluate(() => {
    window.__beforeReload = true;
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('renderer/index.html'))?.webContents.reload());
  await win.waitForFunction(() => !window.__beforeReload && Boolean(window.__adSim) && Boolean(document.querySelector('#castHero h1')), null, { timeout: 30_000 });
  await win.waitForSelector('#platformSwitch [data-platform="twitch"]', { timeout: 30_000 });
  await sleep(1500);
  assert.equal(await win.evaluate(() => window.__abTwitchWorker === true), true, 'Werbeblocker nicht geladen');
  await win.click('#platformSwitch [data-platform="twitch"]');
  await win.evaluate(installProbe);

  const state = () =>
    win.evaluate(() => {
      const s = window.__samples.at(-1) ?? {};
      return { ct: s.ct ?? 0, source: s.source ?? '', inAd: Boolean(s.inAd), h: s.h ?? 0, mp4: window.__adSim.mp4.get('native') ?? null, events: window.__adEvents.length, samples: window.__samples.length, latency: s.latency ?? null };
    });

  /** Stream starten und warten, bis er ohne (echte) Werbung auf der eigenen Sitzung läuft. */
  async function start(login) {
    await win.evaluate((channel) => {
      window.__adSim.mode = 'off';
      window.gx.play({ id: `twitch:${channel}`, title: '', channelName: channel, channelLogin: channel, isLive: true, durationSec: -1 });
    }, login);
    const from = (await state()).samples;
    await win.waitForFunction((n) => window.__samples.length > n + 8 && window.__samples.at(-1).ct > 3 && window.__samples.at(-1).source, from, { timeout: 60_000 });
    // Echte Start-Werbung abwarten: erst wenn 10 s lang die eigene Sitzung ohne Werbung läuft, geht es los
    let calm = 0;
    let realAd = false;
    for (let i = 0; i < 180 && calm < 10; i++) {
      await sleep(1000);
      const s = await state();
      if (s.inAd || !s.source.startsWith('native')) {
        realAd = true;
        calm = 0;
      } else calm++;
    }
    return { realAd, calm: calm >= 10, ...(await state()) };
  }

  async function run(name, mode, adSec, expect) {
    console.log(`\n── ${name} (${adSec} s Werbung)`);
    const from = await state();
    const t0 = Date.now();
    const until = t0 + adSec * 1000;
    await win.evaluate((x) => Object.assign(window.__adSim, { ads: window.__adSim.ads + 1, ...x }), { mode, since: t0, until });
    // bis die Werbepause vorbei ist und der Player wieder die eigene Sitzung hat
    const deadline = Date.now() + (adSec + 80) * 1000;
    let ended = false;
    while (Date.now() < deadline && !ended) {
      await sleep(1000);
      const s = await win.evaluate((n) => ({ end: window.__adEvents.slice(n).some((e) => e.event === 'ad-end'), started: window.__adEvents.slice(n).some((e) => e.event === 'ad-start'), source: window.__samples.at(-1).source }), from.events);
      ended = s.started && s.end && Date.now() > until && s.source.startsWith('native');
    }
    const back = (Date.now() - until) / 1000;
    await sleep(8000);
    const { events, samples } = await win.evaluate((f) => ({ events: window.__adEvents.slice(f.events), samples: window.__samples.slice(f.samples) }), from);
    await win.evaluate(() => {
      window.__adSim.mode = 'off';
    });
    for (const e of events) {
      const line = describe(e, t0);
      if (line) console.log('  ' + line);
    }
    // Hänger: Zeit, in der das Bild stand, obwohl nicht pausiert
    let stalled = 0;
    let longest = 0;
    let streak = 0;
    let lowMs = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      const dt = b.t - a.t;
      if (!b.paused && b.ct - a.ct < 0.02) {
        stalled += dt;
        streak += dt;
        longest = Math.max(longest, streak);
      } else streak = 0;
      if (b.h > 0 && b.h <= 360) lowMs += dt;
    }
    const last = samples.at(-1);
    const played = last.ct - samples[0].ct;
    const real = (last.t - samples[0].t) / 1000;
    console.log(`  Bild stand insgesamt ${(stalled / 1000).toFixed(1)} s (längster Hänger ${(longest / 1000).toFixed(1)} s) · in 360p ${(lowMs / 1000).toFixed(0)} s · gespielt ${played.toFixed(0)} von ${real.toFixed(0)} s`);
    console.log(`  eigene Sitzung wieder ${back.toFixed(0)} s nach Ende der Werbung · Abstand zu live vorher ${from.latency?.toFixed(1)} s, nachher ${last.latency?.toFixed(1)} s · danach ${last.source.replace(/:.*/, '')} ${last.h}p`);
    const has = (ev, f = () => true) => events.some((e) => e.event === ev && f(e));
    check(has('ad-start'), 'Werbung wurde erkannt');
    check(ended, 'nach der Werbepause läuft wieder die eigene Sitzung');
    check(longest <= expect.maxStallMs, `kein langer Hänger (längster ${(longest / 1000).toFixed(1)} s, erlaubt ${expect.maxStallMs / 1000} s)`);
    check(played >= real * 0.85, `das Bild läuft durch (${played.toFixed(0)} von ${real.toFixed(0)} s)`);
    if (expect.backup) check(has('backup'), 'eine Ersatz-Sitzung übernimmt');
    if (expect.hold === true) check(has('masked', (e) => e.hold), 'schwarzes Ersatzbild statt Werbung');
    if (expect.hold === false) check(!has('masked'), 'kein schwarzes Bild, nichts verdeckt');
    if (expect.masked) check(has('masked'), 'Werbung wird verdeckt und stumm geschaltet');
    if (expect.maxBackSec !== undefined) check(ended && back <= expect.maxBackSec, `zügig zurück zur eigenen Sitzung (${back.toFixed(0)} s nach Ende der Werbung, erlaubt ${expect.maxBackSec} s)`);
    if (from.latency != null && last.latency != null) check(last.latency - from.latency <= 5, `nicht weiter hinter live als vorher (${(last.latency - from.latency).toFixed(1)} s dazu, erlaubt 5 s)`);
  }

  // Kanäle: die meistgesehenen (stabile Quellen), je einer pro Format
  const wantFormats = (process.env.AD_FORMAT ?? 'ts,mp4').split(',').map((s) => s.trim()).filter(Boolean);
  const candidates = process.env.AD_CHANNEL ? [process.env.AD_CHANNEL] : (await win.evaluate(() => window.gx.twitchStreams(''))).items.slice(0, 14).map((s) => s.channelLogin);
  assert.ok(candidates.length, 'kein Live-Kanal gefunden');
  const wantCases = (process.env.AD_CASES ?? 'eigene,bruecke,ueberall').split(',').map((s) => s.trim()).filter(Boolean);
  const done = new Set();
  let n = 0;
  for (const login of candidates) {
    if (!process.env.AD_CHANNEL && done.size >= wantFormats.length) break;
    n++;
    const s = await start(login);
    const format = s.mp4 ? 'mp4' : 'ts';
    if (!process.env.AD_CHANNEL && (!wantFormats.includes(format) || done.has(format))) continue;
    done.add(format);
    where = format === 'mp4' ? 'fMP4' : 'MPEG-TS';
    console.log(`\n════ Kanal ${n} · Format ${where} · ${s.h}p${s.realAd ? ' · echte Werbung beim Start abgewartet' : ''}`);
    check(s.calm, 'Stream läuft auf der eigenen Sitzung');
    const before = await state();
    await sleep(8000);
    const after = await state();
    check(after.ct - before.ct > 6, `das Bild läuft (${(after.ct - before.ct).toFixed(1)} s in 8 s)`);
    const cases = {
      // Werbung nur in der eigenen Sitzung: eine Ersatz-Sitzung in voller Qualität übernimmt
      eigene: () => run('Werbung nur in der eigenen Sitzung', 'native', 30, { maxStallMs: 3000, hold: false, backup: true, maxBackSec: 20 }),
      // Alle Sitzungen in voller Qualität zeigen Werbung: die 360p-Brücke trägt die Pause
      bruecke: () => run('Werbung in allen Sitzungen mit voller Qualität', 'hq', 30, { maxStallMs: 3000, hold: false, backup: true, maxBackSec: 20 }),
      // Überall Werbung: schwarzes Ersatzbild (MPEG-TS) bzw. verdeckt und stumm (fMP4), danach live weiter
      ueberall: () => run('Werbung überall', 'all', 24, format === 'mp4' ? { maxStallMs: 3500, masked: true, maxBackSec: 20 } : { maxStallMs: 3500, hold: true, maxBackSec: 20 }),
    };
    for (const name of wantCases) {
      assert.ok(cases[name], `unbekannter Fall: ${name}`);
      await cases[name]();
      await sleep(5000);
    }
  }
  for (const f of wantFormats) if (!process.env.AD_CHANNEL && !done.has(f)) console.log(`\nKein Kanal im Format ${f} unter den ${candidates.length} meistgesehenen – nicht geprüft.`);
  if (logs.length) console.log('\nMeldungen im Fenster:\n  ' + [...new Set(logs)].slice(-10).join('\n  '));
  console.log(failures.length ? `\n${failures.length} Prüfung(en) fehlgeschlagen:\n  ${failures.join('\n  ')}` : '\nWerbepausen-Test bestanden');
} finally {
  await app.close().catch(() => {});
  fs.rmSync(userData, { recursive: true, force: true });
}
if (failures.length) process.exit(1);
