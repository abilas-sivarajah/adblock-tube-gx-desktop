// Videoplayer: Shaka Player für DASH (getrennte Video-/Tonspur) und HLS (Live),
// plus SponsorBlock und Zustandsmeldungen an den Hauptprozess (→ Handy).

/* global shaka */

const REPORT_EVERY_MS = 1000;
const SAVE_EVERY_MS = 10000;

export class Player {
  constructor(video, { onStatus, onSkip, onTracks } = {}) {
    this.video = video;
    this.onStatus = onStatus ?? (() => {});
    this.onSkip = onSkip ?? (() => {});
    this.onTracks = onTracks ?? (() => {});
    this.token = null;
    this.status = 'idle';
    this.segments = [];
    this.skipped = new Set();
    this.maxQuality = 1080;
    this.fixedHeight = 0; // 0 = automatisch
    this.isLive = false;
    this.lastReport = 0;
    this.lastSave = 0;
    this.loadSeq = 0;
    this.shaka = null;
  }

  async init({ volume = 100, speed = 1 } = {}) {
    shaka.polyfill.installAll();
    this.shaka = new shaka.Player();
    await this.shaka.attach(this.video);
    this.shaka.getNetworkingEngine().registerRequestFilter((type, request) => this.#filterRequest(request));
    this.shaka.addEventListener('error', (e) => this.#onShakaError(e.detail));
    this.shaka.addEventListener('adaptation', () => this.onTracks());
    this.shaka.addEventListener('variantchanged', () => this.onTracks());
    this.shaka.addEventListener('trackschanged', () => this.onTracks());
    this.shaka.addEventListener('buffering', (e) => {
      if (!this.token) return;
      if (e.buffering) this.#setStatus('buffering');
      else if (this.status !== 'loading') this.#setStatus(this.video.paused ? 'paused' : 'playing');
    });
    this.#configure();

    const v = this.video;
    v.volume = volume / 100;
    v.playbackRate = speed;
    v.addEventListener('playing', () => this.#setStatus('playing'));
    v.addEventListener('pause', () => {
      // Beim Laden/Umschalten feuert das Video ein "pause" – das ist keine Pause des Nutzers
      if (!v.ended && this.token && this.status !== 'loading') this.#setStatus('paused');
    });
    v.addEventListener('waiting', () => this.token && this.#setStatus('buffering'));
    v.addEventListener('ended', () => {
      if (!this.token) return;
      this.#setStatus('ended');
      window.gx.ended(this.token);
    });
    v.addEventListener('timeupdate', () => {
      this.#skipSponsors();
      const now = Date.now();
      if (now - this.lastReport >= REPORT_EVERY_MS) this.report();
    });
    v.addEventListener('volumechange', () => this.report(true));
    v.addEventListener('ratechange', () => this.report(true));
    v.addEventListener('seeked', () => this.report(true));
    v.addEventListener('durationchange', () => this.report(true));
  }

  #configure() {
    this.shaka.configure({
      streaming: {
        bufferingGoal: 60,
        rebufferingGoal: 1.5,
        bufferBehind: 30,
        retryParameters: { maxAttempts: 3, baseDelay: 400, backoffFactor: 2, timeout: 20000 },
      },
      manifest: { retryParameters: { maxAttempts: 2, baseDelay: 500, timeout: 20000 } },
      abr: {
        enabled: this.fixedHeight === 0,
        restrictions: { maxHeight: this.maxQuality || Infinity },
      },
    });
  }

  /** YouTube möchte den Bereich als URL-Parameter (&range=) statt als Header – so gibt es auch keine CORS-Vorabfrage. */
  #filterRequest(request) {
    const uri = request.uris[0] ?? '';
    if (!uri.includes('.googlevideo.com/')) return;
    const range = request.headers.Range ?? request.headers.range;
    if (!range) return;
    // Nur geschlossene Bereiche umschreiben; offene ("ab Byte N") bleiben als Header
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    if (!m) return;
    const url = new URL(uri);
    url.searchParams.set('range', `${m[1]}-${m[2]}`);
    request.uris[0] = url.toString();
    delete request.headers.Range;
    delete request.headers.range;
  }

  #setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
    this.report(true);
  }

  get positionMs() {
    return Math.round((this.video.currentTime || 0) * 1000);
  }

  get durationMs() {
    const d = this.video.duration;
    if (this.isLive || !Number.isFinite(d)) return 0;
    return Math.round(d * 1000);
  }

  get bufferedMs() {
    const b = this.video.buffered;
    const t = this.video.currentTime;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) >= t) return Math.round(b.end(i) * 1000);
    return 0;
  }

  report(force = false) {
    if (!this.token) return;
    const now = Date.now();
    if (!force && now - this.lastReport < REPORT_EVERY_MS / 2) return;
    this.lastReport = now;
    const save = now - this.lastSave > SAVE_EVERY_MS && this.status === 'playing';
    if (save) this.lastSave = now;
    window.gx.report({
      token: this.token,
      status: this.status,
      positionMs: this.positionMs,
      durationMs: this.durationMs,
      bufferedMs: this.bufferedMs,
      volume: Math.round(this.video.volume * 100),
      muted: this.video.muted,
      speed: this.video.playbackRate,
      save,
    });
  }

  /** Wird angezeigt, sobald der Hauptprozess ein Video lädt (Stream kommt gleich). */
  async prepare(token) {
    this.token = token;
    this.segments = [];
    this.skipped.clear();
    this.status = 'loading';
    this.onStatus('loading');
    const seq = ++this.loadSeq;
    await this.shaka.unload().catch(() => {});
    return seq === this.loadSeq;
  }

  async load({ token, stream, startMs, maxQuality }) {
    const seq = ++this.loadSeq;
    this.httpErrors = [];
    this.token = token;
    this.isLive = stream.kind === 'hls';
    this.fixedHeight = 0;
    this.maxQuality = maxQuality || 1080;
    this.#configure();
    const speed = this.video.playbackRate;
    try {
      if (stream.kind === 'dash') {
        const uri = 'data:application/dash+xml;base64,' + btoa(unescape(encodeURIComponent(stream.manifest)));
        await this.shaka.load(uri, startMs ? startMs / 1000 : null, 'application/dash+xml');
      } else {
        await this.shaka.load(stream.url, null, 'application/x-mpegurl');
      }
      if (seq !== this.loadSeq) return;
      this.video.playbackRate = this.isLive ? 1 : speed;
      await this.video.play().catch(() => {});
      this.onTracks();
    } catch (err) {
      if (seq !== this.loadSeq) return;
      // LOAD_INTERRUPTED (7000): ein neueres Video wird schon geladen
      if (err?.code === 7000) return;
      this.#onShakaError(err);
    }
  }

  async stop() {
    ++this.loadSeq;
    this.token = null;
    this.status = 'idle';
    this.onStatus('idle');
    await this.shaka.unload().catch(() => {});
  }

  #onShakaError(err) {
    if (!this.token) return;
    const code = err?.code;
    const http = code === 1001 || code === 1002 || code === 1003;
    const status = code === 1001 ? err?.data?.[1] : null;
    // Shaka meldet Ladefehler als "behebbar" und versucht es endlos weiter. Ein einzelner Aussetzer
    // ist egal – lehnt YouTube aber ab (403) oder scheitert es wiederholt, hilft nur ein anderer Client.
    if (err?.severity !== undefined && err.severity !== shaka.util.Error.Severity.CRITICAL) {
      if (!http) return;
      const now = Date.now();
      this.httpErrors = (this.httpErrors ?? []).filter((t) => now - t < 30_000);
      this.httpErrors.push(now);
      if (status !== 403 && status !== 410 && this.httpErrors.length < 3) {
        console.warn('Player-Hinweis', code, status ?? '');
        return;
      }
    }
    this.httpErrors = [];
    console.warn('Player-Fehler', code, status ?? '');
    const message = http
      ? 'YouTube hat den Stream abgelehnt.'
      : code === 3016 || code === 3014 || code === 3015
        ? 'Dieses Videoformat kann nicht abgespielt werden.'
        : `Wiedergabefehler (${code ?? 'unbekannt'})`;
    this.status = 'error';
    window.gx.failed({ token: this.token, positionMs: this.positionMs, message, http });
  }

  // ---------------------------------------------------------------- SponsorBlock

  setSegments(segments) {
    this.segments = Array.isArray(segments) ? segments : [];
  }

  #skipSponsors() {
    if (!this.segments.length || this.video.paused) return;
    const pos = this.positionMs;
    const seg = this.segments.find((s) => pos >= s.startMs && pos < s.endMs - 500 && !this.skipped.has(s.uuid));
    if (!seg) return;
    this.skipped.add(seg.uuid);
    this.video.currentTime = seg.endMs / 1000;
    this.onSkip(seg);
  }

  // ---------------------------------------------------------------- Bedienung

  togglePlay() {
    if (this.video.ended) {
      this.video.currentTime = 0;
      this.video.play().catch(() => {});
    } else if (this.video.paused) this.video.play().catch(() => {});
    else this.video.pause();
  }

  play() {
    this.video.play().catch(() => {});
  }

  pause() {
    this.video.pause();
  }

  seek(ms) {
    if (this.isLive) {
      const range = this.shaka.seekRange();
      this.video.currentTime = Math.min(Math.max(ms / 1000, range.start), range.end);
      return;
    }
    const d = this.video.duration;
    const t = Math.max(0, ms / 1000);
    this.video.currentTime = Number.isFinite(d) ? Math.min(t, Math.max(0, d - 0.25)) : t;
  }

  seekBy(deltaMs) {
    this.seek(this.positionMs + deltaMs);
  }

  setVolume(value) {
    this.video.volume = Math.min(100, Math.max(0, value)) / 100;
    if (value > 0) this.video.muted = false;
  }

  volumeBy(delta) {
    this.setVolume(Math.round(this.video.volume * 100) + delta);
  }

  setMuted(muted) {
    this.video.muted = muted;
  }

  setSpeed(value) {
    if (!this.isLive) this.video.playbackRate = value;
  }

  /** Verfügbare Auflösungen (absteigend). */
  qualities() {
    const heights = new Set((this.shaka?.getVariantTracks?.() ?? []).map((t) => t.height).filter(Boolean));
    return [...heights].sort((a, b) => b - a);
  }

  currentHeight() {
    return (this.shaka?.getVariantTracks?.() ?? []).find((t) => t.active)?.height ?? 0;
  }

  /** 0 = automatisch (bis zur Höchstqualität aus den Einstellungen). */
  setQuality(height) {
    this.fixedHeight = height;
    this.#configure();
    if (!height) return;
    const tracks = this.shaka.getVariantTracks().filter((t) => t.height === height).sort((a, b) => b.bandwidth - a.bandwidth);
    if (tracks[0]) this.shaka.selectVariantTrack(tracks[0], true);
    this.onTracks();
  }

  setMaxQuality(height) {
    this.maxQuality = height;
    this.#configure();
  }
}
