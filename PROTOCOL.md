# GX-Tube-Streaming-Protokoll (Version 1)

So steuert die [GX Tube Android-App](https://github.com/abilas-sivarajah/adblock-tube-gx) den PC –
ähnlich wie die YouTube-App einen Fernseher. Alles läuft nur im **lokalen Netz** (WLAN/LAN),
ohne Server dazwischen.

| | |
|---|---|
| Suche | UDP, Port **8766** |
| Steuerung | WebSocket `ws://<PC>:8765/gxtube` (Port weicht bei Belegung auf 8766–8774 aus; die Suche meldet den richtigen) |
| Format | JSON, UTF-8, ein Objekt pro Nachricht, Feld `type` bestimmt die Art |

## 1. PC im WLAN finden

Das Handy schickt ein UDP-Paket an die Broadcast-Adresse (z. B. `192.168.178.255` und `255.255.255.255`), Port 8766:

```json
{ "type": "discover", "protocol": 1 }
```

Jeder GX-Tube-PC antwortet direkt an Absender-Adresse und -Port:

```json
{ "type": "device", "protocol": 1, "app": "GX Tube Desktop",
  "id": "5f0c…", "name": "Wohnzimmer-PC", "port": 8765, "version": "0.1.12" }
```

`id` bleibt pro Installation gleich (zum Wiedererkennen), `name` ist in den Einstellungen änderbar.
Wird nichts gefunden (manche Router blockieren Broadcasts), kann die App direkt per IP-Adresse verbinden.
`GET http://<PC>:8765/` liefert dieselbe Info als JSON.

## 2. Verbinden

WebSocket öffnen, als Erstes `hello` schicken – vorher werden keine Befehle angenommen:

```json
{ "type": "hello", "name": "Pixel 8", "deviceId": "a1b2…", "app": "GX Tube 0.1.40", "protocol": 1 }
```

Antwort des PCs: `welcome`, danach sofort die aktuelle Warteschlange (`queue`) und der Zustand (`state`).

```json
{ "type": "welcome", "protocol": 1, "id": "5f0c…", "name": "Wohnzimmer-PC", "version": "0.1.12", "app": "GX Tube Desktop" }
```

Der PC schickt alle 15 s einen WebSocket-Ping; die App kann zusätzlich `{"type":"ping"}` senden (Antwort `{"type":"pong"}`).

**Sicherheit:** Angenommen werden nur Verbindungen aus privaten Netzen (10.x, 172.16–31.x, 192.168.x,
100.64–127.x, Link-Local, IPv6 fc00::/7 und fe80::/10, localhost). Verbindungen mit `Origin`-Header
(also aus Webseiten im Browser) werden abgelehnt. Alle Werte werden geprüft und begrenzt.

## 3. Befehle (Handy → PC)

Ein **Video** besteht aus:

```json
{ "id": "dQw4w9WgXcQ", "title": "…", "channelName": "…", "thumbnail": "https://i.ytimg.com/…",
  "durationSec": 213, "isLive": false }
```

Nur `id` (11 Zeichen) ist Pflicht – fehlende Angaben holt sich der PC selbst. Optional ist
`channelId` (`UC…`, 24 Zeichen); der PC schickt sie in `queue`/`state` mit, sobald er sie kennt.
Unbekannte Felder müssen ignoriert werden.

**Twitch** (ab GX Tube Desktop mit Twitch-Umschalter): Statt der YouTube-ID steht in `id`

| `id` | |
|---|---|
| `twitch:<login>` | Live-Stream des Kanals (Login klein geschrieben, `a-z 0-9 _`, bis 25 Zeichen) |
| `twitch-vod:<zahl>` | Vergangener Stream / Video (VOD) |

```json
{ "id": "twitch:trymacs", "title": "…", "channelName": "Trymacs", "channelLogin": "trymacs",
  "thumbnail": "https://static-cdn.jtvnw.net/previews-ttv/live_user_trymacs-440x248.jpg", "isLive": true }
```

In `queue`/`state` kommt der PC mit `"platform": "twitch"` und `channelLogin` zurück. Live-Streams haben
`durationSec: -1` und `isLive: true`; ist der Kanal offline, meldet `state` `status: "error"` mit dem Grund.
Die Werbung entfernt der PC selbst – die App muss nichts weiter tun. YouTube- und Twitch-Einträge dürfen in
einer Warteschlange gemischt sein.

| `type` | Felder | Wirkung |
|---|---|---|
| `play` | `video`, `queue?` (Liste), `startMs?` | Sofort abspielen. Mit `queue` wird diese Liste zur Warteschlange (z. B. Playlist), sonst ersetzt das Video die Warteschlange. |
| `add` | `video`, `next?` (bool) | Hinten anhängen bzw. als Nächstes einreihen. Läuft nichts, startet es sofort. |
| `jump` | `index` | Video aus der Warteschlange abspielen |
| `remove` | `index` | Aus der Warteschlange entfernen |
| `clearQueue` | – | Alles außer dem laufenden Video entfernen |
| `next` / `previous` | – | Weiter / zurück (zurück springt nach 5 s erst an den Anfang, wie bei YouTube) |
| `pause` / `resume` / `toggle` | – | Wiedergabe |
| `seek` | `positionMs` | Springen |
| `seekBy` | `deltaMs` | ±Sekunden |
| `volume` | `value` (0–100) | Lautstärke am PC |
| `volumeBy` | `delta` | z. B. Lautstärketasten am Handy: ±5 |
| `mute` | `muted` | Stumm |
| `speed` | `value` (0,25–3) | Geschwindigkeit |
| `autoplay` | `enabled` | Autoplay an/aus |
| `fullscreen` | `on` (optional) | Vollbild am PC an/aus – ohne `on` umschalten. Beim Einschalten kommt das Video groß nach vorne |
| `display` | `id` | Fenster auf diesen Bildschirm verschieben (IDs aus `state.displays`), Vollbild bleibt erhalten |
| `twitchChat` | `on` (optional) | Twitch-Chat neben dem Live-Stream ein-/ausblenden – ohne `on` umschalten. Er startet ausgeblendet |
| `power` | `action`: `restart` / `shutdown` | PC **erzwungen** neu starten bzw. herunterfahren: offene Programme werden ohne Nachfrage geschlossen. Nur wenn am PC erlaubt (`state.power`) |
| `stop` | – | Wiedergabe beenden, Warteschlange leeren |

Fehlerhafte Befehle beantwortet der PC mit `{ "type": "error", "message": "…" }`. Hinweise, die die App
anzeigen soll (z. B. „Ausschalten am PC abgeschaltet“), kommen als `{ "type": "notice", "message": "…" }`.

**Ausschalten:** Bevor der PC neu startet oder herunterfährt, schickt er allen Handys
`{ "type": "power", "action": "restart" }` – danach bricht die Verbindung ab. Lehnt das System ab, kommt
stattdessen ein `notice` mit dem Grund. Nach einem Neustart ist GX Tube nur wieder erreichbar, wenn es mit dem
PC startet (`state.autostart`).

## 4. Meldungen (PC → Handy)

`state` – bei jeder Änderung und während der Wiedergabe etwa jede Sekunde:

```json
{ "type": "state",
  "video": { "id": "dQw4w9WgXcQ", "title": "…", "channelName": "…", "thumbnail": "…", "durationSec": 213, "isLive": false },
  "status": "playing",
  "positionMs": 61234, "durationMs": 213040, "bufferedMs": 90000,
  "volume": 80, "muted": false, "speed": 1, "isLive": false, "error": null,
  "segments": [ { "startMs": 10000, "endMs": 25000, "category": "sponsor", "label": "Sponsor", "uuid": "…" } ],
  "queueIndex": 0, "queueLength": 3, "hasNext": true, "hasPrevious": false, "autoplay": true,
  "fullscreen": false, "displayId": 1, "twitchChat": null, "power": true, "autostart": false,
  "displays": [ { "id": 1, "name": "DELL U2415", "primary": true, "width": 1920, "height": 1200 },
                { "id": 2, "name": "Bildschirm 2", "primary": false, "width": 3840, "height": 2160 } ] }
```

`twitchChat`: Chat neben dem Twitch-Live-Stream zu sehen (`null`: gerade kein Twitch-Live-Stream). `power`: Das Handy
darf den PC ausschalten (Einstellung am PC). `autostart`: GX Tube startet mit dem PC.

`status`: `idle` (nichts geladen), `loading`, `buffering`, `playing`, `paused`, `ended`, `error` (dann steht der Grund in `error`).
Zwischen zwei Meldungen kann die App die Position selbst weiterzählen (`positionMs + vergangene Zeit × speed`, solange `playing`).

`queue` – wenn sich die Warteschlange ändert:

```json
{ "type": "queue", "items": [ { "id": "…", "title": "…", "autoplay": false } ], "index": 0, "autoplay": true }
```

Von Autoplay angehängte Videos haben `"autoplay": true`.
