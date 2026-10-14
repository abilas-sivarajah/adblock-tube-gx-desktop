// Warteschlange und "Was läuft gerade" – gemeinsam für Handy und PC-Oberfläche.

import { EventEmitter } from 'node:events';
import { MAX_QUEUE } from './protocol.js';

/**
 * Ereignisse:
 *  - 'load'  ({ video, startMs, reason })  → Player soll dieses Video laden
 *  - 'stop'  ()                            → Wiedergabe beenden
 *  - 'queue' ({ items, index, autoplay })  → Warteschlange hat sich geändert
 */
export class Session extends EventEmitter {
  constructor({ autoplay = true, recentlyWatched = () => [] } = {}) {
    super();
    this.items = [];
    this.index = -1;
    this.autoplay = autoplay;
    this.related = { id: null, list: [] };
    this.recentlyWatched = recentlyWatched;
  }

  get current() {
    return this.items[this.index] ?? null;
  }

  get hasNext() {
    return this.index >= 0 && this.index < this.items.length - 1;
  }

  snapshot() {
    return { items: this.items, index: this.index, autoplay: this.autoplay };
  }

  #changed() {
    this.emit('queue', this.snapshot());
  }

  #load(startMs = null, reason = 'play') {
    const video = this.current;
    if (!video) return;
    this.emit('load', { video, startMs, reason });
  }

  /** Video sofort abspielen. Mit Warteschlange (z. B. Playlist) wird sie übernommen. */
  play(video, { queue = null, startMs = null } = {}) {
    const list = Array.isArray(queue) && queue.length ? queue.slice(0, MAX_QUEUE) : null;
    const at = list ? list.findIndex((v) => v.id === video.id) : -1;
    if (list && at >= 0) {
      this.items = list;
      this.index = at;
    } else {
      this.items = [video];
      this.index = 0;
    }
    this.#changed();
    this.#load(startMs, 'play');
  }

  /** Hinten anhängen oder als Nächstes einreihen. Läuft nichts, startet das Video. */
  add(video, { next = false } = {}) {
    if (!this.current) {
      this.play(video);
      return;
    }
    if (this.items.length >= MAX_QUEUE) return;
    if (next) this.items.splice(this.index + 1, 0, video);
    else this.items.push(video);
    this.#changed();
  }

  jump(index) {
    if (index < 0 || index >= this.items.length) return;
    this.index = index;
    this.#changed();
    this.#load(null, 'jump');
  }

  remove(index) {
    if (index < 0 || index >= this.items.length) return;
    if (index === this.index) {
      this.items.splice(index, 1);
      if (this.items.length === 0) {
        this.clear();
        return;
      }
      this.index = Math.min(index, this.items.length - 1);
      this.#changed();
      this.#load(null, 'jump');
      return;
    }
    this.items.splice(index, 1);
    if (index < this.index) this.index--;
    this.#changed();
  }

  /** Alles außer dem laufenden Video entfernen. */
  clearUpcoming() {
    const cur = this.current;
    this.items = cur ? [cur] : [];
    this.index = cur ? 0 : -1;
    this.#changed();
  }

  clear() {
    this.items = [];
    this.index = -1;
    this.#changed();
    this.emit('stop');
  }

  setAutoplay(enabled) {
    this.autoplay = enabled;
    this.#changed();
  }

  /** Ähnliche Videos des laufenden Videos – daraus kommt das nächste Video bei Autoplay. */
  setRelated(id, list) {
    this.related = { id, list: Array.isArray(list) ? list : [] };
  }

  nextRelated() {
    const cur = this.current;
    if (!cur || this.related.id !== cur.id) return null;
    const recent = new Set([...this.recentlyWatched(), ...this.items.map((v) => v.id)]);
    const ok = (v) => v && !v.isLive && !v.isShort && v.durationSec !== 0;
    return this.related.list.find((v) => ok(v) && !recent.has(v.id)) ?? this.related.list.find((v) => ok(v) && v.id !== cur.id) ?? null;
  }

  /** Weiter (Knopf): nächstes Video der Warteschlange, sonst ein ähnliches. */
  next() {
    if (this.hasNext) {
      this.index++;
      this.#changed();
      this.#load(null, 'next');
      return true;
    }
    const rel = this.nextRelated();
    if (!rel) return false;
    this.items.push({ ...rel, autoplay: true });
    this.index = this.items.length - 1;
    this.#changed();
    this.#load(null, 'next');
    return true;
  }

  /** Zurück: nach 5 Sekunden an den Anfang, sonst vorheriges Video. Gibt true zurück, wenn neu geladen wird. */
  previous(positionMs = 0) {
    if (positionMs > 5000 || this.index <= 0) return false;
    this.index--;
    this.#changed();
    this.#load(0, 'previous');
    return true;
  }

  /** Video ist zu Ende. */
  ended() {
    if (this.hasNext) return this.next();
    if (this.autoplay) return this.next();
    return false;
  }
}
