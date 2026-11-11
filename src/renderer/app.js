// Oberfläche von GX Tube Desktop: Startseite, Suche, Player, Warteschlange, Einstellungen.

import { Player } from './player.js';
import { hydrateIcons, icon, setIcon } from './icons.js';
import { count, duration, durationMs, el, qualityLabel, relativeTime, speedLabel } from './format.js';
import * as Twitch from './twitch-ui.js';
import { TwitchChat } from './twitch-chat.js';
import { chapterAt, createBrandingLoader, startFromUrl, storyboardFrame, textParts, videoIdFromUrl } from './yt-extras.js';

const gx = window.gx;
const $ = (id) => document.getElementById(id);

const state = {
  platform: 'youtube', // youtube | twitch (Umschalter oben links)
  view: 'home',
  watch: 'hidden', // hidden | full | mini
  token: null,
  video: null,
  details: null,
  segments: [],
  queue: { items: [], index: -1, autoplay: true },
  clients: [],
  info: null,
  settings: null,
  fullscreen: false,
  error: null,
  errorSignIn: false,
  account: { loggedIn: false },
  subs: [], // abonnierte Kanäle { id, name, thumbnail }
  channel: null, // offene Kanalseite { id, data, next, loading }
  prevView: 'home',
  search: { query: '', next: null, loading: false },
  searchFilters: { type: 'all', upload_date: 'all', duration: 'all', prioritize: 'relevance' },
  playlist: null, // offene Playlist { id, data, items, next, loading }
  sponsor: null, // SponsorBlock-Extras des Videos { highlight, full, chapters }
  comments: null, // { videoId, sort, items, next, count, loading, error }
  votes: null, // Return YouTube Dislike { videoId, likes, dislikes }
  captionTracks: [], // Untertitel des Videos (aus dem Stream)
};

const video = $('video');
const isTwitch = (v) => typeof v?.id === 'string' && v.id.startsWith('twitch');
const twitchLive = (v) => isTwitch(v) && v.id.startsWith('twitch:');
const player = new Player(video, {
  onStatus: (s) => renderStatus(s),
  onSkip: (seg) => {
    if (seg.ad) toast('Eingefügte Werbung übersprungen');
    else if (seg.muted) toast(`${seg.label}: stumm geschaltet`);
    else toast(`${seg.label} übersprungen`, { action: 'Rückgängig', run: () => player.undoSkip() });
  },
  onTracks: () => renderQualityButton(),
  onStalled: () => notifyAdBlock({ event: 'stalled' }),
});

// DeArrow: Titel/Vorschaubilder ohne Clickbait – Karten melden ihre Video-IDs, abgefragt wird gebündelt
const branding = createBrandingLoader((ids) => gx.branding(ids));

/** DeArrow auf eine Kachel anwenden (nur wenn eingeschaltet und es etwas gibt). */
function applyBranding(v, titleEl, img = null) {
  if (!state.settings?.dearrow || !v?.id || isTwitch(v)) return;
  branding.get(v.id, (b) => {
    if (b.title && titleEl) {
      titleEl.textContent = b.title;
      titleEl.title = `Original: ${v.title || ''}`;
    }
    if (b.thumbnail && img) {
      const original = img.src;
      img.addEventListener('error', () => {
        if (img.src !== original) img.src = original;
      }, { once: true });
      img.src = b.thumbnail;
    }
  });
}

/** Titel eines Videos – mit DeArrow, falls schon bekannt. */
const displayTitle = (v) => (state.settings?.dearrow && v?.id ? branding.peek(v.id)?.title : null) || v?.title || '';

// ------------------------------------------------------------------ Start

async function boot() {
  hydrateIcons();
  const [settings, info, session] = await Promise.all([gx.settings(), gx.info(), gx.session()]);
  state.settings = settings;
  state.platform = settings.platform === 'twitch' ? 'twitch' : 'youtube';
  state.info = info;
  state.clients = info.clients;
  state.queue = session;
  await Twitch.init({ state, toast, showView, setWatch, openMenu, closeMenu, cleanError, onTwitchAccount: () => onTwitchAccount() });
  await player.init({ volume: settings.volume, speed: settings.speed });
  $('volumeSlider').value = String(settings.volume);
  state.fullscreen = await gx.isFullscreen();

  bindTopbar();
  bindWatch();
  bindKeys();
  bindEvents();
  bindChat();
  bindAdBlock();
  notifyAdBlock({ event: 'spoofing', enabled: settings.twitchAdSpoofing !== false });

  renderCastButton();
  renderPlatform();
  if (state.platform === 'twitch') showView('home');
  else renderHome();
  renderVolume();
  state.update = await gx.updateStatus();
  renderUpdate();
  state.account = await gx.accountStatus();
  state.subs = await gx.subscriptions();
  $('btnSignIn').addEventListener('click', () => signIn());
  $('btnSignInWindow').addEventListener('click', () => windowSignIn());
  $('signInDialog').addEventListener('click', (e) => {
    if (e.target === $('signInDialog')) closeSignInDialog();
  });
  $('btnUpdate').addEventListener('click', () => gx.installUpdate());
  renderSpeedButton();
  renderFullscreenButton();
  $('autoplayToggle').checked = session.autoplay;

  // Läuft schon etwas (z. B. Fenster neu geladen)?
  if (session.current) {
    onLoading({ token: session.current.token, video: session.current.video });
    if (session.current.stream) onSource({ token: session.current.token, video: session.current.video, stream: session.current.stream, startMs: session.current.startMs, maxQuality: settings.maxQuality });
    if (session.current.segments) onSegments({ token: session.current.token, segments: session.current.segments });
  }
}

function bindEvents() {
  gx.onLoading(onLoading);
  gx.onSource(onSource);
  gx.onError(({ token, message, details, signIn, signInWindow, twitchSignIn, offline, channelLogin }) => {
    if (token !== state.token) return;
    state.error = message;
    state.errorDetails = Array.isArray(details) ? details : [];
    state.errorSignIn = Boolean(signIn);
    state.errorSignInWindow = Boolean(signInWindow);
    state.errorTwitch = { signIn: Boolean(twitchSignIn), channel: offline && channelLogin ? channelLogin : null };
    renderStatus('error');
  });
  gx.onVideo(({ token, video: v }) => {
    if (token !== state.token) return;
    state.video = v;
    renderTitle();
  });
  gx.onDetails(({ token, details }) => {
    if (token !== state.token) return;
    state.details = details;
    renderRelated();
    renderTitle();
    renderChapters();
    loadVotes();
    renderInfo();
  });
  gx.onSegments(onSegments);
  gx.onStop(() => {
    state.token = null;
    state.video = null;
    state.details = null;
    player.stop();
    stopChat();
    hideAdOverlay();
    setWatch('hidden');
    if (state.view === 'home') renderHome();
  });
  gx.onCommand(onCommand);
  gx.onQueue((q) => {
    state.queue = q;
    $('autoplayToggle').checked = q.autoplay;
    renderQueue();
  });
  gx.onClients((list) => {
    state.clients = list;
    renderCastButton();
    renderHero();
    renderCastChip();
    if (!$('castPopover').hidden) renderCastPopover();
  });
  gx.onInfo((info) => {
    state.info = info;
    renderHero();
  });
  gx.onSettings((s) => {
    state.settings = s;
    notifyAdBlock({ event: 'spoofing', enabled: s.twitchAdSpoofing !== false });
    if (state.view === 'settings') renderSettings();
  });
  gx.onToast(toast);
  gx.onFullscreen((on) => {
    state.fullscreen = on;
    renderFullscreenButton();
  });
  gx.onShowWatch(() => setWatch('full'));
  gx.onUpdateStatus((u) => {
    state.update = u;
    renderUpdate();
  });
  gx.onAccount((a) => {
    state.account = a;
    renderAccount();
  });
  gx.onDeviceLogin(onDeviceLogin);
  gx.onSubs((list) => {
    state.subs = list;
    renderSubButtons();
    if (state.view === 'home') renderSubsShelf();
  });
}

function onLoading({ token, video: v }) {
  state.token = token;
  state.video = v;
  state.details = null;
  state.error = null;
  state.errorDetails = [];
  state.errorSignIn = false;
  state.errorSignInWindow = false;
  state.stream = null;
  state.segments = [];
  state.errorTwitch = null;
  state.ads = 0;
  state.sponsor = null;
  state.comments = null;
  state.votes = null;
  state.captionTracks = [];
  player.prepare(token);
  if (state.watch === 'hidden') setWatch('full');
  $('coverImg').src = v.thumbnail || (isTwitch(v) ? '' : `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`);
  hideAdOverlay();
  renderTwitchControls();
  if (twitchLive(v)) startChat(v.channelLogin || v.id.slice(7));
  else stopChat();
  renderTitle();
  renderSegments();
  renderChapters();
  renderCaptionsButton();
  renderQueue();
  renderRelated();
  renderInfo();
  renderStatus('loading');
  updateMediaSession();
}

let lastDegradedHint = 0;

function onSource({ token, stream, startMs, maxQuality }) {
  if (token !== state.token) return;
  state.stream = stream;
  if (stream?.kind === 'twitch') {
    notifyAdBlock({ event: 'viewer', headers: stream.viewer ?? {}, vod: !stream.isLive });
    notifyAdBlock({ event: 'spoofing', enabled: state.settings?.twitchAdSpoofing !== false });
  }
  state.captionTracks = stream?.kind === 'twitch' || stream?.isLive ? [] : (stream?.captions ?? []).map((t, i) => ({ ...t, key: `${t.lang}:${t.auto ? 'auto' : 'manuell'}:${i}` }));
  player.load({ token, stream, startMs, maxQuality }).then(() => autoCaptions(token));
  renderQualityButton();
  renderCaptionsButton();
  renderChapters();
  // YouTube sperrt gerade die höheren Qualitäten – Bescheid sagen (nicht bei jedem Video)
  if (stream?.degraded && Date.now() - lastDegradedHint > 10 * 60 * 1000) {
    lastDegradedHint = Date.now();
    toast(`YouTube gibt gerade nur ${qualityLabel(stream.maxHeight)} frei` + (stream.signIn && !state.account?.loggedIn ? ' – mit Google anmelden hilft meist (Qualität-Menü)' : ''));
  }
}

function onSegments({ token, segments, highlight = null, full = null, chapters = [] }) {
  if (token !== state.token) return;
  state.segments = segments ?? [];
  state.sponsor = { highlight, full, chapters: Array.isArray(chapters) ? chapters : [] };
  player.setSegments(state.segments);
  renderSegments();
  renderChapters();
  renderInfo();
}

/** Befehle vom Handy (oder Tray) an den Player. */
function onCommand(cmd) {
  switch (cmd.type) {
    case 'pause': player.pause(); break;
    case 'resume': player.play(); break;
    case 'toggle': player.togglePlay(); flash(video.paused ? 'pause' : 'play'); break;
    case 'seek': player.seek(cmd.positionMs); break;
    case 'seekBy': player.seekBy(cmd.deltaMs); break;
    case 'volume': player.setVolume(cmd.value); showVolumeHint(); break;
    case 'volumeBy': player.volumeBy(cmd.delta); showVolumeHint(); break;
    case 'mute': player.setMuted(cmd.muted); break;
    case 'speed': player.setSpeed(cmd.value); break;
    case 'twitchChat': toggleChat(cmd.on ?? undefined); break;
    default: break;
  }
  showControls();
}

// ------------------------------------------------------------------ Kopfzeile, Suche

function bindTopbar() {
  $('btnHome').addEventListener('click', () => showView('home'));
  for (const b of $('platformSwitch').querySelectorAll('button')) b.addEventListener('click', () => setPlatform(b.dataset.platform));
  $('btnSettings').addEventListener('click', () => showView('settings'));
  $('btnCast').addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('castPopover');
    pop.hidden = !pop.hidden;
    if (!pop.hidden) renderCastPopover();
  });
  document.addEventListener('click', (e) => {
    if (!$('castPopover').contains(e.target)) $('castPopover').hidden = true;
    if (!$('searchForm').contains(e.target)) $('suggestions').hidden = true;
    if (!$('menu').contains(e.target)) closeMenu();
  });

  const input = $('searchInput');
  let suggestTimer = null;
  let suggestSeq = 0;
  let active = -1;
  let recent = []; // Suchverlauf, beim Fokussieren aufgefrischt
  input.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    active = -1;
    const q = input.value;
    const seq = ++suggestSeq;
    suggestTimer = setTimeout(async () => {
      let entries = [];
      if (q.trim() && state.platform === 'twitch') {
        // Wie auf twitch.tv: passende frühere Suchen, dann Kanäle, Kategorien und Suchbegriffe
        const needle = q.trim().toLowerCase();
        const mine = recent.filter((h) => h.toLowerCase().includes(needle)).slice(0, 3);
        const remote = await Twitch.suggestions(q).catch(() => []);
        entries = [...textEntries(mine, true), ...remote.filter((s) => s.run || !mine.some((h) => h.toLowerCase() === s.q.toLowerCase()))];
      } else if (q.trim()) {
        entries = textEntries(await gx.suggestions(q));
      }
      // Inzwischen gesucht oder weitergetippt? Dann nicht mehr anzeigen.
      if (seq !== suggestSeq || input.value !== q || document.activeElement !== input) return;
      showSuggestions(entries);
    }, 150);
  });
  input.addEventListener('focus', async () => {
    const lib = await gx.library();
    recent = lib.searchHistory;
    if (!input.value.trim() && document.activeElement === input) showSuggestions(textEntries(recent.slice(0, 10), true));
  });
  input.addEventListener('keydown', (e) => {
    const items = [...$('suggestions').querySelectorAll('li')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length || $('suggestions').hidden) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.classList.toggle('active', i === active));
      input.value = items[active].dataset.q;
    } else if (e.key === 'Escape') {
      $('suggestions').hidden = true;
      input.blur();
    }
  });
  $('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    clearTimeout(suggestTimer);
    suggestSeq++;
    // Mit den Pfeiltasten einen Kanal oder eine Kategorie gewählt? Dann direkt dorthin.
    const picked = $('suggestions').hidden || active < 0 ? null : $('suggestions').querySelectorAll('li')[active];
    const run = picked && suggestionActions.get(picked);
    $('suggestions').hidden = true;
    input.blur();
    if (run) run();
    else runSearch(q);
  });
  $('view-search').addEventListener('scroll', (e) => {
    const v = e.currentTarget;
    if (v.scrollTop + v.clientHeight > v.scrollHeight - 800) loadMoreSearch();
  });
  $('view-channel').addEventListener('scroll', (e) => {
    const v = e.currentTarget;
    if (v.scrollTop + v.clientHeight > v.scrollHeight - 800) loadMoreChannel();
  });
  $('view-playlist').addEventListener('scroll', (e) => {
    const v = e.currentTarget;
    if (v.scrollTop + v.clientHeight > v.scrollHeight - 800) loadMorePlaylist();
  });
}

