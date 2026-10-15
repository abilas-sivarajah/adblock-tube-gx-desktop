# 🖥️ GX Tube Desktop – YouTube ohne Werbung, gesteuert vom Handy

Desktop-App für Windows, Linux und macOS: ein werbefreier YouTube-Player, den du mit der
[GX Tube Android-App](https://github.com/abilas-sivarajah/adblock-tube-gx) fernsteuerst –
so wie die echte YouTube-App einen Fernseher oder die PlayStation steuert.
Am Handy suchen, tippen, auf dem PC läuft's. Pause, Vorspulen, Lautstärke, Warteschlange: alles vom Sofa.

Wie die Android-App holt GX Tube die Videos **direkt** (über [YouTube.js](https://github.com/LuanRT/YouTube.js)),
die Werbedaten von YouTube werden gar nicht erst geladen.

---

## 📥 Installieren

**[Releases → neueste Version](https://github.com/abilas-sivarajah/adblock-tube-gx-desktop/releases/latest)**

| System | Datei |
|---|---|
| **Windows** | `GXTube-Setup-….exe` (installiert und aktualisiert sich selbst) oder `GXTube-…-portable.exe` (ohne Installation) |
| **Linux** | `GXTube-…-x86_64.AppImage` (ausführbar machen, aktualisiert sich selbst) oder `GXTube-…-amd64.deb` |
| **macOS** | `GXTube-…-mac.dmg` |

- **Windows:** SmartScreen meldet „Unbekannter Herausgeber“ → *Weitere Informationen* → *Trotzdem ausführen*.
  Beim ersten Start fragt die **Windows-Firewall** → Zugriff für **private Netzwerke erlauben**, sonst findet das Handy den PC nicht.
- **macOS:** Die App ist nicht signiert → beim ersten Mal Rechtsklick → *Öffnen*.
- **Linux (Ubuntu 24.04+):** Startet das AppImage nicht, mit `--no-sandbox` starten.

Jeder Push auf `main` baut automatisch eine neue Version (GitHub Actions).

## 📱 Mit dem Handy verbinden

1. Handy und PC ins **selbe WLAN/Netz**.
2. GX Tube Desktop starten – es wartet im Hintergrund auf das Handy.
3. In der GX Tube Android-App oben auf das **Streamen-Symbol** tippen und den PC auswählen.
4. Video antippen → läuft auf dem PC. Auf dem Handy erscheint die Fernbedienung.

Findet die App den PC nicht (manche Router blockieren die Suche), in der App **„Per Adresse verbinden“**
wählen und die Adresse eingeben, die GX Tube Desktop auf der Startseite anzeigt (z. B. `192.168.178.23`).

## 🔑 Mit Google anmelden (optional)

Manchmal sperrt YouTube Anfragen ohne Anmeldung aus deinem Netz („Bestätige, dass du kein Bot bist“),
gibt nur niedrige Qualität frei oder ein Video ist altersbeschränkt. Dafür gibt es in den
**Einstellungen → Google-Konto** (und in der Fehlermeldung bzw. im Qualitäts-Menü) die Anmeldung:

- **Mit dem Handy anmelden** (wie YouTube auf dem Fernseher): Der PC zeigt einen Code. Auf dem Handy
  **google.com/device** öffnen, Code eingeben, Konto wählen, „Zulassen“ – fertig, am PC muss nichts getippt werden.
- **Hier im Fenster:** Googles normale Anmeldeseite direkt am PC.
- Dein Passwort geht nur an Google, nie an GX Tube. Die Anmeldung bleibt **nur auf diesem PC**
  (Tokens verschlüsselt über das Betriebssystem); „Abmelden“ löscht sie wieder und widerruft den Zugang.
- GX Tube lädt Videos weiter **ohne** Konto. Erst wenn YouTube ablehnt, geht es mit Konto weiter –
  und danach für eine halbe Stunde gleich mit Konto. Videos bleiben werbefrei.

## 🌟 Funktionen

| | |
|---|---|
| **Vom Handy steuern** | Abspielen, Pause, Springen, Weiter/Zurück, Lautstärke (auch mit den Lautstärketasten des Handys), Geschwindigkeit, Warteschlange („Als Nächstes“, „Zur Warteschlange hinzufügen“), mehrere Handys gleichzeitig |
| **Automatisch finden** | Der PC meldet sich im WLAN; kein Code, kein Konto nötig |
| **Keine Werbung** | Keine Videowerbung, keine Banner |
| **SponsorBlock** | Gesponserte Abschnitte werden übersprungen (grün auf dem Fortschrittsbalken), Kategorien einstellbar |
| **Auch ohne Handy** | Suche mit Vorschlägen, „Weiter ansehen“, Empfehlungen aus deinem Verlauf, Mini-Player beim Stöbern |
| **Player** | Bis 4K, Qualität und Geschwindigkeit wählbar, Live-Streams, Autoplay, Vollbild, Medientasten der Tastatur |
| **Im Hintergrund** | Fenster schließen legt GX Tube in den Infobereich – das Handy findet den PC trotzdem. Optional mit dem Computer starten. |
| **Updates** | Installierte Windows- und AppImage-Versionen aktualisieren sich selbst |
| **Google-Konto** | Optional, falls YouTube ohne Anmeldung sperrt (siehe oben) |

### ⌨️ Tastatur (im Player)

| Taste | |
|---|---|
| `Leertaste` / `K` | Abspielen / Pause |
| `←` `→` | ±5 Sekunden |
| `J` `L` | ±10 Sekunden |
| `↑` `↓` | Lautstärke |
| `M` | Stumm |
| `F` / Doppelklick | Vollbild |
| `Q` | Warteschlange |
| `Shift+N` / `Shift+P` | Nächstes / vorheriges Video |
| `0`–`9` | An 0 %–90 % springen |
| `Esc` | Vollbild verlassen / Mini-Player |
| `/` | Suchen |

## ⚠️ Grenzen

- Das Streamen geht nur im **lokalen Netz** (kein Streamen über das Internet wie mit dem YouTube-TV-Code).
- Die **offizielle** YouTube-App kann GX Tube Desktop nicht steuern – nur die GX Tube Android-App.
- YouTube ändert regelmäßig seine Schnittstellen. Lädt nichts mehr, hilft meist eine neuere Version von
  YouTube.js (`package.json` → `youtubei.js`) – GitHub baut dann automatisch eine neue Version.
- Wenn YouTube zu viele Anfragen aus deinem Netz sieht, verlangt es eine Bot-Bestätigung. Dann hilft
  **mit Google anmelden** oder warten. Unter der Fehlermeldung steht, was jeder YouTube-Client geantwortet hat.
- Lehnt Google die Anmeldung im Fenster ab („Browser nicht sicher“), meldet GX Tube das – dann mit dem Handy anmelden.
- Sperrt YouTube die höheren Qualitäten, fragt GX Tube noch einen weiteren Client und nimmt sonst die beste
  freigegebene Qualität (notfalls die 360p-Datei). Der Qualitäts-Knopf zeigt immer die echte Auflösung, das
  Qualitäts-Menü sagt dann „Höhere Qualität sperrt YouTube gerade“ – mit Google angemeldet geht es meist wieder in HD.

## 🛠️ Selbst bauen

Braucht Node.js 22:

```bash
git clone https://github.com/abilas-sivarajah/adblock-tube-gx-desktop
cd adblock-tube-gx-desktop
npm install
npm start               # App starten
npm test                # Unit-Tests
npm run smoke           # App starten und wie das Handy fernsteuern (Linux ohne Bildschirm: xvfb-run npm run smoke)
npm run test:account    # Code fürs Handy, Anmeldefenster und Laden mit Konto durchspielen (ohne echtes Konto)
npm run dist:win        # Windows-Installer → dist/  (auch dist:linux, dist:mac)

# Fehlersuche: Video wie vom Handy abspielen, abgelehnte Anfragen anzeigen
npm run debug:play -- <Video-ID> [Sekunden]
BLOCK_CLIENT=IOS npm run debug:play -- dQw4w9WgXcQ 60   # simuliert eine YouTube-Sperre → Wechsel auf den nächsten Client
```

## 🧩 Technik

| | |
|---|---|
| Programm | Electron, Oberfläche in reinem HTML/CSS/JS (ohne Framework) |
| YouTube-Daten | YouTube.js (InnerTube): Suche, Vorschläge, Details, ähnliche Videos. Streams über mehrere YouTube-Clients (Mobile Web, iOS, TV …): Vor dem Abspielen wird die gewählte Qualität mitten in der Datei geprüft; lehnt YouTube während der Wiedergabe ab, geht es an derselben Stelle mit dem nächsten Client weiter |
| PO-Token | Wie im Browser: YouTubes BotGuard läuft in einem unsichtbaren Fenster ([BgUtils](https://github.com/LuanRT/BgUtils)), damit bekommt Mobile Web gültige „Proof of Origin“-Tokens |
| Google-Konto | Per Code: OAuth-Geräteanmeldung von YouTube auf dem Fernseher (google.com/device), Tokens mit Electron `safeStorage` verschlüsselt, geladen wird über die TV-Clients. Im Fenster: eigenes Chromium-Profil (`persist:gx-google`), Anfragen mit Konto laufen über dieses Profil (erneuerte Cookies bleiben gespeichert), geladen über TV und Mobile Web (PO-Token an die DataSync-ID gebunden) |
| Player | Shaka Player: Video- und Tonspur getrennt als DASH, Live-Streams als HLS |
| Fernsteuerung | WebSocket (Port 8765) + UDP-Suche (Port 8766), siehe **[PROTOCOL.md](PROTOCOL.md)** |
| Werbung im Video | SponsorBlock-API (Abfrage über Hash-Präfix, die Video-ID bleibt privat) |

```
src/
├── main/                    # Hauptprozess (Node.js)
│   ├── main.js              # Fenster, Tray, Verbindung Handy ↔ Player
│   ├── cast-server.js       # Empfänger: WebSocket + UDP-Suche
│   ├── protocol.js          # Befehle prüfen, erlaubte Adressen
│   ├── session.js           # Warteschlange, Weiter/Zurück, Autoplay
│   ├── youtube.js           # alle YouTube-Abfragen
│   ├── potoken.js           # PO-Token (BotGuard im unsichtbaren Fenster)
│   ├── account.js           # optionale Google-Anmeldung
│   ├── sponsorblock.js
│   ├── store.js             # Einstellungen, Verlauf (JSON im Benutzerordner)
│   └── updater.js           # automatische Updates (GitHub-Releases)
├── preload/preload.cjs      # sichere Brücke zum Fenster
└── renderer/                # Fenster: Startseite, Suche, Player, Einstellungen
test/                        # Unit-Tests (node --test)
test-e2e/smoke.mjs           # startet die echte App und steuert sie wie das Handy
test-e2e/account-test.mjs    # Code fürs Handy, Anmeldefenster, Laden mit Konto, Abmelden
```

## 📄 Lizenz

GPL-3.0 (wie die Android-App). GX Tube ist ein privates Projekt und steht in keiner Verbindung zu YouTube oder Google.
