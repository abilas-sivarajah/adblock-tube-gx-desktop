// Oberfläche von GX Tube Desktop: Startseite, Suche, Player, Warteschlange, Einstellungen.

import { Player } from './player.js';
import { hydrateIcons, icon, setIcon } from './icons.js';
import { duration, durationMs, el, qualityLabel, relativeTime, speedLabel } from './format.js';

const gx = window.gx;
const $ = (id) => document.getElementById(id);

const state = {
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
};

const video = $('video');
const player = new Player(video, {
  onStatus: (s) => renderStatus(s),
  onSkip: (seg) => toast(`${seg.label} übersprungen`),
  onTracks: () => renderQualityButton(),
});

// ------------------------------------------------------------------ Start

async function boot() {
  hydrateIcons();
  const [settings, info, session] = await Promise.all([gx.settings(), gx.info(), gx.session()]);
  state.settings = settings;
  state.info = info;
  state.clients = info.clients;
  state.queue = session;
  await player.init({ volume: settings.volume, speed: settings.speed });
  $('volumeSlider').value = String(settings.volume);
  state.fullscreen = await gx.isFullscreen();

  bindTopbar();
  bindWatch();
  bindKeys();
  bindEvents();

  renderCastButton();
  renderHome();
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
  gx.onError(({ token, message, details, signIn, signInWindow }) => {
    if (token !== state.token) return;
    state.error = message;
    state.errorDetails = Array.isArray(details) ? details : [];
    state.errorSignIn = Boolean(signIn);
    state.errorSignInWindow = Boolean(signInWindow);
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
  });
  gx.onSegments(onSegments);
  gx.onStop(() => {
    state.token = null;
    state.video = null;
    state.details = null;
    player.stop();
    setWatch('hidden');
    renderHome();
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
  player.prepare(token);
  if (state.watch === 'hidden') setWatch('full');
  $('coverImg').src = v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`;
  renderTitle();
  renderSegments();
  renderQueue();
  renderRelated();
  renderStatus('loading');
  updateMediaSession();
}

let lastDegradedHint = 0;

function onSource({ token, stream, startMs, maxQuality }) {
  if (token !== state.token) return;
  state.stream = stream;
  player.load({ token, stream, startMs, maxQuality });
  renderQualityButton();
  // YouTube sperrt gerade die höheren Qualitäten – Bescheid sagen (nicht bei jedem Video)
  if (stream?.degraded && Date.now() - lastDegradedHint > 10 * 60 * 1000) {
    lastDegradedHint = Date.now();
    toast(`YouTube gibt gerade nur ${qualityLabel(stream.maxHeight)} frei` + (stream.signIn && !state.account?.loggedIn ? ' – mit Google anmelden hilft meist (Qualität-Menü)' : ''));
  }
}

function onSegments({ token, segments }) {
  if (token !== state.token) return;
  state.segments = segments ?? [];
  player.setSegments(state.segments);
  renderSegments();
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
    default: break;
  }
  showControls();
}

// ------------------------------------------------------------------ Kopfzeile, Suche

function bindTopbar() {
  $('btnHome').addEventListener('click', () => showView('home'));
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
  input.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    active = -1;
    const q = input.value;
    const seq = ++suggestSeq;
    suggestTimer = setTimeout(async () => {
      const list = q.trim() ? await gx.suggestions(q) : [];
      // Inzwischen gesucht oder weitergetippt? Dann nicht mehr anzeigen.
      if (seq !== suggestSeq || input.value !== q || document.activeElement !== input) return;
      renderSuggestions(list);
    }, 150);
  });
  input.addEventListener('focus', async () => {
    if (!input.value.trim()) {
      const lib = await gx.library();
      renderSuggestions(lib.searchHistory.slice(0, 10), true);
    }
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
    $('suggestions').hidden = true;
    input.blur();
    runSearch(q);
  });
  $('view-search').addEventListener('scroll', (e) => {
    const v = e.currentTarget;
    if (v.scrollTop + v.clientHeight > v.scrollHeight - 800) loadMoreSearch();
  });
  $('view-channel').addEventListener('scroll', (e) => {
    const v = e.currentTarget;
    if (v.scrollTop + v.clientHeight > v.scrollHeight - 800) loadMoreChannel();
  });
}

function renderSuggestions(list, history = false) {
  const ul = $('suggestions');
  ul.replaceChildren();
  for (const q of list) {
    const li = el('li');
    li.dataset.q = q;
    li.append(icon(history ? 'history' : 'search'), el('span', null, q));
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      $('searchInput').value = q;
      ul.hidden = true;
      runSearch(q);
    });
    ul.append(li);
  }
  ul.hidden = list.length === 0;
}

async function runSearch(q) {
  if (state.watch === 'full') setWatch('mini');
  showView('search');
  state.search = { query: q, next: null, loading: true };
  const grid = $('searchGrid');
  grid.replaceChildren();
  $('searchStatus').textContent = 'Suche läuft …';
  $('view-search').scrollTop = 0;
  try {
    const res = await gx.search(q);
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
    else if (item.kind === 'video' && !item.isShort) grid.append(videoCard(item));
  }
}

function cleanError(err) {
  return String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ------------------------------------------------------------------ Seiten

function showView(name) {
  state.view = name;
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === 'view-' + name);
  if (name === 'home') renderHome();
  if (name === 'settings') renderSettings();
  if (state.watch === 'full') setWatch('mini');
}

async function renderHome() {
  renderHero();
  renderSubsShelf();
  const lib = await gx.library();
  const cont = lib.history.filter((h) => h.durationMs > 0 && h.positionMs > 5000 && h.positionMs < h.durationMs - 15000).slice(0, 20);
  $('shelfContinue').hidden = cont.length === 0;
  $('continueRow').replaceChildren(...cont.map((h) => videoCard(h.video, { progress: h.positionMs / h.durationMs, historyId: h.video.id })));
  const recent = lib.history.slice(0, 40);
  const reco = lib.recommendations.slice(0, 40);
  $('shelfReco').hidden = reco.length === 0 && recent.length === 0;
  $('shelfReco').querySelector('h2').textContent = reco.length ? 'Empfohlen' : 'Verlauf';
  $('recoGrid').replaceChildren(...(reco.length ? reco : recent.map((h) => h.video)).map((v) => videoCard(v)));
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
  // Nicht bei jedem Wechsel auf die Startseite neu laden
  if (grid.childElementCount && Date.now() - subsFeedAt < 5 * 60 * 1000) return;
  if (!grid.childElementCount) $('subsHint').textContent = 'Lädt …';
  try {
    const videos = await gx.subscriptionFeed();
    subsFeedAt = Date.now();
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

function videoCard(v, { progress = null, historyId = null } = {}) {
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
  text.append(el('div', 'card-title', v.title || 'Video'));
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
    gx.play(toRef(v), null);
    setWatch('full');
  });
  return card;
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
    openChannel(id, state.video?.channelName);
  });
  $('miniExpand').addEventListener('click', () => setWatch('full'));
  $('miniClose').addEventListener('click', () => gx.stop());
  $('btnFull').addEventListener('click', () => gx.setFullscreen(!state.fullscreen));
  $('btnRetry').addEventListener('click', () => gx.retry());
  $('btnQueue').addEventListener('click', () => toggleQueue());
  $('btnQueueClose').addEventListener('click', () => toggleQueue(false));
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
    const heights = player.qualities();
    const items = [{ label: `Automatisch (bis ${qualityLabel(state.settings.maxQuality)})`, checked: player.fixedHeight === 0, run: () => player.setQuality(0) }];
    for (const h of heights) items.push({ label: qualityLabel(h), checked: player.fixedHeight === h, run: () => player.setQuality(h) });
    const s = state.stream;
    if (s?.degraded) {
      // Höhere Qualität hat YouTube gerade gesperrt – nicht so tun, als gäbe es sie
      items.push({ note: `Höhere Qualität sperrt YouTube gerade${s.kind === 'progressive' ? ` – läuft als ${qualityLabel(s.maxHeight)}-Datei` : ''}.` });
      if (!state.account?.loggedIn) items.push({ label: 'Mit Google anmelden für bessere Qualität', icon: 'account', run: () => signIn() });
      // Was jeder YouTube-Zugang geliefert hat – hilft bei der Fehlersuche
      if (s.attempts?.length) items.push({ note: s.attempts.join('\n'), small: true });
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
    const f = fraction(e);
    tip.hidden = false;
    tip.textContent = durationMs(f * total());
    tip.style.left = f * 100 + '%';
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
      tip.hidden = false;
      tip.textContent = durationMs(f * total());
      tip.style.left = f * 100 + '%';
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

function renderTime() {
  const label = $('timeLabel');
  if (!state.video) return;
  if (player.isLive) {
    label.replaceChildren(el('span', 'live', 'LIVE'));
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
  if (status === 'paused' || status === 'ended' || status === 'error') $('controls').classList.add('show');
  else showControls();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : status === 'paused' ? 'paused' : 'none';
}

const currentChannelId = () => state.video?.channelId || (state.details?.id === state.video?.id ? state.details?.channelId : null) || null;

function renderTitle() {
  const v = state.video;
  $('vTitle').textContent = v?.title || '';
  $('vChannel').textContent = v?.channelName || '';
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
  if (!d) return;
  for (const s of state.segments) {
    const div = el('div');
    div.style.left = (s.startMs / d) * 100 + '%';
    div.style.width = Math.max(0.2, ((s.endMs - s.startMs) / d) * 100) + '%';
    div.title = s.label;
    box.append(div);
  }
}
video.addEventListener('durationchange', renderSegments);

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
    img.src = v.thumbnail || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`;
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
    text.append(el('div', 'q-title', v.title), el('div', 'q-meta', [v.channelName, v.durationSec > 0 ? duration(v.durationSec) : ''].filter(Boolean).join(' • ')));
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
    artwork: [{ src: v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`, sizes: '480x360' }],
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

// ------------------------------------------------------------------ Tastatur

function bindKeys() {
  bindMediaKeys();
  document.addEventListener('keydown', (e) => {
    if (!$('signInDialog').hidden) {
      if (e.key === 'Escape') closeSignInDialog();
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
    if (key === 'sponsorBlock') renderSettings();
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
  }

  f.append(el('h3', null, 'Google-Konto'));
  f.append(accountRow());

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

  const about = el('p', 'hint', `GX Tube Desktop ${info.version} – werbefrei über YouTube.js, nicht mit YouTube oder Google verbunden.`);
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

// ------------------------------------------------------------------ Hinweise

function toast(text) {
  const t = el('div', 'toast', text);
  $('toasts').append(t);
  setTimeout(() => t.classList.add('out'), 3000);
  setTimeout(() => t.remove(), 3400);
  while ($('toasts').children.length > 3) $('toasts').firstElementChild.remove();
}

boot().catch((err) => {
  console.error(err);
  toast('Start fehlgeschlagen: ' + cleanError(err));
});