/** Einfache Vorschläge (Text, Suchverlauf) für showSuggestions(). */
function textEntries(list, history = false) {
  return list.map((q) => ({ q, content: [icon(history ? 'history' : 'search'), el('span', 'sug-text', q)] }));
}

// Vorschlag → eigene Aktion (Twitch: Kanal oder Kategorie öffnen); ohne Eintrag wird gesucht
const suggestionActions = new WeakMap();

/** Liste unter dem Suchfeld. entries: { q, content: Node[], run? } – [q] landet beim Durchblättern im Feld. */
function showSuggestions(entries) {
  const ul = $('suggestions');
  ul.replaceChildren();
  for (const s of entries) {
    const li = el('li');
    li.dataset.q = s.q;
    li.append(...s.content);
    if (s.run) suggestionActions.set(li, s.run);
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      ul.hidden = true;
      if (s.run) {
        $('searchInput').blur();
        s.run();
        return;
      }
      $('searchInput').value = s.q;
      runSearch(s.q);
    });
    ul.append(li);
  }
  ul.hidden = entries.length === 0;
}

// Suchfilter wie auf youtube.com (der erste Wert ist jeweils "egal")
const SEARCH_FILTER_OPTIONS = {
  type: [['all', 'Alles'], ['video', 'Videos'], ['channel', 'Kanäle'], ['playlist', 'Playlists']],
  upload_date: [['all', 'Jederzeit'], ['today', 'Heute'], ['week', 'Diese Woche'], ['month', 'Diesen Monat'], ['year', 'Dieses Jahr']],
  duration: [['all', 'Jede Länge'], ['under_three_mins', 'Unter 3 Minuten'], ['three_to_twenty_mins', '3–20 Minuten'], ['over_twenty_mins', 'Über 20 Minuten']],
  prioritize: [['relevance', 'Nach Relevanz'], ['popularity', 'Nach Beliebtheit']],
};

function renderSearchFilters() {
  const box = $('searchFilters');
  const f = state.searchFilters;
  const chips = el('div', 'tw-chips search-type');
  for (const [value, label] of SEARCH_FILTER_OPTIONS.type) {
    const b = el('button', 'tw-chip' + (f.type === value ? ' active' : ''), label);
    b.addEventListener('click', () => setSearchFilter('type', value));
    chips.append(b);
  }
  const selects = ['upload_date', 'duration', 'prioritize'].map((key) => {
    const sel = el('select', 'search-select' + (f[key] !== SEARCH_FILTER_OPTIONS[key][0][0] ? ' active' : ''));
    sel.title = { upload_date: 'Upload-Datum', duration: 'Länge', prioritize: 'Sortierung' }[key];
    for (const [value, label] of SEARCH_FILTER_OPTIONS[key]) {
      const o = el('option', null, label);
      o.value = value;
      o.selected = f[key] === value;
      sel.append(o);
    }
    sel.addEventListener('change', () => setSearchFilter(key, sel.value));
    return sel;
  });
  box.replaceChildren(chips, ...selects);
}

function setSearchFilter(key, value) {
  state.searchFilters = { ...state.searchFilters, [key]: value };
  if (state.search.query) runSearch(state.search.query);
  else renderSearchFilters();
}

async function runSearch(q) {
  if (state.platform === 'twitch') return Twitch.search(q);
  if (state.watch === 'full') setWatch('mini');
  showView('search');
  state.search = { query: q, next: null, loading: true };
  renderSearchFilters();
  const grid = $('searchGrid');
  grid.replaceChildren();
  $('searchStatus').textContent = 'Suche läuft …';
  $('view-search').scrollTop = 0;
  const filters = state.searchFilters;
  try {
    const res = await gx.search(q, filters);
    if (state.searchFilters !== filters) return;
    if (state.search.query !== q) return;
    appendResults(res.items);
    state.search.next = res.next;
    $('searchStatus').textContent = res.items.length ? '' : 'Keine Ergebnisse';
  } catch (err) {
    $('searchStatus').textContent = 'Suche fehlgeschlagen: ' + cleanError(err);
  } finally {
    state.search.loading = false;
  }
}

async function loadMoreSearch() {
  const s = state.search;
  if (s.loading || !s.next) return;
  s.loading = true;
  const q = s.query;
  try {
    const res = await gx.searchMore(s.next);
    if (state.search.query !== q) return;
    appendResults(res.items);
    s.next = res.next;
  } catch {
    s.next = null;
  } finally {
    s.loading = false;
  }
}

function appendResults(items) {
  const grid = $('searchGrid');
  for (const item of items) {
    if (item.kind === 'channel') grid.append(channelCard(item));
    else if (item.kind === 'playlist') grid.append(playlistCard(item));
    else if (item.kind === 'video' && !item.isShort) grid.append(videoCard(item));
  }
}

function cleanError(err) {
  return String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ------------------------------------------------------------------ Seiten

function showView(name) {
  // "Startseite" ist die von YouTube oder Twitch – je nach Umschalter
  if (name === 'home' && state.platform === 'twitch') name = 'twhome';
  state.view = name;
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === 'view-' + name);
  if (name === 'home') renderHome();
  // Twitch-Seiten füllt twitch-ui.js (und markiert oben "Startseite | Folge ich | Durchsuchen")
  if (name.startsWith('tw')) Twitch.onShow(name);
  if (name === 'settings') renderSettings();
  if (state.watch === 'full') setWatch('mini');
}

/** YouTube ↔ Twitch: Startseite und Suche wechseln mit. */
async function setPlatform(platform) {
  if (platform !== 'youtube' && platform !== 'twitch') return;
  if (state.platform !== platform) {
    state.platform = platform;
    state.settings = await gx.setSettings({ platform });
    renderPlatform();
  }
  closeMenu();
  showView('home');
}

function renderPlatform() {
  const tw = state.platform === 'twitch';
  document.body.classList.toggle('platform-twitch', tw);
  for (const b of $('platformSwitch').querySelectorAll('button')) {
    const on = b.dataset.platform === state.platform;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
  $('searchInput').placeholder = tw ? 'Auf Twitch suchen (Kanäle, Kategorien)' : 'Suchen';
  // Seitenleiste und Reiter wie auf twitch.tv
  Twitch.onPlatform(tw);
  $('btnHome').title = tw ? 'Twitch-Startseite' : 'Startseite';
}

async function renderHome() {
  renderHero();
  renderSubsShelf();
  const lib = await gx.library();
  lib.history = lib.history.filter((h) => !isTwitch(h.video));
  const cont = lib.history.filter((h) => h.durationMs > 0 && h.positionMs > 5000 && h.positionMs < h.durationMs - 15000).slice(0, 20);
  $('shelfContinue').hidden = cont.length === 0;
  $('continueRow').replaceChildren(...cont.map((h) => videoCard(h.video, { progress: h.positionMs / h.durationMs, historyId: h.video.id })));
  const recent = lib.history.slice(0, 40);
  const reco = lib.recommendations.slice(0, 40);
  $('shelfReco').hidden = reco.length === 0 && recent.length === 0;
  $('shelfReco').querySelector('h2').textContent = reco.length ? 'Empfohlen' : 'Verlauf';
  $('recoGrid').replaceChildren(...(reco.length ? reco : recent.map((h) => h.video)).map((v) => videoCard(v)));
  renderExplore();
}

// "Entdecken": Trends wie in der Android-App (Gaming) und Live-Streams
const EXPLORE_KINDS = [['gaming', 'Gaming-Trends'], ['live', 'Live']];
let exploreKind = 'gaming';
let exploreSeq = 0;

async function renderExplore() {
  const seq = ++exploreSeq;
  $('exploreChips').replaceChildren(
    ...EXPLORE_KINDS.map(([kind, label]) => {
      const b = el('button', 'tw-chip' + (kind === exploreKind ? ' active' : ''), label);
      b.addEventListener('click', () => {
        exploreKind = kind;
        renderExplore();
      });
      return b;
    }),
  );
  try {
    const videos = await gx.explore(exploreKind);
    if (seq !== exploreSeq) return;
    $('exploreGrid').replaceChildren(...videos.slice(0, 16).map((v) => videoCard(v)));
    $('shelfExplore').hidden = videos.length === 0;
  } catch {
    if (seq === exploreSeq && !$('exploreGrid').childElementCount) $('shelfExplore').hidden = true;
  }
}

// ------------------------------------------------------------------ Kanäle und Abos

const isSubscribed = (id) => state.subs.some((s) => s.id === id);
let channelSeq = 0;

/** Kanalseite öffnen (Kopf mit Abonnieren, darunter die Videos). */
async function openChannel(id, name = '') {
  if (!id) return;
  closeMenu();
  if (state.view !== 'channel') state.prevView = state.view;
  showView('channel');
  const seq = ++channelSeq;
  state.channel = { id, data: { id, name }, next: null, loading: true };
  renderChannelHead();
  $('channelGrid').replaceChildren();
  $('channelStatus').textContent = 'Lädt …';
  $('view-channel').scrollTop = 0;
  try {
    const data = await gx.channel(id);
    if (seq !== channelSeq) return;
    state.channel.data = data;
    state.channel.next = data.next;
    renderChannelHead();
    $('channelGrid').append(...data.items.filter((v) => !v.isShort).map((v) => videoCard(v)));
    $('channelStatus').textContent = data.items.length ? '' : 'Keine Videos';
  } catch (err) {
    if (seq === channelSeq) $('channelStatus').textContent = 'Kanal konnte nicht geladen werden: ' + cleanError(err);
  } finally {
    if (seq === channelSeq) state.channel.loading = false;
  }
}

async function loadMoreChannel() {
  const c = state.channel;
  if (!c || c.loading || !c.next) return;
  c.loading = true;
  const seq = channelSeq;
  try {
    const res = await gx.channelMore(c.next);
    if (seq !== channelSeq) return;
    $('channelGrid').append(...res.items.filter((v) => !v.isShort).map((v) => videoCard(v)));
    c.next = res.next;
  } catch {
    c.next = null;
  } finally {
    c.loading = false;
  }
}

function renderChannelHead() {
  const d = state.channel?.data;
  const head = $('channelHead');
  if (!d) return head.replaceChildren();
  const parts = [];
  if (d.banner) {
    const banner = el('img', 'channel-banner');
    banner.src = d.banner;
    banner.alt = '';
    parts.push(banner);
  }
  head.classList.toggle('no-banner', !d.banner);
  const back = el('button', 'icon-btn channel-back');
  back.title = 'Zurück';
  back.append(icon('back'));
  back.addEventListener('click', () => showView(state.prevView === 'channel' ? 'home' : state.prevView || 'home'));
  const info = el('div', 'channel-info');
  const avatar = el('img', 'channel-avatar');
  if (d.avatar) avatar.src = d.avatar;
  avatar.alt = '';
  const text = el('div', 'channel-text');
  text.append(el('h1', null, d.name || 'Kanal'));
  const meta = [d.handle, d.subscribersText, d.videosText].filter(Boolean).join(' • ');
  if (meta) text.append(el('div', 'channel-meta', meta));
  if (d.description) text.append(el('p', 'channel-desc', d.description));
  info.append(avatar, text, subscribeButton({ id: d.id, name: d.name, thumbnail: d.avatar }));
  head.replaceChildren(...parts, back, info);
}

/** Abonnieren-Knopf; bleibt über data-sub aktuell, wenn sich die Abos ändern. */
function subscribeButton(c) {
  const btn = el('button');
  btn.dataset.sub = c.id;
  fillSubscribeButton(btn);
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const on = !isSubscribed(c.id);
    btn.disabled = true;
    try {
      const r = await gx.setSubscribed({ id: c.id, name: c.name || '', thumbnail: c.thumbnail || null }, on);
      const loggedIn = state.account?.loggedIn;
      if (on) toast(r.synced ? `${c.name || 'Kanal'} abonniert` : loggedIn ? `Abonniert – nur auf diesem PC (YouTube: ${r.error})` : `${c.name || 'Kanal'} abonniert (auf diesem PC). Mit Google angemeldet landet es auch bei YouTube.`);
      else toast(r.synced || !loggedIn ? 'Abo beendet' : `Abo auf diesem PC beendet (YouTube: ${r.error})`);
    } catch (err) {
      toast('Abonnieren fehlgeschlagen: ' + cleanError(err));
    } finally {
      btn.disabled = false;
      fillSubscribeButton(btn);
    }
  });
  return btn;
}

