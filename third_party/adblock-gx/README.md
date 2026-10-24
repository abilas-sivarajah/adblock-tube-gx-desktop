# Twitch-Werbeblocker aus Adblock GX

`twitch_worker.js` und `twitch_hold.ts` stammen unverändert aus
[adblock-browser-gx](https://github.com/abilas-sivarajah/adblock-browser-gx) (`scripts/`), Stand siehe
`SOURCE`. Techniken nach [TTV-AB](https://github.com/GosuDRM/TTV-AB) von GosuDRM (MIT-Lizenz).

`scripts/vendor.mjs` setzt daraus `src/renderer/vendor/twitch-adblock.js` zusammen (Einstellungen und
das schwarze Ersatz-Stück eingesetzt). Das Skript läuft im Fenster vor dem Shaka Player und hängt sich
in `fetch` ein: Twitch-Playlists mit Werbung bekommt der Player aus einer werbefreien Sitzung.

Zum Aktualisieren die beiden Dateien aus dem Browser-Repo neu kopieren und `SOURCE` anpassen.
