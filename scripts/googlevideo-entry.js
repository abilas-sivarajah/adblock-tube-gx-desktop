// Was das Fenster aus "googlevideo" braucht (SABR wie im YouTube-Webplayer) – wird von vendor.mjs gebündelt.
export { SabrStreamingAdapter, SabrUmpProcessor } from 'googlevideo/sabr-streaming-adapter';
export { createSegmentCacheKeyFromMetadata, getUniqueFormatId } from 'googlevideo/utils';
// YouTubes Metadaten in den Videostücken (emsg-Boxen): daran erkennt der Player serverseitig eingefügte Werbung.
// (Nicht über "googlevideo/utils" freigegeben – deshalb direkt aus dem Paket.)
export { parseEmsgSegmentMetadata } from '../node_modules/googlevideo/dist/src/utils/mediaSegmentUtils.js';