function fillSubscribeButton(btn) {
  const on = isSubscribed(btn.dataset.sub);
  btn.className = on ? 'pill ghost sub-btn' : 'pill sub-btn';
  btn.textContent = on ? 'Abonniert' : 'Abonnieren';
  btn.title = on ? 'Abo beenden' : 'Kanal abonnieren';
}

function renderSubButtons() {
  for (const btn of document.querySelectorAll('[data-sub]')) fillSubscribeButton(btn);
}

let subsFeedAt = 0;
let subsFeedFor = ''; // für welche Abos der Feed geladen wurde

/** Startseite: "Neu von deinen Abos" mit den Kanälen und ihren neuesten Videos. */
async function renderSubsShelf() {
  const shelf = $('shelfSubs');
  shelf.hidden = state.subs.length === 0;
  if (!state.subs.length) return;
  $('subChips').replaceChildren(
    ...state.subs.slice(0, 30).map((s) => {
      const chip = el('div', 'sub-chip');
      chip.title = s.name;
      const img = el('img');
      img.loading = 'lazy';
      if (s.thumbnail) img.src = s.thumbnail;
      img.alt = '';
      chip.append(img, el('span', null, s.name || 'Kanal'));
      chip.addEventListener('click', () => openChannel(s.id, s.name));
      return chip;
    }),
  );
  const grid = $('subsGrid');
  // Nicht bei jedem Wechsel auf die Startseite neu laden – außer die Abos haben sich geändert
  const subsKey = state.subs.map((s) => s.id).sort().join(',');
  if (grid.childElementCount && Date.now() - subsFeedAt < 5 * 60 * 1000 && subsKey === subsFeedFor) return;
  if (!grid.childElementCount) $('subsHint').textContent = 'Lädt …';
  try {
    const videos = await gx.subscriptionFeed();
    subsFeedAt = Date.now();
    subsFeedFor = subsKey;
    grid.replaceChildren(...videos.slice(0, 12).map((v) => videoCard(v)));
    $('subsHint').textContent = videos.length ? '' : 'Noch keine neuen Videos';
  } catch {
    $('subsHint').textContent = 'Konnte nicht geladen werden';
  }
}

function renderHero() {
  const hero = $('castHero');
  const info = state.info;
  if (!info) return;
  hero.replaceChildren();
  const art = el('div', 'cast-art');
  art.append(icon(state.clients.length ? 'castConnected' : 'cast'));
  const text = el('div');
  if (state.clients.length) {
    text.append(el('h1', null, 'Verbunden mit GX Tube'), el('p', null, 'Wähle auf dem Handy ein Video aus – es wird hier abgespielt. Steuern kannst du es auf dem Handy oder hier am PC.'));
    const devices = el('div', 'devices');
    for (const c of state.clients) {
      const chip = el('span', 'chip');
      chip.append(icon('phone'), el('span', null, c.name));
      devices.append(chip);
    }
    text.append(devices);
  } else {
    text.append(el('h1', null, `„${info.name}“ ist bereit`), el('p', null, 'Streame Videos von deinem Handy auf diesen PC – wie „Auf dem Fernseher abspielen“ in der YouTube-App.'));
    const ol = el('ol');
    ol.append(
      el('li', null, 'Handy ins selbe WLAN wie diesen PC bringen.'),
      el('li', null, 'GX Tube auf dem Handy öffnen und oben auf das Streamen-Symbol tippen.'),
      el('li', null, `„${info.name}“ auswählen.`),
    );
    text.append(ol);
    if (info.addresses.length && info.port) {
      const p = el('p', null, 'Wird der PC nicht gefunden? In der App „Per Adresse verbinden“ und eingeben: ');
      p.append(el('span', 'addr', `${info.addresses[0]}${info.port === 8765 ? '' : ':' + info.port}`));
      text.append(p);
    }
    if (!info.port) text.append(el('p', null, '⚠️ Der Empfänger konnte nicht starten (Port belegt?). Starte GX Tube neu.'));
  }
  hero.append(art, text);
}

function renderCastButton() {
  const btn = $('btnCast');
  setIcon(btn, state.clients.length ? 'castConnected' : 'cast');
  btn.classList.toggle('connected', state.clients.length > 0);
  $('castBadge').hidden = state.clients.length < 2;
  $('castBadge').textContent = String(state.clients.length);
}

function renderCastPopover() {
  const pop = $('castPopover');
  const info = state.info;
  pop.replaceChildren(el('h3', null, info?.name ?? 'GX Tube'));
  if (info?.addresses?.length) {
    const p = el('p', null, 'Adresse: ');
    p.append(el('span', 'addr', info.addresses[0] + (info.port && info.port !== 8765 ? ':' + info.port : '')));
    pop.append(p);
  }
  if (!state.clients.length) {
    pop.append(el('p', null, 'Noch kein Handy verbunden. Öffne GX Tube auf dem Handy und tippe auf das Streamen-Symbol.'));
    pop.append(el('p', null, 'Falls Windows nachfragt: Zugriff für private Netzwerke erlauben.'));
    return;
  }
  for (const c of state.clients) {
    const row = el('div', 'device');
    row.append(icon('phone'), el('span', 'name', c.name));
    const kick = el('button', 'pill small ghost', 'Trennen');
    kick.addEventListener('click', () => gx.kick(c.id));
    row.append(kick);
    pop.append(row);
  }
}

// ------------------------------------------------------------------ Karten

function videoCard(v, { progress = null, historyId = null, queue = null } = {}) {
  const card = el('div', 'card');
  const thumb = el('div', 'thumb');
  const img = el('img');
  img.loading = 'lazy';
  img.src = v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`;
  img.alt = '';
  thumb.append(img);
  if (v.isLive) thumb.append(el('span', 'duration live', 'LIVE'));
  else if (v.durationSec > 0) thumb.append(el('span', 'duration', duration(v.durationSec)));
  if (progress != null) {
    const bar = el('div', 'progress');
    const fill = el('div');
    fill.style.width = Math.min(100, Math.max(0, progress * 100)) + '%';
    bar.append(fill);
    thumb.append(bar);
  }
  const body = el('div', 'card-body');
  const text = el('div', 'card-text');
  const title = el('div', 'card-title', v.title || 'Video');
  text.append(title);
  applyBranding(v, title, img);
  // Kanalname führt zur Kanalseite
  const meta = el('div', 'card-meta');
  if (v.channelName) {
    const ch = el('span', v.channelId ? 'card-channel' : null, v.channelName);
    if (v.channelId) {
      ch.title = 'Zum Kanal';
      ch.addEventListener('click', (e) => {
        e.stopPropagation();
        openChannel(v.channelId, v.channelName);
      });
    }
    meta.append(ch);
  }
  const rest = [v.viewsText, v.publishedText || (v.publishedAt ? relativeTime(v.publishedAt) : '')].filter(Boolean).join(' • ');
  if (rest) meta.append(document.createTextNode((v.channelName ? ' • ' : '') + rest));
  if (meta.childNodes.length) text.append(meta);
  const more = el('button', 'icon-btn card-menu');
  more.title = 'Mehr';
  more.append(icon('more'));
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    const items = [
      { icon: 'playNext', label: 'Als Nächstes abspielen', run: () => gx.add(toRef(v), true) },
      { icon: 'addQueue', label: 'Zur Warteschlange hinzufügen', run: () => gx.add(toRef(v), false) },
      { icon: 'open', label: 'Auf youtube.com öffnen', run: () => gx.openExternal(`https://www.youtube.com/watch?v=${v.id}`) },
    ];
    if (v.channelId) items.splice(2, 0, { icon: 'account', label: `Zum Kanal${v.channelName ? ` „${v.channelName}“` : ''}`, run: () => openChannel(v.channelId, v.channelName) });
    if (historyId) items.push({ icon: 'delete', label: 'Aus dem Verlauf entfernen', run: async () => { await gx.removeHistory(historyId); renderHome(); } });
    openMenu(more, items);
  });
  body.append(text, more);
  card.append(thumb, body);
  card.addEventListener('click', () => {
    // In einer Playlist: die Playlist ab hier als Warteschlange
    const list = queue ? queue() : null;
    gx.play(toRef(v), list ? list.map(toRef) : null);
    setWatch('full');
  });
  return card;
}

/** Kachel einer Playlist (Suche): öffnet die Playlist-Seite. */
function playlistCard(p) {
  const card = el('div', 'card playlist');
  const thumb = el('div', 'thumb');
  const img = el('img');
  img.loading = 'lazy';
  if (p.thumbnail) img.src = p.thumbnail;
  img.alt = '';
  thumb.append(img);
  const badge = el('span', 'duration playlist-badge');
  badge.append(icon('playlistPlay'), el('span', null, p.countText || 'Playlist'));
  thumb.append(badge);
  const body = el('div', 'card-body');
  const text = el('div', 'card-text');
  text.append(el('div', 'card-title', p.title || 'Playlist'));
  const meta = el('div', 'card-meta');
  if (p.channelName) {
    const ch = el('span', p.channelId ? 'card-channel' : null, p.channelName);
    if (p.channelId) {
      ch.title = 'Zum Kanal';
      ch.addEventListener('click', (e) => {
        e.stopPropagation();
        openChannel(p.channelId, p.channelName);
      });
    }
    meta.append(ch, document.createTextNode(' • '));
  }
  meta.append(document.createTextNode('Playlist'));
  text.append(meta);
  const more = el('button', 'icon-btn card-menu');
  more.title = 'Mehr';
  more.append(icon('more'));
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(more, [
      { icon: 'playlistPlay', label: 'Playlist öffnen', run: () => openPlaylist(p.id, p.title) },
      { icon: 'open', label: 'Auf youtube.com öffnen', run: () => gx.openExternal(`https://www.youtube.com/playlist?list=${p.id}`) },
    ]);
  });
  body.append(text, more);
  card.append(thumb, body);
  card.addEventListener('click', () => openPlaylist(p.id, p.title));
  return card;
}

// ------------------------------------------------------------------ Playlists

let playlistSeq = 0;

async function openPlaylist(id, title = '') {
  if (!id) return;
  closeMenu();
  if (state.view !== 'playlist') state.prevView = state.view;
  showView('playlist');
  const seq = ++playlistSeq;
  state.playlist = { id, data: { id, title }, items: [], next: null, loading: true };
  renderPlaylistHead();
  $('playlistGrid').replaceChildren();
  $('playlistStatus').textContent = 'Lädt …';
  $('view-playlist').scrollTop = 0;
  try {
    const data = await gx.playlist(id);
    if (seq !== playlistSeq) return;
    state.playlist.data = data;
    state.playlist.items = data.items;
    state.playlist.next = data.next;
    renderPlaylistHead();
    $('playlistGrid').append(...data.items.map((v) => videoCard(v, { queue: () => state.playlist?.items ?? null })));
    $('playlistStatus').textContent = data.items.length ? '' : 'Diese Playlist ist leer';
  } catch (err) {
    if (seq === playlistSeq) $('playlistStatus').textContent = 'Playlist konnte nicht geladen werden: ' + cleanError(err);
  } finally {
    if (seq === playlistSeq) state.playlist.loading = false;
  }
}

async function loadMorePlaylist() {
  const pl = state.playlist;
  if (!pl || pl.loading || !pl.next) return;
  pl.loading = true;
  const seq = playlistSeq;
  try {
    const res = await gx.playlistMore(pl.next);
    if (seq !== playlistSeq) return;
    const known = new Set(pl.items.map((v) => v.id));
    const fresh = res.items.filter((v) => !known.has(v.id));
    pl.items = [...pl.items, ...fresh];
    pl.next = res.next;
    $('playlistGrid').append(...fresh.map((v) => videoCard(v, { queue: () => state.playlist?.items ?? null })));
  } catch {
    pl.next = null;
  } finally {
    pl.loading = false;
  }
}

/** Ganze Playlist abspielen (der Reihe nach oder gemischt). */
function playPlaylist(shuffle = false) {
  const items = [...(state.playlist?.items ?? [])];
  if (!items.length) return;
  if (shuffle) {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
  }
  gx.play(toRef(items[0]), items.map(toRef));
  setWatch('full');
}

function renderPlaylistHead() {
  const d = state.playlist?.data;
  const head = $('playlistHead');
  if (!d) return head.replaceChildren();
  const back = el('button', 'icon-btn channel-back');
  back.title = 'Zurück';
  back.append(icon('back'));
  back.addEventListener('click', () => showView(state.prevView === 'playlist' ? 'home' : state.prevView || 'home'));
  const art = el('div', 'playlist-art');
  if (d.thumbnail) {
    const img = el('img');
    img.src = d.thumbnail;
    img.alt = '';
    art.append(img);
  }
  const text = el('div', 'channel-text');
  text.append(el('h1', null, d.title || 'Playlist'));
  const meta = el('div', 'channel-meta');
  if (d.channelName) {
    const ch = el('span', d.channelId ? 'card-channel' : null, d.channelName);
    if (d.channelId) ch.addEventListener('click', () => openChannel(d.channelId, d.channelName));
    meta.append(ch);
  }
  const rest = [d.countText, d.viewsText, d.updatedText].filter(Boolean).join(' • ');
  if (rest) meta.append(document.createTextNode((d.channelName ? ' • ' : '') + rest));
  text.append(meta);
  if (d.description) text.append(el('p', 'channel-desc', d.description));
  const actions = el('div', 'playlist-actions');
  const all = el('button', 'pill');
  all.append(icon('play'), el('span', null, 'Alle abspielen'));
  all.addEventListener('click', () => playPlaylist(false));
  const mix = el('button', 'pill ghost');
  mix.append(icon('shuffle'), el('span', null, 'Zufällig'));
  mix.addEventListener('click', () => playPlaylist(true));
  actions.append(all, mix);
  text.append(actions);
  const info = el('div', 'channel-info');
  info.append(art, text);
  head.replaceChildren(back, info);
}

