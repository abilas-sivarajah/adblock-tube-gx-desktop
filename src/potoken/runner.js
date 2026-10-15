// Läuft im unsichtbaren Fenster (echtes Chromium): YouTubes BotGuard-Programm ausführen
// und damit PO-Tokens erzeugen. Netzwerkzugriffe macht der Hauptprozess.

import { BotGuardClient } from '../../node_modules/bgutils-js/dist/exports/botguard.js';
import { WebPoMinter } from '../../node_modules/bgutils-js/dist/exports/webpo.js';

let webPoSignalOutput = [];
let minter = null;

window.gxPot = {
  /** BotGuard-VM laden und eine Momentaufnahme erzeugen (geht an den Integritäts-Server). */
  async snapshot({ interpreterJs, program, globalName }) {
    minter = null;
    webPoSignalOutput = [];
    // Das Interpreter-Skript legt die VM unter window[globalName] ab
    new Function(interpreterJs)();
    const client = await BotGuardClient.create({ program, globalName, globalObject: window });
    return client.snapshot({ webPoSignalOutput }, 10000);
  },

  /** Mit dem Integritäts-Token den Minter bauen. */
  async setIntegrityToken(integrityToken) {
    minter = await WebPoMinter.create({ integrityToken }, webPoSignalOutput);
    return true;
  },

  /** PO-Token für eine Bindung (Visitor-ID oder Video-ID). */
  async mint(contentBinding) {
    if (!minter) throw new Error('Kein Minter');
    return minter.mintAsWebsafeString(contentBinding);
  },

  ready: () => Boolean(minter),
};