function channelCard(c) {
  const card = el('div', 'card channel');
  const img = el('img');
  img.src = c.thumbnail || '';
  img.alt = '';
  const text = el('div', 'card-text');
  text.append(el('div', 'card-title', c.name), el('div', 'card-meta', c.subscribersText || 'Kanal'));
  card.append(img, text, subscribeButton({ id: c.id, name: c.name, thumbnail: c.thumbnail }));
  card.addEventListener('click', () => openChannel(c.id, c.name));
  return card;
}

function toRef(v) {
  return { id: v.id, title: v.title ?? '', channelName: v.channelName ?? '', channelId: v.channelId ?? null, thumbnail: v.thumbnail ?? null, durationSec: v.durationSec ?? -1, isLive: Boolean(v.isLive) };
}

function openMenu(anchor, items, { title = null, above = false } = {}) {
  const menu = $('menu');
  menu.replaceChildren();
  if (title) menu.append(el('div', 'menu-title', title));
  for (const item of items) {
    if (item.note) {
      menu.append(el('div', item.small ? 'menu-note small' : 'menu-note', item.note));
      continue;
    }
    const b = el('button');
    if (item.icon) b.append(icon(item.icon));
    else b.append(el('span', 'check', item.checked ? '✓' : ''));
    b.append(el('span', null, item.label));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      item.run();
    });
    menu.append(b);
  }
  // Menü sitzt im Player-Container, wenn der Knopf dort ist – sonst im Dokument
  const host = anchor.closest('.stage') ?? document.body;
  if (menu.parentElement !== host) host.append(menu);
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  let left = Math.min(r.right - m.width, window.innerWidth - m.width - 8);
  left = Math.max(8, left);
  let top = above ? r.top - m.height - 8 : r.bottom + 4;
  if (top + m.height > window.innerHeight - 8) top = r.top - m.height - 4;
  menu.style.left = left + 'px';
  menu.style.top = Math.max(8, top) + 'px';
}

function closeMenu() {
  $('menu').hidden = true;
}

// ------------------------------------------------------------------ Player-Ansicht

function setWatch(mode) {
  if (mode !== 'hidden' && !state.video) mode = 'hidden';
  state.watch = mode;
  document.body.classList.toggle('watching', mode === 'full');
  const w = $('watch');
  w.classList.toggle('hidden', mode === 'hidden');
  w.classList.toggle('full', mode === 'full');
  w.classList.toggle('mini', mode === 'mini');
  if (mode !== 'full' && state.fullscreen) gx.setFullscreen(false);
  if (mode === 'full') {
    w.focus();
    showControls();
  }
  closeMenu();
}

let hideTimer = null;
function showControls() {
  const c = $('controls');
  c.classList.add('show');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!video.paused && !$('seek').classList.contains('dragging') && $('menu').hidden) c.classList.remove('show');
  }, 3000);
}

function bindWatch() {
  const stage = document.querySelector('.stage');
  stage.addEventListener('mousemove', () => state.watch === 'full' && showControls());
  stage.addEventListener('click', (e) => {
    if (state.watch === 'mini') {
      if (!e.target.closest('button')) setWatch('full');
      return;
    }
    if (e.target === video || e.target.classList.contains('controls') || e.target.classList.contains('ctl-top') || e.target.classList.contains('ctl-bottom')) {
      player.togglePlay();
      flash(video.paused ? 'pause' : 'play');
    }
  });
  stage.addEventListener('dblclick', (e) => {
    if (state.watch === 'full' && !e.target.closest('button, .seek')) gx.setFullscreen(!state.fullscreen);
  });

  $('btnPlay').addEventListener('click', () => player.togglePlay());
  $('miniPlay').addEventListener('click', () => player.togglePlay());
  $('btnNext').addEventListener('click', () => gx.next());
  $('miniNext').addEventListener('click', () => gx.next());
  $('btnPrev').addEventListener('click', () => gx.previous(player.positionMs));
  $('miniPrev').addEventListener('click', () => gx.previous(player.positionMs));
  $('btnBack').addEventListener('click', () => setWatch('mini'));
  // Kanalname im Player: Video läuft im Mini-Player weiter, die Kanalseite geht auf
  $('vChannel').addEventListener('click', (e) => {
    const id = currentChannelId();
    if (!id || state.watch !== 'full') return;
    e.stopPropagation();
    if (state.fullscreen) gx.setFullscreen(false);
    if (isTwitch(state.video)) Twitch.openChannel(id, state.video?.channelName);
    else openChannel(id, state.video?.channelName);
  });
  $('miniExpand').addEventListener('click', () => setWatch('full'));
  $('miniClose').addEventListener('click', () => gx.stop());
  $('btnFull').addEventListener('click', () => gx.setFullscreen(!state.fullscreen));
  $('btnRetry').addEventListener('click', () => gx.retry());
  $('btnTwitchSignIn').addEventListener('click', () => Twitch.openLoginDialog());
  $('btnTwitchChannel').addEventListener('click', () => {
    const login = state.errorTwitch?.channel;
    if (!login) return;
    if (state.fullscreen) gx.setFullscreen(false);
    Twitch.openChannel(login, state.video?.channelName);
  });
  $('btnChat').addEventListener('click', () => toggleChat());
  $('btnChatClose').addEventListener('click', () => toggleChat(false));
  $('btnQueue').addEventListener('click', () => toggleQueue());
  $('btnQueueClose').addEventListener('click', () => toggleQueue(false));
  $('btnInfo').addEventListener('click', () => toggleInfo());
  $('btnInfoClose').addEventListener('click', () => toggleInfo(false));
  $('btnCaptions').addEventListener('click', (e) => {
    e.stopPropagation();
    openCaptionsMenu();
  });
  $('chapterLabel').addEventListener('click', () => toggleInfo(true, 'chapters'));
  // Kommentare nachladen, sobald man in der Info-Leiste nach unten scrollt
  $('infoBody').addEventListener('scroll', (e) => {
    const b = e.currentTarget;
    if (b.scrollTop + b.clientHeight > b.scrollHeight - 600) loadMoreComments();
  });
  $('seekHighlight').addEventListener('click', (e) => {
    e.stopPropagation();
    const h = state.sponsor?.highlight;
    if (h) player.seekToHighlight(h.startMs);
  });
  $('btnQueueClear').addEventListener('click', () => gx.clearUpcoming());
  $('autoplayToggle').addEventListener('change', (e) => gx.setSettings({ autoplay: e.target.checked }));

  $('btnMute').addEventListener('click', () => player.setMuted(!video.muted));
  $('volumeSlider').addEventListener('input', (e) => player.setVolume(Number(e.target.value)));
  video.addEventListener('volumechange', renderVolume);
  video.addEventListener('ratechange', renderSpeedButton);
  video.addEventListener('resize', renderQualityButton);

  $('btnSpeed').addEventListener('click', (e) => {
    e.stopPropagation();
    const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];
    openMenu($('btnSpeed'), speeds.map((s) => ({ label: speedLabel(s), checked: video.playbackRate === s, run: () => player.setSpeed(s) })), { title: 'Wiedergabegeschwindigkeit', above: true });
  });
  $('btnQuality').addEventListener('click', (e) => {
    e.stopPropagation();
    if (isTwitch(state.video)) return openTwitchQualityMenu();
    const heights = player.qualities();
    const items = [{ label: `Automatisch (bis ${qualityLabel(state.settings.maxQuality)})`, checked: player.fixedHeight === 0, run: () => player.setQuality(0) }];
    for (const h of heights) items.push({ label: qualityLabel(h), checked: player.fixedHeight === h, run: () => player.setQuality(h) });
    const s = state.stream;
    if (s?.degraded) {
      // Höhere Qualität hat YouTube gerade gesperrt – nicht so tun, als gäbe es sie
      items.push({ note: `Höhere Qualität sperrt YouTube gerade${s.kind === 'progressive' ? ` – läuft als ${qualityLabel(s.maxHeight)}-Datei` : ''}.` });
      if (!state.account?.loggedIn) items.push({ label: 'Mit Google anmelden für bessere Qualität', icon: 'account', run: () => signIn() });
    }
    if (s?.client) {
      // Über welchen Weg das Video kam und was die anderen geliefert haben – hilft bei der Fehlersuche
      const way = `Geladen über ${s.client}${s.kind === 'sabr' ? '' : s.kind === 'progressive' ? ' (Datei)' : ''}${state.video?.id ? ` · ${state.video.id}` : ''}`;
      items.push({ note: [way, ...(s.attempts ?? []).filter((a) => !a.startsWith(s.client + ':'))].join('\n'), small: true });
    }
    openMenu($('btnQuality'), items, { title: 'Qualität', above: true });
  });

  bindSeek();
  setInterval(renderTime, 250);
}

function bindSeek() {
  const seek = $('seek');
  const tip = $('seekTooltip');
  const fraction = (e) => {
    const r = seek.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  const total = () => player.durationMs;
  let dragging = false;
  seek.addEventListener('mousemove', (e) => {
    if (!total()) return;
    showSeekTip(fraction(e));
  });
  seek.addEventListener('mouseleave', () => {
    if (!dragging) tip.hidden = true;
  });
  seek.addEventListener('mousedown', (e) => {
    if (!total()) return;
    e.preventDefault();
    dragging = true;
    seek.classList.add('dragging');
    const move = (ev) => {
      const f = fraction(ev);
      $('seekPlayed').style.width = f * 100 + '%';
      $('seekThumb').style.left = f * 100 + '%';
      showSeekTip(f);
    };
    const up = (ev) => {
      dragging = false;
      seek.classList.remove('dragging');
      tip.hidden = true;
      player.seek(fraction(ev) * total());
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    move(e);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

/** Tooltip über der Zeitleiste: Vorschaubild (YouTube-Storyboard), Kapitel und Zeit. */
function showSeekTip(f) {
  const tip = $('seekTooltip');
  const total = player.durationMs;
  if (!total) return;
  const ms = f * total;
  tip.hidden = false;
  $('seekTime').textContent = durationMs(ms);
  const chapters = currentChapters();
  const ci = chapterAt(chapters, ms);
  $('seekChapter').hidden = ci < 0;
  if (ci >= 0) $('seekChapter').textContent = chapters[ci].title;
  const frame = isTwitch(state.video) ? null : storyboardFrame(state.stream?.storyboard, ms, total);
  const preview = $('seekPreview');
  preview.hidden = !frame;
  if (frame) {
    preview.style.width = frame.width + 'px';
    preview.style.height = frame.height + 'px';
    preview.style.backgroundImage = `url(${JSON.stringify(frame.url)})`;
    preview.style.backgroundPosition = `-${frame.x}px -${frame.y}px`;
  }
  // Am Rand nicht abschneiden
  const width = $('seek').getBoundingClientRect().width;
  const half = (tip.offsetWidth || 0) / 2;
  tip.style.left = Math.min(Math.max(f * width, half), Math.max(half, width - half)) + 'px';
}

let lastChapterIndex = -2;

function renderTime() {
  const label = $('timeLabel');
  if (!state.video) return;
  // Aktuelles Kapitel neben der Zeit (wie auf youtube.com)
  const chapters = player.isLive ? [] : currentChapters();
  const ci = chapterAt(chapters, player.positionMs);
  if (ci !== lastChapterIndex) {
    lastChapterIndex = ci;
    $('chapterLabel').hidden = ci < 0;
    if (ci >= 0) $('chapterLabel').textContent = `· ${chapters[ci].title} ›`;
    for (const li of document.querySelectorAll('#infoBody .chapter')) li.classList.toggle('current', Number(li.dataset.index) === ci);
  }
  if (player.isLive) {
    const since = isTwitch(state.video) ? state.details?.twitch?.startedAt : null;
    label.replaceChildren(el('span', 'live', 'LIVE'));
    if (since) label.append(document.createTextNode(` · ${duration((Date.now() - since) / 1000)}`));
  } else {
    const d = player.durationMs || Math.max(0, (state.video.durationSec ?? 0) * 1000);
    label.textContent = d ? `${durationMs(player.positionMs)} / ${durationMs(d)}` : durationMs(player.positionMs);
  }
  const d = player.durationMs;
  const played = d ? (player.positionMs / d) * 100 : 0;
  const buffered = d ? (player.bufferedMs / d) * 100 : 0;
  $('seek').hidden = player.isLive || !d;
  if (!$('seek').classList.contains('dragging')) {
    $('seekPlayed').style.width = played + '%';
    $('seekThumb').style.left = played + '%';
  }
  $('seekBuffered').style.width = buffered + '%';
  $('miniProgress').style.width = played + '%';
}

function renderStatus(status) {
  const playing = status === 'playing' || status === 'buffering';
  const ended = status === 'ended';
  for (const id of ['btnPlay', 'miniPlay']) setIcon($(id), ended ? 'replay' : playing && !video.paused ? 'pause' : 'play');
  $('btnPlay').title = playing ? 'Pause (k)' : 'Abspielen (k)';
  const cover = $('cover');
  cover.classList.toggle('show', status === 'loading');
  cover.classList.toggle('loading', status === 'loading');
  document.querySelector('.stage').classList.toggle('buffering', status === 'buffering');
  $('errorBox').hidden = status !== 'error';
  $('errorText').textContent = state.error ?? 'Wiedergabefehler';
  const reasons = status === 'error' ? state.errorDetails ?? [] : [];
  $('errorReasons').hidden = reasons.length === 0;
  $('errorReasons').replaceChildren(...reasons.map((r) => el('li', null, r)));
  renderSignInButton(status);
  $('btnTwitchSignIn').hidden = !(status === 'error' && state.errorTwitch?.signIn && !Twitch.account().loggedIn);
  $('btnTwitchChannel').hidden = !(status === 'error' && state.errorTwitch?.channel);
  $('btnRetry').textContent = state.errorTwitch?.channel ? 'Nochmal prüfen' : 'Erneut versuchen';
  if (status === 'paused' || status === 'ended' || status === 'error') $('controls').classList.add('show');
  else showControls();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : status === 'paused' ? 'paused' : 'none';
}

const currentChannelId = () =>
  isTwitch(state.video)
    ? state.video.channelLogin || state.details?.twitch?.channelLogin || null
    : state.video?.channelId || (state.details?.id === state.video?.id ? state.details?.channelId : null) || null;

function renderTitle() {
  const v = state.video;
  $('vTitle').textContent = displayTitle(v);
  $('vTitle').title = displayTitle(v) !== (v?.title || '') ? `Original: ${v?.title || ''}` : '';
  if (v && state.settings?.dearrow && !isTwitch(v) && !branding.peek(v.id)) {
    // DeArrow-Titel nachladen; kommt einer, den Titel neu zeichnen
    branding.get(v.id, () => {
      if (state.video?.id === v.id) {
        renderTitle();
        renderInfo();
      }
    });
  }
  const t = isTwitch(v) ? state.details?.twitch : null;
  $('vChannel').textContent = t ? [v.channelName || t.channelName, t.game?.displayName, t.isLive && t.viewers ? `${count(t.viewers)} Zuschauer` : null].filter(Boolean).join(' · ') : v?.channelName || '';
  $('vChannel').classList.toggle('link', Boolean(currentChannelId()));
  $('vChannel').title = currentChannelId() ? 'Zum Kanal' : '';
  document.title = v?.title ? `${v.title} – GX Tube` : 'GX Tube';
  renderCastChip();
  updateMediaSession();
}

function renderCastChip() {
  const chip = $('castChip');
  chip.hidden = state.clients.length === 0;
  chip.replaceChildren(icon('castConnected'), el('span', null, state.clients.map((c) => c.name).join(', ')));
}

function renderSegments() {
  const box = $('seekSegments');
  box.replaceChildren();
  const d = player.durationMs || (state.video?.durationSec ?? 0) * 1000;
  const highlight = state.sponsor?.highlight;
  $('seekHighlight').hidden = !(d && highlight);
  if (d && highlight) {
    $('seekHighlight').style.left = (highlight.startMs / d) * 100 + '%';
  }
  if (!d) return;
  for (const s of state.segments) {
    const div = el('div', s.action === 'mute' ? 'mute' : null);
    div.style.left = (s.startMs / d) * 100 + '%';
    div.style.width = Math.max(0.2, ((s.endMs - s.startMs) / d) * 100) + '%';
    div.title = s.action === 'mute' ? `${s.label} (stumm)` : s.label;
    box.append(div);
  }
}
video.addEventListener('durationchange', () => {
  renderSegments();
  renderChapters();
});

/** Kapitel des Videos: von YouTube (Kanal oder automatisch), sonst aus SponsorBlock. */
function currentChapters() {
  if (!state.video || isTwitch(state.video)) return [];
  const d = state.details?.id === state.video.id ? state.details : null;
  if (d?.chapters?.length) return d.chapters;
  return state.sponsor?.chapters ?? [];
}

/** Trennstriche zwischen den Kapiteln auf der Zeitleiste. */
function renderChapters() {
  const box = $('seekChapters');
  box.replaceChildren();
  lastChapterIndex = -2;
  const d = player.durationMs || (state.video?.durationSec ?? 0) * 1000;
  if (!d) return;
  for (const c of currentChapters()) {
    if (c.startMs <= 0 || c.startMs >= d) continue;
    const gap = el('div');
    gap.style.left = (c.startMs / d) * 100 + '%';
    box.append(gap);
  }
}

function renderVolume() {
  const v = video.muted ? 0 : Math.round(video.volume * 100);
  setIcon($('btnMute'), v === 0 ? 'volumeOff' : v < 50 ? 'volumeLow' : 'volume');
  if (document.activeElement !== $('volumeSlider')) $('volumeSlider').value = String(v);
}

function renderSpeedButton() {
  $('btnSpeed').textContent = video.playbackRate === 1 ? '1×' : String(video.playbackRate).replace('.', ',') + '×';
}

function renderQualityButton() {
  // Was wirklich zu sehen ist: Beim Hochschalten läuft erst noch der Puffer in der alten Qualität,
  // und die Datei mit Ton hat gar keine Spurauswahl
  const h = video.videoHeight || player.currentHeight() || 0;
  $('btnQuality').textContent = h ? qualityLabel(h) : 'HD';
  $('btnQuality').hidden = player.isLive && !h;
}

function renderFullscreenButton() {
  setIcon($('btnFull'), state.fullscreen ? 'fullscreenExit' : 'fullscreen');
}

let flashTimer = null;
function flash(name) {
  const f = $('centerFlash');
  f.replaceChildren(icon(name));
  f.classList.remove('show');
  void f.offsetWidth;
  f.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => f.classList.remove('show'), 700);
}

let volumeToast = null;
function showVolumeHint() {
  clearTimeout(volumeToast);
  volumeToast = setTimeout(() => toast(`Lautstärke: ${video.muted ? 'stumm' : Math.round(video.volume * 100) + ' %'}`), 150);
}

function toggleQueue(force) {
  const panel = $('queuePanel');
  panel.hidden = force === undefined ? !panel.hidden : !force;
  if (!panel.hidden) {
    $('chatPanel').hidden = true;
    $('infoPanel').hidden = true;
    renderQueue();
    renderRelated();
  }
}

function renderQueue() {
  const { items, index } = state.queue;
  $('queueSub').textContent = items.length ? `${index + 1} / ${items.length}` : 'Leer';
  $('btnQueueClear').hidden = items.length <= 1;
  if ($('queuePanel').hidden) return;
  const ol = $('queueList');
  ol.replaceChildren();
  items.forEach((v, i) => {
    const li = el('li', 'q-item' + (i === index ? ' current' : ''));
    const img = el('img');
    img.src = v.thumbnail || (isTwitch(v) ? '' : `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`);
    img.alt = '';
    img.loading = 'lazy';
    const text = el('div', 'q-text');
    text.append(el('div', 'q-title', v.title || 'Video'), el('div', 'q-meta', [v.channelName, v.durationSec > 0 ? duration(v.durationSec) : '', v.autoplay ? 'Autoplay' : ''].filter(Boolean).join(' • ')));
    const rm = el('button', 'icon-btn q-remove');
    rm.title = 'Entfernen';
    rm.append(icon('close'));
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      gx.remove(i);
    });
    li.append(el('span', 'q-num', i === index ? '▶' : String(i + 1)), img, text, rm);
    li.addEventListener('click', () => gx.jump(i));
    ol.append(li);
  });
  ol.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
}

function renderRelated() {
  const box = $('relatedBox');
  const list = state.details?.related ?? [];
  box.hidden = list.length === 0;
  if ($('queuePanel').hidden || !list.length) return;
  const wrap = $('relatedList');
  wrap.replaceChildren();
  for (const v of list.filter((x) => !x.isShort).slice(0, 15)) {
    const row = el('div', 'q-item');
    const img = el('img');
    img.src = v.thumbnail;
    img.alt = '';
    img.loading = 'lazy';
    const text = el('div', 'q-text');
    const title = el('div', 'q-title', v.title);
    text.append(title, el('div', 'q-meta', [v.channelName, v.durationSec > 0 ? duration(v.durationSec) : ''].filter(Boolean).join(' • ')));
    applyBranding(v, title, img);
    const add = el('button', 'icon-btn q-remove');
    add.title = 'Zur Warteschlange hinzufügen';
    add.append(icon('addQueue'));
    add.addEventListener('click', (e) => {
      e.stopPropagation();
      gx.add(toRef(v), false);
    });
    row.append(el('span', 'q-num', ''), img, text, add);
    row.addEventListener('click', () => gx.play(toRef(v), null));
    wrap.append(row);
  }
}

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const v = state.video;
  if (!v) {
    navigator.mediaSession.metadata = null;
    return;
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: v.title || 'GX Tube',
    artist: v.channelName || '',
    artwork: v.thumbnail || !isTwitch(v) ? [{ src: v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`, sizes: '480x360' }] : [],
  });
}

function bindMediaKeys() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => player.play());
  ms.setActionHandler('pause', () => player.pause());
  ms.setActionHandler('nexttrack', () => gx.next());
  ms.setActionHandler('previoustrack', () => gx.previous(player.positionMs));
  ms.setActionHandler('seekto', (d) => player.seek(d.seekTime * 1000));
}

// ------------------------------------------------------------------ Untertitel

/** Untertitel in der bevorzugten Sprache (Einstellungen); von Hand erstellte vor automatisch erzeugten. */
function preferredCaption(tracks) {
  if (!tracks.length) return null;
  const lang = state.settings?.captionLang ?? 'de';
  if (!lang) return tracks.find((t) => !t.auto) ?? tracks[0];
  const match = (t) => t.lang === lang || t.lang.startsWith(lang + '-');
  return tracks.find((t) => match(t) && !t.auto) ?? tracks.find(match) ?? null;
}

function renderCaptionsButton() {
  const btn = $('btnCaptions');
  btn.hidden = state.captionTracks.length === 0;
  btn.classList.toggle('active', Boolean(player.caption));
  btn.title = player.caption ? 'Untertitel ausschalten (u)' : 'Untertitel (u)';
}

async function selectCaption(track, { quiet = false } = {}) {
  const token = state.token;
  try {
    await player.setCaption(track);
    if (token === state.token && !quiet) toast(track ? `Untertitel: ${track.label}` : 'Untertitel aus');
  } catch (err) {
    if (token === state.token && !quiet) toast('Untertitel konnten nicht geladen werden: ' + cleanError(err));
  }
  renderCaptionsButton();
}

function openCaptionsMenu() {
  const items = [{ label: 'Aus', checked: !player.caption, run: () => selectCaption(null) }];
  for (const t of state.captionTracks) items.push({ label: t.label, checked: player.caption === t.key, run: () => selectCaption(t) });
  openMenu($('btnCaptions'), items, { title: 'Untertitel', above: true });
}

function toggleCaptions() {
  if (player.caption) return selectCaption(null);
  const track = preferredCaption(state.captionTracks) ?? state.captionTracks.find((t) => !t.auto) ?? state.captionTracks[0];
  if (track) selectCaption(track);
}

/** Nach dem Laden: Untertitel gleich einschalten, wenn so eingestellt und die Sprache da ist. */
function autoCaptions(token) {
  if (token !== state.token || !state.settings?.captions) return;
  const track = preferredCaption(state.captionTracks);
  if (track) selectCaption(track, { quiet: true });
}

// ------------------------------------------------------------------ Infos, Kapitel, Kommentare

function toggleInfo(force, focus = null) {
  const panel = $('infoPanel');
  panel.hidden = force === undefined ? !panel.hidden : !force;
  if (panel.hidden) return;
  $('queuePanel').hidden = true;
  $('chatPanel').hidden = true;
  renderInfo();
  if (focus === 'chapters') $('infoBody').querySelector('.info-chapters')?.scrollIntoView({ block: 'start' });
}

function infoContainers() {
  let main = $('infoMain');
  let comments = $('infoComments');
  if (!main || !comments) {
    main = el('div');
    main.id = 'infoMain';
    comments = el('div', 'info-comments');
    comments.id = 'infoComments';
    $('infoBody').replaceChildren(main, comments);
  }
  return { main, comments };
}

function iconChip(name, text, cls = 'chip') {
  const c = el('span', cls);
  c.append(icon(name), el('span', null, text));
  return c;
}

/** Info-Leiste: Titel, Hinweise, Likes/Dislikes, Kanal, Kapitel, Beschreibung – darunter die Kommentare. */
function renderInfo() {
  if ($('infoPanel').hidden) return;
  const { main, comments } = infoContainers();
  const v = state.video;
  main.replaceChildren();
  if (!v) {
    comments.replaceChildren();
    $('infoSub').textContent = '';
    return;
  }
  if (isTwitch(v)) {
    $('infoSub').textContent = 'Twitch';
    main.append(el('p', 'info-note', 'Für Twitch gibt es hier keine Beschreibung – mehr steht auf der Kanalseite.'));
    comments.replaceChildren();
    return;
  }
  const d = state.details?.id === v.id ? state.details : null;
  $('infoSub').textContent = d ? [d.viewsText, d.dateText || d.relativeDate].filter(Boolean).join(' · ') : 'Lädt …';

  const original = v.title || d?.title || '';
  const shown = displayTitle(v) || original;
  main.append(el('h3', 'info-title', shown));
  if (original && shown !== original) main.append(el('p', 'info-original', `Original: ${original}`));

  const chips = el('div', 'info-chips');
  if (state.sponsor?.full) chips.append(el('span', 'chip warn', state.sponsor.full.label));
  if (d?.likeCount != null) chips.append(iconChip('thumbUp', count(d.likeCount)));
  const votes = state.votes?.videoId === v.id ? state.votes : null;
  if (votes?.dislikes != null) {
    const c = iconChip('thumbDown', count(votes.dislikes));
    c.title = 'Schätzung von Return YouTube Dislike';
    chips.append(c);
  }
  const highlight = state.sponsor?.highlight;
  if (highlight) {
    const b = el('button', 'chip action');
    b.append(icon('flag'), el('span', null, `Zum Highlight (${durationMs(highlight.startMs)})`));
    b.addEventListener('click', () => player.seekToHighlight(highlight.startMs));
    chips.append(b);
  }
  if (chips.childElementCount) main.append(chips);

  const channelId = currentChannelId();
  const channelName = d?.channelName || v.channelName;
  if (channelName) {
    const row = el('div', 'info-channel');
    const avatar = el('img', 'info-avatar');
    if (d?.channelAvatar) avatar.src = d.channelAvatar;
    avatar.alt = '';
    const text = el('div', 'info-channel-text');
    const name = el('b', channelId ? 'card-channel' : null, channelName);
    if (channelId) {
      name.title = 'Zum Kanal';
      name.addEventListener('click', () => {
        if (state.fullscreen) gx.setFullscreen(false);
        openChannel(channelId, channelName);
      });
    }
    text.append(name);
    if (d?.subscribersText) text.append(el('span', null, d.subscribersText));
    row.append(avatar, text);
    if (channelId) row.append(subscribeButton({ id: channelId, name: channelName, thumbnail: d?.channelAvatar ?? null }));
    main.append(row);
  }

  const chapters = currentChapters();
  if (chapters.length) {
    const sec = el('div', 'info-section info-chapters');
    sec.append(el('h4', null, d?.chapters?.length ? 'Kapitel' : 'Kapitel (SponsorBlock)'));
    const ol = el('ol', 'chapter-list');
    const current = chapterAt(chapters, player.positionMs);
    chapters.forEach((c, i) => {
      const li = el('li', 'chapter' + (i === current ? ' current' : ''));
      li.dataset.index = String(i);
      if (c.thumbnail) {
        const img = el('img');
        img.src = c.thumbnail;
        img.alt = '';
        img.loading = 'lazy';
        li.append(img);
      }
      const t = el('div', 'chapter-text');
      t.append(el('span', 'chapter-title', c.title), el('span', 'chapter-time', durationMs(c.startMs)));
      li.append(t);
      li.addEventListener('click', () => player.seek(c.startMs));
      ol.append(li);
    });
    sec.append(ol);
    main.append(sec);
  }

  if (d?.description) {
    const sec = el('div', 'info-section');
    sec.append(el('h4', null, 'Beschreibung'));
    const desc = el('div', 'info-desc collapsed');
    appendRichText(desc, d.description);
    const more = el('button', 'link-btn', 'Mehr anzeigen');
    more.addEventListener('click', () => {
      more.textContent = desc.classList.toggle('collapsed') ? 'Mehr anzeigen' : 'Weniger anzeigen';
    });
    sec.append(desc, more);
    main.append(sec);
  } else if (!d) {
    main.append(el('p', 'info-note', 'Lädt …'));
  }

  // Kommentare erst, wenn die Info-Leiste offen ist – und einmal pro Video
  if (state.comments?.videoId !== v.id) loadComments();
  else renderComments();
}

/** Text mit klickbaren Links (YouTube-Videos laufen in GX Tube) und Zeitstempeln (springen im Video). */
function appendRichText(target, text) {
  for (const part of textParts(text)) {
    if (part.type === 'link') {
      const a = el('a', 'rich-link', part.text);
      a.href = '#';
      a.title = part.url;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        openLink(part.url);
      });
      target.append(a);
    } else if (part.type === 'time') {
      const a = el('a', 'rich-time', part.text);
      a.href = '#';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        player.seek(part.ms);
      });
      target.append(a);
    } else {
      target.append(document.createTextNode(part.text));
    }
  }
}

function openLink(url) {
  const id = videoIdFromUrl(url);
  if (id && id === state.video?.id) {
    const t = startFromUrl(url);
    if (t != null) player.seek(t);
    return;
  }
  if (id) {
    gx.play({ id, title: '', channelName: '', channelId: null, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, durationSec: -1, isLive: false }, null);
    return;
  }
  gx.openExternal(url);
}

async function loadComments(sort = 'TOP_COMMENTS') {
  const v = state.video;
  if (!v || isTwitch(v)) return;
  const c = { videoId: v.id, sort, items: [], next: null, count: '', loading: true, error: null };
  state.comments = c;
  renderComments();
  try {
    const res = await gx.comments(v.id, sort);
    if (state.comments !== c) return;
    c.items = res.items;
    c.next = res.next;
    c.count = res.count;
  } catch (err) {
    if (state.comments !== c) return;
    const msg = cleanError(err);
    c.error = /disabled|deaktiviert|turned off|ausgeschaltet/i.test(msg) ? 'Die Kommentare sind deaktiviert.' : 'Kommentare konnten nicht geladen werden: ' + msg;
  } finally {
    if (state.comments === c) {
      c.loading = false;
      renderComments();
    }
  }
}

async function loadMoreComments() {
  const c = state.comments;
  if (!c || c.loading || !c.next || $('infoPanel').hidden) return;
  c.loading = true;
  renderComments();
  try {
    const res = await gx.commentsMore(c.next);
    if (state.comments !== c) return;
    c.items = [...c.items, ...res.items];
    c.next = res.next;
  } catch {
    if (state.comments === c) c.next = null;
  } finally {
    if (state.comments === c) {
      c.loading = false;
      renderComments();
    }
  }
}

function renderComments() {
  const box = $('infoComments');
  if (!box || $('infoPanel').hidden) return;
  const c = state.comments;
  const v = state.video;
  box.replaceChildren();
  if (!v || isTwitch(v) || !c || c.videoId !== v.id) return;
  const head = el('div', 'comments-head');
  head.append(el('h4', null, c.count ? `${c.count} Kommentare` : 'Kommentare'));
  const sort = el('button', 'pill small ghost');
  sort.title = 'Sortierung wechseln';
  sort.append(icon('sort'), el('span', null, c.sort === 'NEWEST_FIRST' ? 'Neueste zuerst' : 'Top-Kommentare'));
  sort.addEventListener('click', () => loadComments(c.sort === 'NEWEST_FIRST' ? 'TOP_COMMENTS' : 'NEWEST_FIRST'));
  head.append(sort);
  box.append(head);
  if (c.error) {
    box.append(el('p', 'info-note', c.error));
    return;
  }
  const list = el('div', 'comment-list');
  for (const item of c.items) list.append(commentItem(item));
  box.append(list);
  if (c.loading) box.append(el('p', 'info-note', 'Lädt …'));
  else if (c.next) {
    const more = el('button', 'pill small ghost comments-more', 'Weitere Kommentare');
    more.addEventListener('click', () => loadMoreComments());
    box.append(more);
  } else if (!c.items.length) box.append(el('p', 'info-note', 'Noch keine Kommentare.'));
}

function commentItem(cm, reply = false) {
  const row = el('div', 'comment' + (reply ? ' reply' : ''));
  const avatar = el('img', 'comment-avatar');
  if (cm.avatar) avatar.src = cm.avatar;
  avatar.alt = '';
  avatar.loading = 'lazy';
  const body = el('div', 'comment-body');
  const head = el('div', 'comment-head');
  const author = el('b', cm.byOwner ? 'owner' : null, cm.author || 'Unbekannt');
  if (cm.authorId) {
    author.classList.add('card-channel');
    author.addEventListener('click', () => {
      if (state.fullscreen) gx.setFullscreen(false);
      openChannel(cm.authorId, cm.author);
    });
  }
  head.append(author);
  if (cm.published) head.append(el('span', null, cm.published));
  if (cm.pinned) head.append(iconChip('pin', 'Angepinnt', 'comment-flag'));
  const text = el('div', 'comment-text');
  appendRichText(text, cm.text);
  const meta = el('div', 'comment-meta');
  if (cm.likes) meta.append(iconChip('thumbUp', cm.likes, 'lite'));
  if (cm.hearted) meta.append(el('span', 'comment-heart', '♥ vom Kanal'));
  body.append(head, text, meta);
  if (cm.replies) {
    // Geladene Antworten am Kommentar merken (überlebt das Neuzeichnen der Liste)
    const r = (cm.replyState ??= { items: [], next: cm.replies, loading: false });
    const box = el('div', 'comment-replies');
    for (const item of r.items) box.append(commentItem(item, true));
    const btn = el('button', 'link-btn', r.items.length ? 'Weitere Antworten' : cm.replyCount ? `${cm.replyCount} Antworten` : 'Antworten anzeigen');
    btn.hidden = !r.next;
    btn.addEventListener('click', async () => {
      if (!r.next || r.loading) return;
      r.loading = true;
      btn.textContent = 'Lädt …';
      try {
        const res = await gx.commentReplies(r.next);
        r.items.push(...res.items);
        r.next = res.next;
        for (const item of res.items) box.append(commentItem(item, true));
        btn.textContent = 'Weitere Antworten';
        btn.hidden = !r.next;
      } catch {
        btn.textContent = 'Antworten konnten nicht geladen werden';
      } finally {
        r.loading = false;
      }
    });
    body.append(box, btn);
  }
  row.append(avatar, body);
  return row;
}

/** Return YouTube Dislike: Dislike-Zahl des aktuellen Videos (nur wenn eingeschaltet). */
async function loadVotes() {
  const v = state.video;
  if (!v || isTwitch(v) || !state.settings?.returnDislike || state.votes?.videoId === v.id) return;
  const marker = { videoId: v.id, likes: null, dislikes: null };
  state.votes = marker;
  const res = await gx.votes(v.id).catch(() => null);
  if (state.votes !== marker) return;
  state.votes = { videoId: v.id, likes: res?.likes ?? null, dislikes: res?.dislikes ?? null };
  renderInfo();
}

// ------------------------------------------------------------------ Tastatur

function bindKeys() {
  bindMediaKeys();
  document.addEventListener('keydown', (e) => {
    if (!$('signInDialog').hidden) {
      if (e.key === 'Escape') closeSignInDialog();
      return;
    }
    if (Twitch.dialogOpen()) {
      if (e.key === 'Escape') Twitch.closeLoginDialog();
      return;
    }
    if (e.target.matches('input[type=text], input[type=search], select')) return;
    if (state.watch !== 'full' || !state.video) {
      if (e.key === '/') {
        e.preventDefault();
        $('searchInput').focus();
      }
      return;
    }
    const k = e.key;
    let handled = true;
    if (k === ' ' || k === 'k' || k === 'K') {
      player.togglePlay();
      flash(video.paused ? 'pause' : 'play');
    } else if (k === 'ArrowRight') player.seekBy(5000);
    else if (k === 'ArrowLeft') player.seekBy(-5000);
    else if (k === 'l' || k === 'L') player.seekBy(10000);
    else if (k === 'j' || k === 'J') player.seekBy(-10000);
    else if (k === 'ArrowUp') { player.volumeBy(5); showVolumeHint(); }
    else if (k === 'ArrowDown') { player.volumeBy(-5); showVolumeHint(); }
    else if (k === 'm' || k === 'M') player.setMuted(!video.muted);
    else if (k === 'f' || k === 'F') gx.setFullscreen(!state.fullscreen);
    else if (k === 'q' || k === 'Q') toggleQueue();
    else if (k === 'i' || k === 'I') toggleInfo();
    else if ((k === 'c' || k === 'C') && twitchLive(state.video)) toggleChat();
    else if ((k === 'c' || k === 'C' || k === 'u' || k === 'U') && state.captionTracks.length) toggleCaptions();
    else if (k === 'N' && e.shiftKey) gx.next();
    else if (k === 'P' && e.shiftKey) gx.previous(player.positionMs);
    else if (k === 'Escape') {
      if (!$('menu').hidden) closeMenu();
      else if (state.fullscreen) gx.setFullscreen(false);
      else setWatch('mini');
    } else if (/^[0-9]$/.test(k) && player.durationMs) player.seek((Number(k) / 10) * player.durationMs);
    else handled = false;
    if (handled) {
      e.preventDefault();
      showControls();
    }
  });
}

// ------------------------------------------------------------------ Einstellungen

function toggleRow(label, hint, key) {
  const row = el('div', 'set-row');
  const l = el('div', 'label');
  l.append(el('b', null, label));
  if (hint) l.append(el('span', null, hint));
  const t = el('label', 'toggle');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = Boolean(state.settings[key]);
  input.addEventListener('change', async () => {
    state.settings = await gx.setSettings({ [key]: input.checked });
    if (key === 'sponsorBlock' || key === 'captions') renderSettings();
    if (key === 'dearrow') {
      branding.clear();
      renderTitle();
    }
    if (key === 'returnDislike') loadVotes();
    if (key === 'twitchAdSpoofing') notifyAdBlock({ event: 'spoofing', enabled: state.settings.twitchAdSpoofing !== false });
  });
  t.append(input, el('span', 'track'));
  row.append(l, t);
  return row;
}

async function renderSettings() {
  const s = (state.settings = await gx.settings());
  const info = (state.info = await gx.info());
  const f = $('settingsForm');
  f.replaceChildren(el('h2', null, 'Einstellungen'));

  f.append(el('h3', null, 'Streamen vom Handy'));
  const nameRow = el('div', 'set-row');
  const nameLabel = el('div', 'label');
  nameLabel.append(el('b', null, 'Name dieses PCs'), el('span', null, 'So erscheint der PC in der GX Tube App.'));
  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.maxLength = 40;
  nameInput.value = s.deviceName;
  nameInput.addEventListener('change', async () => {
    state.settings = await gx.setSettings({ deviceName: nameInput.value });
    nameInput.value = state.settings.deviceName;
    renderHero();
  });
  nameRow.append(nameLabel, nameInput);
  f.append(nameRow);
  const addrRow = el('div', 'set-row');
  const addrLabel = el('div', 'label');
  addrLabel.append(el('b', null, 'Adresse im WLAN'), el('span', null, info.port ? `Port ${info.port} (TCP) und 8766 (UDP, Suche)` : 'Empfänger läuft nicht'));
  const addr = el('span', 'addr', info.addresses.join(', ') || '–');
  addrRow.append(addrLabel, addr);
  f.append(addrRow);
  f.append(toggleRow('Fenster nach vorne holen', 'Wenn das Handy ein Video schickt', 'focusOnCast'));
  f.append(toggleRow('Vollbild beim Streamen', 'Videos vom Handy direkt im Vollbild zeigen (wie auf dem Fernseher)', 'fullscreenOnCast'));
  f.append(toggleRow('Handy darf den PC ausschalten', 'Neu starten und herunterfahren vom Handy – sofort, offene Programme werden ohne Nachfrage geschlossen', 'remotePower'));

  f.append(el('h3', null, 'Wiedergabe'));
  const qRow = el('div', 'set-row');
  const qLabel = el('div', 'label');
  qLabel.append(el('b', null, 'Höchste Qualität'), el('span', null, 'Automatisch wird höchstens diese Auflösung gewählt'));
  const sel = el('select');
  for (const h of [2160, 1440, 1080, 720, 480, 360]) {
    const o = el('option', null, qualityLabel(h));
    o.value = String(h);
    o.selected = s.maxQuality === h;
    sel.append(o);
  }
  sel.addEventListener('change', async () => {
    state.settings = await gx.setSettings({ maxQuality: Number(sel.value) });
    player.setMaxQuality(state.settings.maxQuality);
  });
  qRow.append(qLabel, sel);
  f.append(qRow);
  f.append(toggleRow('Autoplay', 'Nach dem letzten Video automatisch ein ähnliches abspielen', 'autoplay'));
  f.append(toggleRow('SponsorBlock', 'Gesponserte Abschnitte im Video überspringen', 'sponsorBlock'));
  if (s.sponsorBlock) {
    const cats = el('div', 'cats');
    const names = { sponsor: 'Sponsor', selfpromo: 'Eigenwerbung', interaction: 'Abo-Erinnerung', intro: 'Intro', outro: 'Abspann', preview: 'Vorschau', music_offtopic: 'Nicht-Musik', filler: 'Abschweifung' };
    for (const [key, label] of Object.entries(names)) {
      const lab = el('label');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = s.sponsorCategories.includes(key);
      cb.addEventListener('change', async () => {
        const set = new Set(state.settings.sponsorCategories);
        if (cb.checked) set.add(key);
        else set.delete(key);
        state.settings = await gx.setSettings({ sponsorCategories: [...set] });
      });
      lab.append(cb, el('span', null, label));
      cats.append(lab);
    }
    f.append(cats);
    f.append(el('p', 'set-note', 'Dazu zeigt GX Tube das Highlight eines Videos (★ auf der Zeitleiste), schaltet als „stumm“ markierte Abschnitte stumm und nimmt Kapitel aus SponsorBlock, wenn YouTube keine hat.'));
  }
  f.append(toggleRow('Untertitel automatisch', 'Untertitel gleich einschalten, wenn es welche gibt – sonst über „CC“ im Player oder die Taste „u“', 'captions'));
  if (s.captions) {
    const capRow = el('div', 'set-row');
    const capLabel = el('div', 'label');
    capLabel.append(el('b', null, 'Bevorzugte Sprache'), el('span', null, 'Gibt es sie nicht, bleiben die Untertitel aus'));
    const capSel = el('select');
    for (const [value, label] of [['de', 'Deutsch'], ['en', 'Englisch'], ['', 'Erste verfügbare']]) {
      const o = el('option', null, label);
      o.value = value;
      o.selected = (s.captionLang ?? 'de') === value;
      capSel.append(o);
    }
    capSel.addEventListener('change', async () => {
      state.settings = await gx.setSettings({ captionLang: capSel.value });
    });
    capRow.append(capLabel, capSel);
    f.append(capRow);
  }

  f.append(el('h3', null, 'Community'));
  f.append(toggleRow('DeArrow', 'Titel und Vorschaubilder ohne Clickbait (von der DeArrow-Community). Titel kommen anonym über einen Teil des Hashs der Video-ID; eigene Vorschaubilder lädt der DeArrow-Server', 'dearrow'));
  f.append(toggleRow('Dislikes anzeigen', 'Daumen nach unten im Info-Bereich (Schätzung von Return YouTube Dislike – die Video-ID geht dafür an returnyoutubedislikeapi.com)', 'returnDislike'));

  f.append(el('h3', null, 'Google-Konto'));
  f.append(accountRow());

  f.append(el('h3', null, 'Twitch'));
  f.append(Twitch.accountRow());
  f.append(toggleRow('Chat gleich zeigen', 'Den Stream-Chat sofort neben Live-Streams öffnen. Sonst startet er ausgeblendet – einblenden mit „c“, dem Chat-Knopf oder vom Handy', 'twitchChatOpen'));
  const adRow = el('div', 'set-row');
  const adLabel = el('div', 'label');
  adLabel.append(el('b', null, 'Twitch-Werbeblocker'), el('span', null, 'Aus Adblock GX: überspringt Werbepausen – der Stream läuft über eine werbefreie zweite Sitzung weiter. Nur wenn Twitch überall Werbung zeigt, kommt so lange ein schwarzes Bild. Immer an.'));
  adRow.append(adLabel, el('span', 'chip', 'Aktiv'));
  f.append(adRow);
  f.append(toggleRow('Werbung als gesehen melden', 'Ad-Spoofing: meldet Twitch-Werbung sofort als angesehen, damit der Stream ohne Wechsel weiterläuft. Nutzt dein Konto, wenn du angemeldet bist – aus, wenn du das nicht willst; dann übernehmen allein die Ersatz-Sitzungen', 'twitchAdSpoofing'));

  f.append(el('h3', null, 'Programm'));
  f.append(toggleRow('Im Hintergrund weiterlaufen', 'Schließen legt GX Tube in den Infobereich – das Handy findet den PC dann weiterhin', 'closeToTray'));
  f.append(toggleRow('Mit dem Computer starten', 'Startet unsichtbar im Infobereich, bereit zum Streamen', 'openAtLogin'));
  f.append(toggleRow('Automatische Updates', 'Stündlich auf GitHub nach neuen Versionen suchen und im Hintergrund laden', 'autoUpdate'));
  f.append(updateRow());
  f.append(toggleRow('Verlauf speichern', 'Für „Weiter ansehen“ und Empfehlungen (nur auf diesem PC)', 'historyEnabled'));
  const clearRow = el('div', 'set-row');
  const clearLabel = el('div', 'label');
  clearLabel.append(el('b', null, 'Verlauf löschen'));
  const clearBtn = el('button', 'pill small ghost', 'Löschen');
  clearBtn.addEventListener('click', async () => {
    await gx.removeHistory(null);
    toast('Verlauf gelöscht');
  });
  clearRow.append(clearLabel, clearBtn);
  f.append(clearRow);

  const about = el('p', 'hint', `GX Tube Desktop ${info.version} – werbefrei über YouTube.js und den Twitch-Werbeblocker von Adblock GX, nicht mit YouTube, Google oder Twitch verbunden.`);
  about.style.marginTop = '24px';
  f.append(about);
}

// ------------------------------------------------------------------ Updates

const RELEASES = 'https://github.com/abilas-sivarajah/adblock-tube-gx-desktop/releases/latest';

function updateText(u) {
  if (!u) return '';
  switch (u.state) {
    case 'unsupported': return u.reason;
    case 'checking': return 'Suche nach neuer Version …';
    case 'none': return 'Du hast die neueste Version.';
    case 'downloading': return `Version ${u.version} wird geladen … ${u.percent ?? 0} %`;
    case 'ready': return `Version ${u.version} ist bereit zum Installieren.`;
    case 'error': return `Update-Suche fehlgeschlagen: ${u.error}`;
    default: return 'Noch nicht gesucht.';
  }
}

/** Zeile in den Einstellungen: Version, Status, "Jetzt suchen" bzw. "Neu starten & aktualisieren". */
function updateRow() {
  const row = el('div', 'set-row');
  row.id = 'updateRow';
  const label = el('div', 'label');
  label.append(el('b', null, `Version ${state.update?.current ?? state.info?.version ?? ''}`), el('span', 'update-text', updateText(state.update)));
  const btn = el('button', 'pill small');
  btn.addEventListener('click', async () => {
    const u = state.update;
    if (u?.state === 'ready') gx.installUpdate();
    else if (u?.state === 'unsupported') gx.openExternal(RELEASES);
    else {
      state.update = await gx.checkForUpdates();
      renderUpdate();
    }
  });
  row.append(label, btn);
  fillUpdateButton(btn);
  return row;
}

function fillUpdateButton(btn) {
  const u = state.update;
  btn.className = 'pill small' + (u?.state === 'ready' ? '' : ' ghost');
  btn.disabled = u?.state === 'checking' || u?.state === 'downloading';
  btn.textContent =
    u?.state === 'ready' ? 'Neu starten & aktualisieren'
      : u?.state === 'unsupported' ? 'Auf GitHub öffnen'
        : u?.state === 'checking' ? 'Suche …'
          : u?.state === 'downloading' ? 'Lädt …'
            : 'Jetzt nach Updates suchen';
}

function renderUpdate() {
  const u = state.update;
  $('btnUpdate').hidden = u?.state !== 'ready';
  if (u?.state === 'ready') $('btnUpdate').title = `Version ${u.version} installieren und GX Tube neu starten`;
  const row = $('updateRow');
  if (!row) return;
  row.querySelector('.update-text').textContent = updateText(u);
  fillUpdateButton(row.querySelector('button'));
}

// ------------------------------------------------------------------ Google-Konto

let signingIn = false;

/** Anmelden: Standard ist der Code fürs Handy (wie beim Fernseher), das Fenster gibt es als Alternative. */
function signIn() {
  openSignInDialog();
}

/** Anmeldung im Fenster am PC. */
async function windowSignIn() {
  if (signingIn) return;
  signingIn = true;
  renderAccount();
  try {
    state.account = await gx.login();
  } catch (err) {
    toast('Anmeldung fehlgeschlagen: ' + cleanError(err));
  } finally {
    signingIn = false;
    renderAccount();
  }
}

function accountText(a) {
  if (a?.loggedIn) return (a.method === 'device' ? 'Per Code vom Handy angemeldet. ' : '') + 'Wird nur benutzt, wenn YouTube anonyme Anfragen sperrt („Bestätige, dass du kein Bot bist“), HD sperrt oder ein Video eine Anmeldung verlangt. Videos bleiben werbefrei.';
  if (a?.expired) return 'Die Anmeldung ist abgelaufen oder wurde in deinem Google-Konto beendet. Melde dich neu an.';
  return 'Optional. Hilft, wenn YouTube „Bestätige, dass du kein Bot bist“ meldet. Die Anmeldung bleibt nur auf diesem PC, Videos bleiben werbefrei.';
}

/** Zeile in den Einstellungen: Anmelden bzw. "Angemeldet als …" und Abmelden. */
function accountRow() {
  const row = el('div', 'set-row');
  row.id = 'accountRow';
  fillAccountRow(row);
  return row;
}

function fillAccountRow(row) {
  const a = state.account;
  const label = el('div', 'label');
  const title = a?.loggedIn ? (a.name ? `Angemeldet als ${a.name}` : 'Mit Google angemeldet') : a?.expired ? 'Anmeldung abgelaufen' : 'Nicht angemeldet';
  label.append(el('b', null, title), el('span', null, accountText(a)));
  const buttons = el('div', 'buttons');
  if (a?.loggedIn) {
    if (a.method === 'device') {
      // Per Code angemeldet: Die Anmeldung im Fenster lädt wie YouTube im Browser (hilft, wenn Videos scheitern)
      const here = el('button', 'pill small ghost', signingIn ? 'Anmeldefenster ist offen …' : 'Im Fenster anmelden');
      here.title = 'Stattdessen über Googles Anmeldeseite hier am PC anmelden – dann lädt GX Tube wie YouTube im Browser';
      here.disabled = signingIn;
      here.addEventListener('click', () => windowSignIn());
      buttons.append(here);
    }
    const out = el('button', 'pill small ghost', 'Abmelden');
    out.addEventListener('click', async () => {
      state.account = await gx.logout();
      toast('Abgemeldet');
      renderAccount();
    });
    buttons.append(out);
  } else {
    const phone = el('button', 'pill small', a?.expired ? 'Neu anmelden (Handy)' : 'Mit dem Handy anmelden');
    phone.title = 'Der PC zeigt einen Code, den du auf dem Handy unter google.com/device eingibst – wie bei YouTube auf dem Fernseher';
    phone.addEventListener('click', () => openSignInDialog());
    const here = el('button', 'pill small ghost', signingIn ? 'Anmeldefenster ist offen …' : 'Hier im Fenster');
    here.title = 'Google-Anmeldeseite hier am PC öffnen';
    here.disabled = signingIn;
    here.addEventListener('click', () => windowSignIn());
    buttons.append(phone, here);
  }
  const parts = [];
  if (a?.loggedIn && a.photo) {
    const img = el('img', 'account-photo');
    img.src = a.photo;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    parts.push(img);
  }
  row.replaceChildren(...parts, label, buttons);
}

// Anmeldung per Code: Der PC zeigt den Code, bestätigt wird auf dem Handy unter google.com/device
const signInDialog = { open: false, phase: null, info: null, message: null };
let signInTimer = null;

async function openSignInDialog() {
  if (signInDialog.open) return;
  signInDialog.open = true;
  closeMenu();
  await requestSignInCode();
}

async function requestSignInCode() {
  signInDialog.phase = 'loading';
  signInDialog.message = null;
  renderSignInDialog();
  try {
    signInDialog.info = await gx.deviceLoginStart();
    if (signInDialog.open) signInDialog.phase = 'code';
  } catch (err) {
    signInDialog.phase = 'error';
    signInDialog.message = cleanError(err);
  }
  renderSignInDialog();
}

function closeSignInDialog({ cancel = true } = {}) {
  if (!signInDialog.open) return;
  if (cancel && signInDialog.phase === 'code') gx.deviceLoginCancel();
  signInDialog.open = false;
  signInDialog.phase = null;
  renderSignInDialog();
}

function onDeviceLogin({ state: result, message }) {
  if (!signInDialog.open || result === 'cancelled') return;
  if (result === 'ok') {
    closeSignInDialog({ cancel: false });
    return;
  }
  signInDialog.phase = result;
  signInDialog.message = message;
  renderSignInDialog();
}

function renderSignInDialog() {
  const d = signInDialog;
  $('signInDialog').hidden = !d.open;
  clearInterval(signInTimer);
  if (!d.open) return;
  const parts = [];
  if (d.phase === 'loading') {
    parts.push(el('p', 'dialog-wait', 'Code wird geholt …'));
  } else if (d.phase === 'code') {
    const url = d.info.verificationUrl.replace(/^https?:\/\/(www\.)?/, '');
    const steps = el('ol');
    const open = el('li', null, 'Öffne auf dem Handy ');
    open.append(el('b', null, url));
    steps.append(open, el('li', null, 'Gib diesen Code ein:'));
    const code = el('div', 'device-code', d.info.userCode);
    const steps2 = el('ol');
    steps2.start = 3;
    steps2.append(el('li', null, 'Wähle dein Google-Konto und tippe auf „Zulassen“.'));
    const wait = el('p', 'dialog-wait');
    const tick = () => {
      const min = Math.max(0, Math.ceil((d.info.expiresAt - Date.now()) / 60000));
      wait.textContent = `Warte auf dein Handy … (Code gilt noch ${min} Min.)`;
    };
    tick();
    signInTimer = setInterval(tick, 5000);
    parts.push(steps, code, steps2, wait, el('p', 'hint', 'Google fragt dabei nach „YouTube auf dem Fernseher“ – das ist richtig so: GX Tube meldet sich wie ein Fernseher an. Dein Passwort bekommt GX Tube nie.'));
  } else {
    const text = {
      expired: 'Der Code ist abgelaufen.',
      denied: 'Die Anmeldung wurde auf dem Handy abgelehnt.',
    }[d.phase] ?? `Das hat nicht geklappt: ${d.message || 'unbekannter Fehler'}`;
    const again = el('button', 'pill small', 'Neuen Code holen');
    again.addEventListener('click', () => requestSignInCode());
    const row = el('div', 'dialog-actions');
    row.style.justifyContent = 'flex-start';
    row.append(again);
    parts.push(el('p', 'dialog-problem', text), row);
  }
  const actions = el('div', 'dialog-actions');
  const here = el('button', 'pill small ghost', 'Lieber hier am PC anmelden');
  here.addEventListener('click', () => {
    closeSignInDialog();
    windowSignIn();
  });
  const cancel = el('button', 'pill small ghost', 'Abbrechen');
  cancel.addEventListener('click', () => closeSignInDialog());
  actions.append(here, cancel);
  parts.push(actions);
  $('signInBody').replaceChildren(...parts);
}

function renderSignInButton(status = player.status) {
  const win = $('btnSignInWindow');
  win.hidden = !(status === 'error' && state.errorSignInWindow);
  win.disabled = signingIn;
  win.textContent = signingIn ? 'Anmeldefenster ist offen …' : 'Im Fenster anmelden';
  const btn = $('btnSignIn');
  btn.hidden = !(status === 'error' && state.errorSignIn && !state.account?.loggedIn);
  btn.disabled = signingIn;
  btn.textContent = signingIn ? 'Anmeldefenster ist offen …' : state.account?.expired ? 'Neu anmelden' : 'Mit Google anmelden';
}

function renderAccount() {
  const row = $('accountRow');
  if (row) fillAccountRow(row);
  if (!$('errorBox').hidden) renderSignInButton('error');
}

// ------------------------------------------------------------------ Twitch im Player

function renderTwitchControls() {
  const v = state.video;
  const tw = isTwitch(v);
  $('btnChat').hidden = !twitchLive(v);
  document.querySelector('.autoplay-switch').hidden = tw;
  $('btnSpeed').hidden = tw && v.isLive;
}

function openTwitchQualityMenu() {
  const tracks = player.variants();
  const label = (t) => `${t.height}p${t.frameRate >= 50 ? Math.round(t.frameRate) : ''}`;
  const items = [{ label: 'Automatisch', checked: player.fixedHeight === 0, run: () => player.setQuality(0) }];
  for (const t of tracks) items.push({ label: label(t), checked: player.fixedHeight === t.height, run: () => player.setQuality(t.height) });
  const s = state.stream;
  const lines = [`Werbeblocker aktiv${state.ads ? ` · ${state.ads} Werbepause${state.ads === 1 ? '' : 'n'} ausgeblendet` : ''}`, `Geladen über ${s?.client ?? 'Twitch'}${state.video?.id ? ` · ${state.video.id.replace(/^twitch(-vod)?:/, '')}` : ''}`];
  items.push({ note: lines.join('\n'), small: true });
  openMenu($('btnQuality'), items, { title: 'Qualität', above: true });
}

// Chat: liest anonym mit, schreibt mit Twitch-Konto
let chat = null;
let chatLogin = null;
let chatStick = true;
// Chat gewünscht? Beim Start ausgeblendet (außer in den Einstellungen anders gewählt), danach gilt die letzte Wahl
let chatWanted = null;
const CHAT_MAX = 250;
const BADGES = { broadcaster: ['▶', 'Streamer'], moderator: ['MOD', 'Moderator'], vip: ['VIP', 'VIP'], subscriber: ['★', 'Abonnent'] };
const NAME_COLORS = ['#ff7f50', '#1e90ff', '#9acd32', '#ff69b4', '#daa520', '#5f9ea0', '#00ff7f', '#b22222', '#d2691e', '#8a2be2', '#2e8b57', '#ff4500'];

function bindChat() {
  chat = new TwitchChat({
    onMessage: (m) => addChatLine(m),
    onDelete: ({ id, login }) => {
      const list = $('chatList');
      if (!id && !login) {
        list.replaceChildren(el('div', 'chat-line system', 'Der Chat wurde von einem Moderator geleert.'));
        return;
      }
      for (const line of list.querySelectorAll(id ? `[data-id="${CSS.escape(id)}"]` : `[data-login="${CSS.escape(login)}"]`)) line.classList.add('deleted');
    },
    onInfo: (text) => addChatLine({ id: `info-${Date.now()}`, system: true, frags: [{ text }] }),
    onState: (s) => renderChatState(s),
    onAuthFailed: () => addChatLine({ id: `auth-${Date.now()}`, system: true, frags: [{ text: 'Twitch hat die Anmeldung für den Chat abgelehnt – du liest weiter mit. Melde dich in den Einstellungen neu bei Twitch an.' }] }),
  });
  const list = $('chatList');
  list.addEventListener('scroll', () => {
    chatStick = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
    if (chatStick) $('chatJump').hidden = true;
  });
  $('chatJump').addEventListener('click', () => {
    list.scrollTop = list.scrollHeight;
    chatStick = true;
    $('chatJump').hidden = true;
  });
  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chatInput');
    if (chat.send(input.value)) {
      input.value = '';
      chatStick = true;
    }
  });
  $('chatInput').addEventListener('keydown', (e) => {
    // Tasten im Chat steuern nicht den Player
    e.stopPropagation();
    if (e.key === 'Escape') $('chatInput').blur();
  });
  $('chatLoginBtn').addEventListener('click', () => Twitch.openLoginDialog());
  // Dem Handy melden, ob der Chat zu sehen ist
  new MutationObserver(() => gx.chatVisible(!$('chatPanel').hidden)).observe($('chatPanel'), { attributes: true, attributeFilter: ['hidden'] });
}

async function startChat(login) {
  if (!login) return;
  chatLogin = login;
  $('chatSub').textContent = login;
  if (chat.channel !== login) $('chatList').replaceChildren(el('div', 'chat-line system', `Willkommen im Chat von ${login}!`));
  const auth = await gx.twitchChatAuth().catch(() => null);
  if (chatLogin !== login) return;
  chat.join(login, auth);
  renderChatState();
  chatWanted ??= state.settings?.twitchChatOpen === true;
  if (chatWanted && $('queuePanel').hidden) toggleChat(true);
}

function stopChat() {
  chatLogin = null;
  chat?.close();
  $('chatPanel').hidden = true;
}

function toggleChat(force) {
  if (!twitchLive(state.video)) return;
  const panel = $('chatPanel');
  panel.hidden = force === undefined ? !panel.hidden : !force;
  chatWanted = !panel.hidden;
  if (!panel.hidden) {
    $('queuePanel').hidden = true;
    $('infoPanel').hidden = true;
    const list = $('chatList');
    list.scrollTop = list.scrollHeight;
  }
}

function renderChatState(s) {
  const loggedIn = Boolean(chat?.auth);
  $('chatForm').hidden = !loggedIn;
  $('chatLogin').hidden = loggedIn;
  if (s === 'connecting' && chatLogin) $('chatSub').textContent = `${chatLogin} · verbinde …`;
  else if (s === 'open') $('chatSub').textContent = `${chatLogin}${loggedIn ? '' : ' · nur lesen'}`;
}

function nameColor(color, login) {
  if (!color) {
    let h = 0;
    for (const c of login ?? '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return NAME_COLORS[h % NAME_COLORS.length];
  }
  // Zu dunkle Farben auf dem dunklen Hintergrund aufhellen
  const n = parseInt(color.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum >= 0.4) return color;
  const mix = (c) => Math.round(c + (255 - c) * 0.45);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

function addChatLine(m) {
  const list = $('chatList');
  const line = el('div', 'chat-line' + (m.system ? ' system' : '') + (m.highlight ? ' highlight' : '') + (m.mention ? ' mention' : '') + (m.self ? ' self' : ''));
  line.dataset.id = m.id;
  if (m.login) line.dataset.login = m.login;
  if (!m.system) {
    for (const b of m.badges ?? []) {
      const badge = BADGES[b];
      if (badge) {
        const span = el('span', `chat-badge ${b}`, badge[0]);
        span.title = badge[1];
        line.append(span);
      }
    }
    const name = el('span', 'chat-name', m.name);
    name.style.color = nameColor(m.color, m.login);
    line.append(name, document.createTextNode(m.action ? ' ' : ': '));
  }
  const body = el('span', m.action ? 'chat-text action' : 'chat-text');
  for (const f of m.frags ?? []) {
    if (f.emote) {
      const img = el('img', 'chat-emote');
      img.src = f.url;
      img.alt = f.name;
      img.title = f.name;
      body.append(img);
    } else body.append(document.createTextNode(f.text));
  }
  if (m.action && !m.system) body.style.color = nameColor(m.color, m.login);
  line.append(body);
  list.append(line);
  while (list.childElementCount > CHAT_MAX) list.firstElementChild.remove();
  if (chatStick) list.scrollTop = list.scrollHeight;
  else $('chatJump').hidden = false;
}

function onTwitchAccount() {
  // Neu angemeldet oder abgemeldet: Chat mit dem passenden Zugang neu betreten
  if (chatLogin) startChat(chatLogin);
  if (!$('errorBox').hidden) renderStatus('error');
}

// Werbeblocker: meldet Werbepausen über einen BroadcastChannel
let adMuted = null;
let adChannel = null;

function notifyAdBlock(msg) {
  try {
    adChannel ??= new BroadcastChannel('gx-twitch-adblock');
    adChannel.postMessage(msg);
  } catch {
    // egal
  }
}

function bindAdBlock() {
  try {
    adChannel ??= new BroadcastChannel('gx-twitch-adblock');
  } catch {
    return;
  }
  adChannel.addEventListener('message', (e) => {
    if (!isTwitch(state.video)) return;
    const d = e.data ?? {};
    if (d.event === 'ad-start') state.ads = (state.ads ?? 0) + 1;
    else if (d.event === 'masked') showAdOverlay(d.hold ? 'Twitch zeigt gerade überall Werbung – gleich geht\'s live weiter.' : 'Werbung läuft im Hintergrund stumm – gleich geht\'s weiter.', !d.hold);
    else if (d.event === 'unmasked' || d.event === 'ad-end') hideAdOverlay();
    else if (d.event === 'bridge') {
      if (d.on) showAdOverlay('Werbepause übersprungen – kurz in niedrigerer Qualität.', false, true);
      else hideAdOverlay();
    }
  });
}

function showAdOverlay(text, mute, small = false) {
  const o = $('adOverlay');
  $('adText').textContent = text;
  o.classList.toggle('small', small);
  o.hidden = false;
  if (mute && adMuted === null) {
    adMuted = video.muted;
    video.muted = true;
  }
}

function hideAdOverlay() {
  $('adOverlay').hidden = true;
  if (adMuted !== null) {
    video.muted = adMuted;
    adMuted = null;
  }
}

// ------------------------------------------------------------------ Hinweise

function toast(text, { action = null, run = null } = {}) {
  const t = el('div', 'toast', text);
  const ms = action && run ? 6000 : 3000;
  if (action && run) {
    const b = el('button', 'toast-action', action);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      run();
      t.remove();
    });
    t.append(b);
  }
  $('toasts').append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
  while ($('toasts').children.length > 3) $('toasts').firstElementChild.remove();
}

boot().catch((err) => {
  console.error(err);
  toast('Start fehlgeschlagen: ' + cleanError(err));
});
