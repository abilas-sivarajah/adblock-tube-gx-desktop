// Twitch-Seiten von GX Tube Desktop – aufgebaut wie twitch.tv: Seitenleiste mit gefolgten und
// empfohlenen Kanälen, oben "Startseite | Folge ich | Durchsuchen", Kanalseite mit Reitern.
// Der Player ist derselbe wie für YouTube (app.js), der Chat steckt in twitch-chat.js.

import { icon } from './icons.js';
import { count, duration, el, relativeTime } from './format.js';

const gx = window.gx;
const $ = (id) => document.getElementById(id);

let ctx = null; // aus app.js: { state, toast, showView, setWatch, openMenu, closeMenu, cleanError, history }

const tw = {
  account: { loggedIn: false },
  follows: [], // { login, userId, name, avatar }
  home: { data: null, loadedAt: 0, language: null, loading: null },
  followed: { list: [], loadedAt: 0, loading: null },
  category: null, // { name, items, shown, loading }
  channel: null, // { login, data, next, loading, tab }
  browse: { tab: 'categories', games: null, streams: null, language: null, shown: 0 },
  search: { query: '', seq: 0 },
  prevView: 'twhome',
};

// Wie viele Karten auf einmal dazukommen ("Mehr anzeigen" / beim Scrollen)
const STEP = 24;

export function init(context) {
  ctx = context;
  bindScroll('view-twcategory', () => moreCategory());
  bindScroll('view-twchannel', () => loadMoreChannel());
  bindScroll('view-twbrowse', () => moreBrowse());
  gx.onTwitchAccount((a) => {
    tw.account = a;
    renderAccount();
  });
  gx.onTwitchFollows((list) => {
    tw.follows = list;
    tw.followed.loadedAt = 0; // neu laden – jemand kam dazu oder fiel weg
    renderFollowButtons();
  });
  gx.onTwitchLogin(onLoginResult);
  $('twitchDialog').addEventListener('click', (e) => {
    if (e.target === $('twitchDialog')) closeLoginDialog();
  });
  for (const b of $('twTabs').querySelectorAll('button')) b.addEventListener('click', () => openView(b.dataset.tw));
  sidebar.collapsed = readCollapsed();
  // Live-Status in der Seitenleiste aktuell halten (wie twitch.tv)
  setInterval(() => {
    if (ctx.state.platform === 'twitch' && !document.hidden) renderSidebar({ refresh: true });
  }, 2 * 60 * 1000);
  return Promise.all([gx.twitchStatus(), gx.twitchFollows()]).then(([a, f]) => {
    tw.account = a;
    tw.follows = f;
  });
}

export const account = () => tw.account;

function bindScroll(id, more) {
  $(id).addEventListener('scroll', (e) => {
    const v = e.currentTarget;
    if (v.scrollTop + v.clientHeight > v.scrollHeight - 800) more();
  });
}

function openView(name) {
  const cur = ctx.state.view;
  if (cur !== name && cur !== 'settings') tw.prevView = cur;
  ctx.showView(name);
}

function back() {
  ctx.showView(tw.prevView && tw.prevView !== ctx.state.view ? tw.prevView : 'twhome');
}

/** Von app.js bei jedem Seitenwechsel: Reiter oben markieren, Seite füllen. */
export function onShow(name) {
  const tab = { twhome: 'twhome', twfollowing: 'twfollowing', twbrowse: 'twbrowse', twcategory: 'twbrowse' }[name] ?? null;
  for (const b of $('twTabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tw === tab);
  if (name === 'twhome') renderHome();
  if (name === 'twfollowing') renderFollowing();
  if (name === 'twbrowse') renderBrowse();
}

/** Twitch an/aus (Umschalter oben links): Seitenleiste und Reiter zeigen. */
export function onPlatform(on) {
  $('twTabs').hidden = !on;
  $('twSidebar').hidden = !on;
  document.body.classList.toggle('tw-side-collapsed', on && sidebar.collapsed);
  if (on) renderSidebar();
}

const language = () => ctx.state.settings?.twitchLanguage ?? 'de';
const LANGUAGES = [
  ['de', 'Deutsch'],
  ['en', 'Englisch'],
  ['', 'Alle Sprachen'],
];

function languageChips(onChange) {
  const box = el('div', 'tw-chips');
  for (const [value, label] of LANGUAGES) {
    const b = el('button', 'tw-chip' + (language() === value ? ' active' : ''), label);
    b.addEventListener('click', async () => {
      if (language() === value) return;
      ctx.state.settings = await gx.setSettings({ twitchLanguage: value });
      onChange();
    });
    box.append(b);
  }
  return box;
}

/** Reiter wie auf twitch.tv (unterstrichen in Lila). */
function pageTabs(box, tabs, active, onPick) {
  box.replaceChildren(
    ...tabs.map(([key, label]) => {
      const b = el('button', 'tw-page-tab' + (key === active ? ' active' : ''), label);
      b.addEventListener('click', () => key !== active && onPick(key));
      return b;
    }),
  );
}

/** Trennlinie mit "Mehr anzeigen" in der Mitte (wie auf twitch.tv). */
function moreDivider(box, label, onClick) {
  const b = el('button', 'tw-more-btn');
  b.append(el('span', null, label), icon('chevronDown'));
  b.addEventListener('click', onClick);
  box.replaceChildren(b);
  box.hidden = false;
}

/** "12,3 Tsd." – kurz genug für die Seitenleiste. */
function shortCount(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',').replace(',0', '') + ' Mio.';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace('.', ',').replace(',0', '') + ' Tsd.';
  return String(n);
}

/** Seit wann live: "2:14 Std." */
function uptime(startedAt) {
  if (!startedAt) return '';
  const min = Math.max(0, Math.floor((Date.now() - startedAt) / 60000));
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')} Std.`;
}

// ------------------------------------------------------------------ Daten (mit kurzem Zwischenspeicher)

/** Startseiten-Daten (beliebte Streams, Kategorien) – teilen sich Startseite und Seitenleiste. */
async function homeData({ force = false } = {}) {
  const lang = language();
  const h = tw.home;
  const fresh = h.data && h.language === lang && Date.now() - h.loadedAt < 3 * 60 * 1000;
  if (fresh && !force) return h.data;
  if (h.loading && h.loadingLang === lang) return h.loading;
  h.loadingLang = lang;
  h.loading = gx
    .twitchHome(lang)
    .then((data) => {
      if (language() === lang) Object.assign(h, { data, loadedAt: Date.now(), language: lang });
      return data;
    })
    .finally(() => {
      h.loading = null;
    });
  return h.loading;
}

/** Gefolgte Kanäle mit Live-Status (live zuerst, nach Zuschauern). */
async function followedData({ force = false } = {}) {
  const f = tw.followed;
  if (!tw.follows.length) return [];
  if (!force && Date.now() - f.loadedAt < 60 * 1000) return f.list;
  f.loading ??= gx
    .twitchFollowed()
    .then((list) => {
      f.list = list;
      f.loadedAt = Date.now();
      return list;
    })
    .finally(() => {
      f.loading = null;
    });
  return f.loading;
}

// ------------------------------------------------------------------ Karten

/** Für den Player (Hauptprozess prüft und kürzt). */
export function ref(v) {
  return { id: v.id, title: v.title ?? '', channelName: v.channelName ?? '', channelLogin: v.channelLogin ?? null, thumbnail: v.thumbnail ?? null, durationSec: v.durationSec ?? -1, isLive: Boolean(v.isLive) };
}

function play(v) {
  gx.play(ref(v), null);
  ctx.setWatch('full');
}

function cardMenu(button, v) {
  const items = [
    { icon: 'playNext', label: 'Als Nächstes abspielen', run: () => gx.add(ref(v), true) },
    { icon: 'addQueue', label: 'Zur Warteschlange hinzufügen', run: () => gx.add(ref(v), false) },
  ];
  if (v.channelLogin) {
    items.push({ icon: 'account', label: `Zum Kanal „${v.channelName || v.channelLogin}“`, run: () => openChannel(v.channelLogin, v.channelName) });
    const following = isFollowing(v.channelLogin);
    items.push({ icon: following ? 'heart' : 'heartOutline', label: following ? 'Nicht mehr folgen' : 'Folgen', run: () => toggleFollow({ login: v.channelLogin, userId: v.channelUserId ?? null, name: v.channelName, avatar: v.avatar ?? null }) });
  }
  if (v.game?.name) items.push({ icon: 'search', label: `Mehr aus „${v.game.displayName}“`, run: () => openCategory(v.game.name) });
  items.push({ icon: 'open', label: 'Auf twitch.tv öffnen', run: () => gx.openExternal(v.vod ? `https://www.twitch.tv/videos/${v.vod}` : `https://www.twitch.tv/${v.channelLogin}`) });
  ctx.openMenu(button, items);
}

function liveThumbSrc(v) {
  // Live-Vorschau ändert sich laufend – nicht ewig aus dem Zwischenspeicher
  return v.isLive && v.thumbnail ? `${v.thumbnail}${v.thumbnail.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / 300000)}` : v.thumbnail || '';
}

/** Karte für einen Live-Stream oder ein VOD – wie auf twitch.tv. */
export function streamCard(v, { progress = null, showChannel = true } = {}) {
  const card = el('div', 'card tw-card');
  card.dataset.id = v.id;
  const thumb = el('div', 'thumb');
  const img = el('img');
  img.loading = 'lazy';
  img.alt = '';
  img.src = liveThumbSrc(v);
  img.addEventListener('error', () => img.classList.add('broken'), { once: true });
  thumb.append(img);
  if (v.isLive) {
    thumb.append(el('span', 'tw-live', 'LIVE'));
    if (v.viewers) thumb.append(el('span', 'tw-viewers', `${count(v.viewers)} Zuschauer`));
  } else {
    if (v.durationSec > 0) thumb.append(el('span', 'tw-duration', duration(v.durationSec)));
    const meta = [v.views ? `${count(v.views)} Aufrufe` : null, v.publishedAt ? relativeTime(v.publishedAt) : null].filter(Boolean).join(' · ');
    if (meta) thumb.append(el('span', 'tw-viewers', meta));
  }
  if (progress != null) {
    const bar = el('div', 'progress');
    const fill = el('div');
    fill.style.width = Math.min(100, Math.max(0, progress * 100)) + '%';
    bar.append(fill);
    thumb.append(bar);
  }
  const body = el('div', 'card-body');
  if (showChannel && v.avatar) {
    const av = el('img', 'tw-avatar');
    av.src = v.avatar;
    av.alt = '';
    av.loading = 'lazy';
    av.title = v.channelName;
    av.addEventListener('click', (e) => {
      e.stopPropagation();
      openChannel(v.channelLogin, v.channelName);
    });
    body.append(av);
  }
  const text = el('div', 'card-text');
  const title = el('div', 'card-title tw-title', v.title || (v.isLive ? `${v.channelName} ist live` : 'Video'));
  title.title = v.title || '';
  text.append(title);
  if (showChannel && v.channelName) {
    const name = el('div', 'card-meta card-channel', v.channelName);
    name.title = 'Zum Kanal';
    name.addEventListener('click', (e) => {
      e.stopPropagation();
      openChannel(v.channelLogin, v.channelName);
    });
    text.append(name);
  }
  if (v.game?.displayName) {
    const g = el('div', 'card-meta tw-game', v.game.displayName);
    g.title = 'Kategorie öffnen';
    g.addEventListener('click', (e) => {
      e.stopPropagation();
      openCategory(v.game.name);
    });
    text.append(g);
  }
  if (v.tags?.length) {
    const tags = el('div', 'tw-tags');
    for (const t of v.tags.slice(0, 3)) tags.append(el('span', 'tw-tag', t));
    text.append(tags);
  }
  const more = el('button', 'icon-btn card-menu');
  more.title = 'Mehr';
  more.append(icon('more'));
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    cardMenu(more, v);
  });
  body.append(text, more);
  card.append(thumb, body);
  card.addEventListener('click', () => play(v));
  return card;
}

function gameCard(g) {
  const card = el('div', 'tw-game-card');
  const art = el('div', 'tw-game-art');
  const img = el('img');
  img.loading = 'lazy';
  img.alt = '';
  img.src = g.boxArt || '';
  art.append(img);
  card.append(art, el('div', 'tw-game-name', g.displayName));
  if (g.viewers) card.append(el('div', 'card-meta', `${count(g.viewers)} Zuschauer`));
  card.title = g.displayName;
  card.addEventListener('click', () => openCategory(g.name));
  return card;
}

/** Kanal in der Suche: rundes Bild, Name, Follower, live oder nicht. */
function channelRow(c) {
  const card = el('div', 'tw-channel-row');
  const av = el('div', 'tw-row-avatar' + (c.live ? ' live' : ''));
  const img = el('img');
  img.src = c.avatar || '';
  img.alt = '';
  av.append(img);
  if (c.live) av.append(el('span', 'tw-live small', 'LIVE'));
  const text = el('div', 'card-text');
  text.append(el('div', 'card-title', c.name));
  const meta = [c.followers != null ? `${count(c.followers)} Follower` : null, c.live ? `${count(c.live.viewers)} Zuschauer` : null, c.live?.game?.displayName].filter(Boolean).join(' · ');
  text.append(el('div', 'card-meta', meta || 'Kanal'));
  if (c.live?.title) text.append(el('div', 'card-meta', c.live.title));
  card.append(av, text);
  if (c.live) {
    const watch = el('button', 'pill small tw-watch', 'Ansehen');
    watch.addEventListener('click', (e) => {
      e.stopPropagation();
      play(c.live);
    });
    card.append(watch);
  }
  card.append(followButton(c));
  card.addEventListener('click', () => openChannel(c.login, c.name));
  return card;
}

/** Kachel für einen gefolgten Kanal (Folge ich → Alle Kanäle). */
function channelTile(c) {
  const tile = el('div', 'tw-channel-tile' + (c.live ? ' live' : ''));
  const img = el('img');
  img.src = c.avatar || '';
  img.alt = '';
  img.loading = 'lazy';
  tile.append(img, el('div', 'tw-tile-name', c.name));
  tile.append(el('div', 'card-meta', c.live ? `🔴 ${c.live.game?.displayName || 'Live'}` : 'Offline'));
  tile.title = c.live?.title || c.name;
  tile.addEventListener('click', () => (c.live ? play(c.live) : openChannel(c.login, c.name)));
  return tile;
}

// ------------------------------------------------------------------ Folgen

const isFollowing = (login) => tw.follows.some((f) => f.login === login);

/** Folgen-Knopf; bleibt über data-follow aktuell. */
export function followButton(c) {
  const btn = el('button');
  btn.dataset.follow = c.login;
  fillFollowButton(btn);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFollow(c, btn);
  });
  return btn;
}

async function toggleFollow(c, btn = null) {
  const on = !isFollowing(c.login);
  if (btn) btn.disabled = true;
  try {
    const r = await gx.twitchSetFollow({ login: c.login, userId: c.userId ?? null, name: c.name || c.login, avatar: c.avatar ?? null }, on);
    const name = c.name || c.login;
    if (on) ctx.toast(r.synced ? `Du folgst ${name}` : tw.account.loggedIn ? `Du folgst ${name} – nur auf diesem PC (Twitch: ${r.error})` : `Du folgst ${name} (auf diesem PC). Mit Twitch angemeldet landet es auch in deinem Konto.`);
    else ctx.toast(r.synced || !tw.account.loggedIn ? `Du folgst ${name} nicht mehr` : `Auf diesem PC entfolgt (Twitch: ${r.error})`);
  } catch (err) {
    ctx.toast('Folgen fehlgeschlagen: ' + ctx.cleanError(err));
  } finally {
    if (btn) btn.disabled = false;
    renderFollowButtons();
  }
}

function fillFollowButton(btn) {
  const on = isFollowing(btn.dataset.follow);
  btn.className = on ? 'pill ghost sub-btn tw-follow' : 'pill sub-btn tw-follow';
  btn.replaceChildren(icon(on ? 'heart' : 'heartOutline'), el('span', null, on ? 'Folge ich' : 'Folgen'));
  btn.title = on ? 'Nicht mehr folgen' : 'Kanal folgen';
}

function renderFollowButtons() {
  for (const btn of document.querySelectorAll('[data-follow]')) fillFollowButton(btn);
  if (ctx?.state.platform === 'twitch') renderSidebar({ refresh: true });
  if (ctx?.state.view === 'twhome') renderFollowed();
  if (ctx?.state.view === 'twfollowing') renderFollowing();
}

// ------------------------------------------------------------------ Seitenleiste

const sidebar = { collapsed: false, showAll: false, seq: 0 };
const SIDE_FOLLOWED = 10;

function readCollapsed() {
  try {
    return localStorage.getItem('twSidebarCollapsed') === '1';
  } catch {
    return false;
  }
}

function setCollapsed(on) {
  sidebar.collapsed = on;
  try {
    localStorage.setItem('twSidebarCollapsed', on ? '1' : '0');
  } catch {
    // egal – dann nur bis zum Neustart
  }
  document.body.classList.toggle('tw-side-collapsed', on);
  renderSidebar();
}

/** Eine Zeile der Seitenleiste: Bild, Name, Kategorie, roter Punkt mit Zuschauern (oder "Offline"). */
function sideRow(c) {
  const live = c.live;
  const row = el('div', 'tw-side-row' + (live ? '' : ' offline'));
  row.title = live ? `${c.name} · ${live.game?.displayName ?? ''}\n${live.title ?? ''}` : `${c.name} (offline)`;
  const av = el('div', 'tw-side-avatar');
  const img = el('img');
  img.src = c.avatar || '';
  img.alt = '';
  img.loading = 'lazy';
  av.append(img);
  if (live) av.append(el('span', 'tw-side-dot'));
  const text = el('div', 'tw-side-text');
  text.append(el('b', null, c.name), el('span', null, live ? live.game?.displayName || 'Live' : 'Offline'));
  const right = el('div', 'tw-side-viewers');
  if (live) right.append(el('i'), document.createTextNode(shortCount(live.viewers)));
  row.append(av, text, right);
  row.addEventListener('click', () => (live ? play(live) : openChannel(c.login, c.name)));
  return row;
}

function sideHead(text) {
  return el('div', 'tw-side-head', text);
}

export async function renderSidebar({ refresh = false } = {}) {
  const box = $('twSidebar');
  if (!box || ctx.state.platform !== 'twitch') return;
  const seq = ++sidebar.seq;
  const [followed, home] = await Promise.all([followedData({ force: refresh }).catch(() => tw.followed.list), homeData().catch(() => null)]);
  if (seq !== sidebar.seq) return;

  const toggle = el('button', 'icon-btn tw-side-toggle');
  toggle.title = sidebar.collapsed ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen';
  toggle.append(icon(sidebar.collapsed ? 'chevronRight' : 'chevronLeft'));
  toggle.addEventListener('click', () => setCollapsed(!sidebar.collapsed));
  const top = el('div', 'tw-side-top');
  if (!sidebar.collapsed) top.append(el('span', null, 'Für dich'));
  top.append(toggle);
  const parts = [top];

  if (followed.length) {
    parts.push(sideHead(sidebar.collapsed ? '♥' : 'Kanäle, denen du folgst'));
    const list = sidebar.showAll ? followed : followed.slice(0, SIDE_FOLLOWED);
    parts.push(...list.map(sideRow));
    if (followed.length > SIDE_FOLLOWED && !sidebar.collapsed) {
      const more = el('button', 'tw-side-more', sidebar.showAll ? 'Weniger anzeigen' : 'Mehr anzeigen');
      more.addEventListener('click', () => {
        sidebar.showAll = !sidebar.showAll;
        renderSidebar();
      });
      parts.push(more);
    }
  }
  // Empfohlen: beliebte Streams, denen du noch nicht folgst
  const followedLogins = new Set(followed.map((c) => c.login));
  const reco = (home?.streams ?? []).filter((v) => !followedLogins.has(v.channelLogin)).slice(0, followed.length ? 6 : 12);
  if (reco.length) {
    parts.push(sideHead(sidebar.collapsed ? '★' : 'Empfohlene Kanäle'));
    parts.push(...reco.map((v) => sideRow({ login: v.channelLogin, name: v.channelName, avatar: v.avatar, live: v })));
  }
  if (!followed.length && !sidebar.collapsed) {
    parts.push(el('p', 'tw-side-hint', 'Folge Kanälen, um hier zu sehen, wer gerade live ist.'));
  }
  box.replaceChildren(...parts);
}

// ------------------------------------------------------------------ Startseite

let homeSeq = 0;
let popularShown = 0;
let featuredIndex = 0;
let featuredTimer = null;

export async function renderHome({ force = false } = {}) {
  renderFollowed();
  renderContinue();
  const seq = ++homeSeq;
  const lang = language();
  $('twHomeStatus').textContent = $('twPopularGrid').childElementCount && !force ? '' : 'Lädt …';
  $('twPopularHead').replaceChildren(el('h2', null, lang === 'de' ? 'Live-Kanäle, die wir dir empfehlen – auf Deutsch' : lang === 'en' ? 'Live-Kanäle, die wir dir empfehlen – auf Englisch' : 'Live-Kanäle, die wir dir empfehlen'), languageChips(() => renderHome({ force: true }).then(() => renderSidebar())));
  try {
    const h = await homeData({ force });
    if (seq !== homeSeq) return;
    renderFeatured(h.streams.slice(0, 6));
    popularShown = 0;
    $('twPopularGrid').replaceChildren();
    showMorePopular(h.streams, 12);
    $('twGamesGrid').replaceChildren(...h.games.slice(0, 12).map(gameCard));
    moreDivider($('twGamesMore'), 'Alle Kategorien', () => openView('twbrowse'));
    // Weltweit: nur was nicht schon oben steht
    const shown = new Set(h.streams.map((v) => v.id));
    const top = h.top.filter((v) => !shown.has(v.id));
    $('twShelfTop').hidden = lang === '' || top.length === 0;
    $('twTopGrid').replaceChildren(...top.slice(0, 8).map((v) => streamCard(v)));
    $('twHomeStatus').textContent = h.streams.length ? '' : 'Gerade keine Streams in dieser Sprache';
  } catch (err) {
    if (seq === homeSeq) $('twHomeStatus').textContent = 'Twitch konnte nicht geladen werden: ' + ctx.cleanError(err);
  }
}

function showMorePopular(list, n = STEP) {
  const next = list.slice(popularShown, popularShown + n);
  popularShown += next.length;
  $('twPopularGrid').append(...next.map((v) => streamCard(v)));
  if (popularShown < list.length) moreDivider($('twPopularMore'), 'Mehr anzeigen', () => showMorePopular(list));
  else $('twPopularMore').hidden = true;
}

/** Großes Titelbild oben (Karussell durch die beliebtesten Streams, wie auf twitch.tv). */
function renderFeatured(list) {
  const box = $('twFeatured');
  clearInterval(featuredTimer);
  if (!list.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  featuredIndex = Math.min(featuredIndex, list.length - 1);
  const draw = () => {
    const v = list[featuredIndex];
    const stage = el('div', 'tw-featured-stage');
    const img = el('img');
    img.src = liveThumbSrc({ ...v, thumbnail: v.thumbnail?.replace(/-\d+x\d+(\.\w+)$/, '-880x496$1') ?? v.thumbnail });
    img.alt = '';
    img.addEventListener('error', () => (img.src = liveThumbSrc(v)), { once: true });
    stage.append(img, el('span', 'tw-live', 'LIVE'));
    stage.addEventListener('click', () => play(v));
    const play1 = el('div', 'tw-featured-play');
    play1.append(icon('play'));
    stage.append(play1);

    const info = el('div', 'tw-featured-info');
    const who = el('div', 'tw-featured-who');
    const av = el('img', 'tw-avatar');
    av.src = v.avatar || '';
    av.alt = '';
    const names = el('div');
    const ch = el('b', 'card-channel', v.channelName);
    ch.addEventListener('click', () => openChannel(v.channelLogin, v.channelName));
    names.append(ch);
    if (v.game?.displayName) {
      const g = el('div', 'tw-game', v.game.displayName);
      g.addEventListener('click', () => openCategory(v.game.name));
      names.append(g);
    }
    names.append(el('div', 'card-meta', `${count(v.viewers)} Zuschauer · seit ${uptime(v.startedAt)}`));
    who.append(av, names);
    info.append(who);
    if (v.tags?.length) {
      const tags = el('div', 'tw-tags');
      for (const t of v.tags.slice(0, 4)) tags.append(el('span', 'tw-tag', t));
      info.append(tags);
    }
    info.append(el('p', 'tw-featured-title', v.title));
    const actions = el('div', 'tw-featured-actions');
    const watch = el('button', 'pill tw-watch', 'Jetzt ansehen');
    watch.addEventListener('click', () => play(v));
    actions.append(watch, followButton({ login: v.channelLogin, userId: v.channelUserId, name: v.channelName, avatar: v.avatar }));
    info.append(actions);

    const prev = el('button', 'icon-btn tw-featured-nav prev');
    prev.title = 'Vorheriger';
    prev.append(icon('chevronLeft'));
    prev.addEventListener('click', () => step(-1));
    const next = el('button', 'icon-btn tw-featured-nav next');
    next.title = 'Nächster';
    next.append(icon('chevronRight'));
    next.addEventListener('click', () => step(1));
    const dots = el('div', 'tw-featured-dots');
    list.forEach((_, i) => {
      const d = el('button', i === featuredIndex ? 'active' : '');
      d.title = list[i].channelName;
      d.addEventListener('click', () => {
        featuredIndex = i;
        draw();
      });
      dots.append(d);
    });
    box.replaceChildren(prev, stage, info, next, dots);
  };
  const step = (d) => {
    featuredIndex = (featuredIndex + d + list.length) % list.length;
    draw();
  };
  draw();
  // Weiterblättern, solange die Maus nicht darauf liegt und die Startseite zu sehen ist
  featuredTimer = setInterval(() => {
    if (ctx.state.view === 'twhome' && !box.matches(':hover') && ctx.state.watch !== 'full' && !document.hidden) step(1);
  }, 9000);
}

let followedSeq = 0;
const FOLLOWED_ROW = 4;

/** "Live-Kanäle, denen du folgst" – eine Reihe, "Mehr anzeigen" für den Rest. */
async function renderFollowed() {
  const shelf = $('twShelfFollowed');
  if (!tw.follows.length) {
    shelf.hidden = true;
    return;
  }
  const seq = ++followedSeq;
  if (!$('twFollowedGrid').childElementCount) $('twFollowedHint').textContent = 'Lädt …';
  try {
    const list = await followedData();
    if (seq !== followedSeq) return;
    const live = list.filter((c) => c.live);
    shelf.hidden = live.length === 0;
    $('twFollowedGrid').replaceChildren(...live.slice(0, FOLLOWED_ROW).map((c) => streamCard(c.live)));
    $('twFollowedHint').textContent = `${live.length} live`;
    if (live.length > FOLLOWED_ROW) {
      moreDivider($('twFollowedMore'), 'Mehr anzeigen', () => {
        $('twFollowedGrid').replaceChildren(...live.map((c) => streamCard(c.live)));
        $('twFollowedMore').hidden = true;
      });
    } else $('twFollowedMore').hidden = true;
  } catch {
    if (seq === followedSeq) $('twFollowedHint').textContent = 'Konnte nicht geladen werden';
  }
}

async function continueVods() {
  const lib = await gx.library();
  return lib.history.filter((h) => h.video.id.startsWith('twitch-vod:') && h.durationMs > 0 && h.positionMs > 5000 && h.positionMs < h.durationMs - 15000).slice(0, 20);
}

async function renderContinue() {
  const cont = await continueVods();
  $('twShelfContinue').hidden = cont.length === 0;
  $('twContinueRow').replaceChildren(...cont.map((h) => streamCard({ ...h.video, vod: h.video.id.slice(11) }, { progress: h.positionMs / h.durationMs })));
}

// ------------------------------------------------------------------ Folge ich

let followingTab = 'overview';
let followingSeq = 0;

export async function renderFollowing() {
  const seq = ++followingSeq;
  pageTabs($('twFollowingTabs'), [['overview', 'Übersicht'], ['live', 'Live'], ['channels', 'Kanäle']], followingTab, (t) => {
    followingTab = t;
    renderFollowing();
  });
  const body = $('twFollowingBody');
  if (!tw.follows.length) {
    body.replaceChildren();
    $('twFollowingStatus').textContent = 'Du folgst noch niemandem. Such oben nach einem Kanal und tippe auf „Folgen“ – oder melde dich in den Einstellungen bei Twitch an, dann kommen deine gefolgten Kanäle von dort.';
    return;
  }
  $('twFollowingStatus').textContent = body.childElementCount ? '' : 'Lädt …';
  try {
    const [list, cont] = await Promise.all([followedData(), continueVods()]);
    if (seq !== followingSeq) return;
    const live = list.filter((c) => c.live);
    const parts = [];
    const shelf = (title, hint, content) => {
      const s = el('div', 'shelf');
      const head = el('div', 'shelf-head');
      head.append(el('h2', null, title));
      if (hint) head.append(el('span', 'hint', hint));
      s.append(head, content);
      return s;
    };
    if (followingTab !== 'channels') {
      const grid = el('div', 'grid tw-grid');
      grid.append(...live.map((c) => streamCard(c.live)));
      parts.push(shelf('Live-Kanäle', live.length ? `${live.length} live` : 'Gerade ist niemand live', grid));
    }
    if (followingTab === 'overview' && cont.length) {
      const row = el('div', 'row-scroll');
      row.append(...cont.map((h) => streamCard({ ...h.video, vod: h.video.id.slice(11) }, { progress: h.positionMs / h.durationMs })));
      parts.push(shelf('Weiter ansehen', null, row));
    }
    if (followingTab !== 'live') {
      const tiles = el('div', 'tw-tiles');
      const sorted = [...list].sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || a.name.localeCompare(b.name, 'de'));
      tiles.append(...sorted.map(channelTile));
      parts.push(shelf('Alle Kanäle, denen du folgst', `${list.length}`, tiles));
    }
    body.replaceChildren(...parts);
    $('twFollowingStatus').textContent = '';
  } catch (err) {
    if (seq === followingSeq) $('twFollowingStatus').textContent = 'Konnte nicht geladen werden: ' + ctx.cleanError(err);
  }
}

// ------------------------------------------------------------------ Durchsuchen

let browseSeq = 0;

export async function renderBrowse() {
  const b = tw.browse;
  const seq = ++browseSeq;
  pageTabs($('twBrowseTabs'), [['categories', 'Kategorien'], ['live', 'Live-Kanäle']], b.tab, (t) => {
    b.tab = t;
    $('view-twbrowse').scrollTop = 0;
    renderBrowse();
  });
  const grid = $('twBrowseGrid');
  $('twBrowseBar').replaceChildren(...(b.tab === 'live' ? [languageChips(() => renderBrowse())] : []));
  grid.className = b.tab === 'live' ? 'grid tw-grid' : 'tw-games';
  grid.replaceChildren();
  b.shown = 0;
  $('twBrowseStatus').textContent = 'Lädt …';
  try {
    if (b.tab === 'categories') {
      b.games ??= (await gx.twitchGames()).items;
    } else if (!b.streams || b.language !== language()) {
      const lang = language();
      b.streams = (await gx.twitchStreams(lang)).items;
      b.language = lang;
    }
    if (seq !== browseSeq) return;
    $('twBrowseStatus').textContent = '';
    moreBrowse(48);
  } catch (err) {
    if (seq === browseSeq) $('twBrowseStatus').textContent = 'Konnte nicht geladen werden: ' + ctx.cleanError(err);
  }
}

/** Weitere Karten anhängen (beim Scrollen) – alles ist schon geladen, nur noch nicht gezeigt. */
function moreBrowse(n = STEP) {
  const b = tw.browse;
  const list = b.tab === 'categories' ? b.games : b.streams;
  if (!list || ctx.state.view !== 'twbrowse' || b.shown >= list.length) return;
  const next = list.slice(b.shown, b.shown + n);
  b.shown += next.length;
  $('twBrowseGrid').append(...next.map((x) => (b.tab === 'categories' ? gameCard(x) : streamCard(x))));
}

// ------------------------------------------------------------------ Suche

export async function search(q) {
  if (ctx.state.watch === 'full') ctx.setWatch('mini');
  openView('twsearch');
  const seq = ++tw.search.seq;
  tw.search.query = q;
  $('twSearchGames').replaceChildren();
  $('twSearchChannels').replaceChildren();
  $('twSearchGamesHead').hidden = true;
  $('twSearchChannelsHead').hidden = true;
  $('twSearchStatus').textContent = 'Suche läuft …';
  $('view-twsearch').scrollTop = 0;
  try {
    const res = await gx.twitchSearch(q);
    if (seq !== tw.search.seq) return;
    $('twSearchGamesHead').hidden = res.games.length === 0;
    $('twSearchGames').replaceChildren(...res.games.map(gameCard));
    $('twSearchChannelsHead').hidden = res.channels.length === 0;
    $('twSearchChannels').replaceChildren(...res.channels.map(channelRow));
    $('twSearchStatus').textContent = res.channels.length || res.games.length ? '' : 'Keine Ergebnisse';
  } catch (err) {
    if (seq === tw.search.seq) $('twSearchStatus').textContent = 'Suche fehlgeschlagen: ' + ctx.cleanError(err);
  }
}

// ------------------------------------------------------------------ Kategorie

let categorySeq = 0;

export async function openCategory(name) {
  if (!name) return;
  ctx.closeMenu();
  if (ctx.state.watch === 'full') ctx.setWatch('mini');
  openView('twcategory');
  const seq = ++categorySeq;
  tw.category = { name, items: [], shown: 0, game: null };
  renderCategoryHead();
  pageTabs($('twCategoryTabs'), [['live', 'Live-Kanäle']], 'live', () => {});
  $('twCategoryGrid').replaceChildren();
  $('twCategoryStatus').textContent = 'Lädt …';
  $('view-twcategory').scrollTop = 0;
  try {
    const res = await gx.twitchCategory(name, language(), null);
    if (seq !== categorySeq) return;
    tw.category.game = res.game;
    tw.category.items = res.items;
    renderCategoryHead();
    moreCategory(36);
    $('twCategoryStatus').textContent = res.items.length ? '' : language() ? 'Gerade keine Streams in dieser Sprache' : 'Gerade keine Streams';
  } catch (err) {
    if (seq === categorySeq) $('twCategoryStatus').textContent = 'Kategorie konnte nicht geladen werden: ' + ctx.cleanError(err);
  }
}

/** Kategorie lädt bis zu 100 Streams auf einmal (Twitch lässt nicht weiterblättern) – hier nach und nach zeigen. */
function moreCategory(n = STEP) {
  const c = tw.category;
  if (!c || ctx.state.view !== 'twcategory' || c.shown >= c.items.length) return;
  const next = c.items.slice(c.shown, c.shown + n);
  c.shown += next.length;
  $('twCategoryGrid').append(...next.map((v) => streamCard(v)));
}

function renderCategoryHead() {
  const c = tw.category;
  const head = $('twCategoryHead');
  const backBtn = el('button', 'icon-btn');
  backBtn.title = 'Zurück';
  backBtn.append(icon('back'));
  backBtn.addEventListener('click', back);
  const art = el('img', 'tw-category-art');
  art.alt = '';
  if (c.game?.boxArt) art.src = c.game.boxArt;
  const text = el('div', 'channel-text');
  text.append(el('h1', null, c.game?.displayName || c.name));
  if (c.game?.viewers) {
    const m = el('div', 'channel-meta tw-viewers-line');
    m.append(icon('people'), el('span', null, `${count(c.game.viewers)} Zuschauer`));
    text.append(m);
  }
  text.append(languageChips(() => openCategory(c.name)));
  head.replaceChildren(backBtn, art, text);
}

// ------------------------------------------------------------------ Kanal

let channelSeq = 0;

export async function openChannel(login, name = '') {
  if (!login) return;
  ctx.closeMenu();
  if (ctx.state.watch === 'full') ctx.setWatch('mini');
  openView('twchannel');
  const seq = ++channelSeq;
  tw.channel = { login, data: { login, name }, next: null, loading: true, tab: 'home' };
  renderChannel();
  $('twChannelStatus').textContent = 'Lädt …';
  $('view-twchannel').scrollTop = 0;
  try {
    const data = await gx.twitchChannel(login);
    if (seq !== channelSeq) return;
    tw.channel.data = data;
    tw.channel.next = data.next;
    // Erst als geladen markieren, dann zeichnen (sonst bleibt der Inhalt unter den Reitern leer)
    tw.channel.loading = false;
    $('twChannelStatus').textContent = '';
    renderChannel();
  } catch (err) {
    if (seq === channelSeq) $('twChannelStatus').textContent = 'Kanal konnte nicht geladen werden: ' + ctx.cleanError(err);
  } finally {
    if (seq === channelSeq) tw.channel.loading = false;
  }
}

async function loadMoreChannel() {
  const c = tw.channel;
  if (!c || c.loading || !c.next || c.tab !== 'videos') return;
  c.loading = true;
  const seq = channelSeq;
  try {
    const res = await gx.twitchChannelMore(c.login, c.next);
    if (seq !== channelSeq) return;
    c.data.items = [...(c.data.items ?? []), ...res.items];
    $('twChannelGrid').append(...res.items.map((v) => streamCard(v, { showChannel: false })));
    c.next = res.next;
  } catch {
    c.next = null;
  } finally {
    c.loading = false;
  }
}

/** Kanalseite wie auf twitch.tv: Banner, Kopf, Reiter Startseite | Videos | Info. */
function renderChannel() {
  const c = tw.channel;
  const d = c?.data;
  if (!d) return;
  renderChannelHead();
  const tabs = [['home', 'Startseite'], ['videos', 'Videos'], ['about', 'Info']];
  pageTabs($('twChannelTabs'), tabs, c.tab, (t) => {
    c.tab = t;
    renderChannel();
  });
  const body = $('twChannelBody');
  const grid = $('twChannelGrid');
  const items = d.items ?? [];
  body.replaceChildren();
  grid.replaceChildren();
  $('twChannelMore').hidden = true;
  if (c.loading) return;

  if (c.tab === 'home') {
    if (d.live) body.append(liveHero(d.live));
    else body.append(el('div', 'tw-offline-box', `${d.name || d.login} ist gerade offline.`));
    if (items.length) {
      const head = el('div', 'shelf-head');
      head.append(el('h2', null, 'Neueste Videos'));
      body.append(head);
      grid.append(...items.slice(0, 8).map((v) => streamCard(v, { showChannel: false })));
      if (items.length > 8) {
        moreDivider($('twChannelMore'), 'Alle Videos', () => {
          c.tab = 'videos';
          renderChannel();
        });
      }
    }
  }
  if (c.tab === 'videos') {
    grid.append(...items.map((v) => streamCard(v, { showChannel: false })));
    if (!items.length) $('twChannelStatus').textContent = 'Keine Videos (Twitch löscht vergangene Streams meist nach einigen Tagen)';
  }
  if (c.tab === 'about') {
    const box = el('div', 'tw-about');
    box.append(el('h2', null, `Über ${d.name || d.login}`));
    if (d.followers != null) box.append(el('p', 'tw-about-followers', `${count(d.followers)} Follower`));
    box.append(el('p', 'tw-about-desc', d.description || 'Keine Beschreibung.'));
    const link = el('button', 'pill small ghost', 'Auf twitch.tv öffnen');
    link.addEventListener('click', () => gx.openExternal(`https://www.twitch.tv/${d.login}`));
    box.append(link);
    body.append(box);
  }
  if (c.tab !== 'videos' && $('twChannelStatus').textContent.startsWith('Keine Videos')) $('twChannelStatus').textContent = '';
}

/** Laufender Stream groß auf der Kanalseite. */
function liveHero(v) {
  const box = el('div', 'tw-live-hero');
  const stage = el('div', 'tw-featured-stage');
  const img = el('img');
  img.src = liveThumbSrc({ ...v, thumbnail: v.thumbnail?.replace(/-\d+x\d+(\.\w+)$/, '-880x496$1') ?? v.thumbnail });
  img.alt = '';
  img.addEventListener('error', () => (img.src = liveThumbSrc(v)), { once: true });
  const p = el('div', 'tw-featured-play');
  p.append(icon('play'));
  stage.append(img, el('span', 'tw-live', 'LIVE'), p);
  stage.addEventListener('click', () => play(v));
  const info = el('div', 'tw-featured-info');
  info.append(el('p', 'tw-featured-title', v.title));
  if (v.game?.displayName) {
    const g = el('div', 'tw-game', v.game.displayName);
    g.addEventListener('click', () => openCategory(v.game.name));
    info.append(g);
  }
  info.append(el('div', 'card-meta', `${count(v.viewers)} Zuschauer · seit ${uptime(v.startedAt)}`));
  if (v.tags?.length) {
    const tags = el('div', 'tw-tags');
    for (const t of v.tags.slice(0, 5)) tags.append(el('span', 'tw-tag', t));
    info.append(tags);
  }
  const watch = el('button', 'pill tw-watch', 'Jetzt ansehen');
  watch.addEventListener('click', () => play(v));
  info.append(watch);
  box.append(stage, info);
  return box;
}

function renderChannelHead() {
  const d = tw.channel?.data;
  const head = $('twChannelHead');
  if (!d) return head.replaceChildren();
  const parts = [];
  const banner = el('div', 'tw-banner');
  if (d.banner) {
    const img = el('img');
    img.src = d.banner;
    img.alt = '';
    banner.append(img);
  }
  parts.push(banner);
  const backBtn = el('button', 'icon-btn channel-back');
  backBtn.title = 'Zurück';
  backBtn.append(icon('back'));
  backBtn.addEventListener('click', back);
  parts.push(backBtn);
  const info = el('div', 'tw-channel-info');
  const av = el('div', 'tw-row-avatar big' + (d.live ? ' live' : ''));
  const avatar = el('img');
  if (d.avatar) avatar.src = d.avatar;
  avatar.alt = '';
  av.append(avatar);
  if (d.live) av.append(el('span', 'tw-live small', 'LIVE'));
  const text = el('div', 'channel-text');
  text.append(el('h1', null, d.name || d.login));
  const meta = [d.followers != null ? `${count(d.followers)} Follower` : null, d.live ? `${count(d.live.viewers)} Zuschauer` : null].filter(Boolean).join(' · ');
  if (meta) text.append(el('div', 'channel-meta', meta));
  const actions = el('div', 'tw-channel-actions');
  if (d.live) {
    const watch = el('button', 'pill tw-watch', 'Ansehen');
    watch.addEventListener('click', () => play(d.live));
    actions.append(watch);
  }
  actions.append(followButton({ login: d.login, userId: d.userId ?? null, name: d.name, avatar: d.avatar }));
  info.append(av, text, actions);
  parts.push(info);
  head.replaceChildren(...parts);
}

// ------------------------------------------------------------------ Anmeldung

let windowOpen = false;
const dialog = { open: false, phase: null, info: null, message: null };
let dialogTimer = null;

export function accountText(a = tw.account) {
  if (a?.loggedIn) return 'Chat schreiben, Kanälen auch in deinem Twitch-Konto folgen, Streams nur für Abonnenten. Werbung blendet GX Tube trotzdem aus.';
  if (a?.expired) return 'Die Anmeldung ist abgelaufen oder wurde in den Twitch-Einstellungen getrennt. Melde dich neu an.';
  return 'Optional – zum Chatten, für deine gefolgten Kanäle und Streams nur für Abonnenten. Zuschauen und Chat lesen geht auch ohne.';
}

export function accountRow() {
  const row = el('div', 'set-row');
  row.id = 'twitchAccountRow';
  fillAccountRow(row);
  return row;
}

function fillAccountRow(row) {
  const a = tw.account;
  const label = el('div', 'label');
  label.append(el('b', null, a?.loggedIn ? `Angemeldet als ${a.name || a.login}` : a?.expired ? 'Anmeldung abgelaufen' : 'Nicht angemeldet'), el('span', null, accountText(a)));
  const buttons = el('div', 'buttons');
  if (a?.loggedIn) {
    const sync = el('button', 'pill small ghost', 'Gefolgte neu laden');
    sync.title = 'Die Kanäle, denen du bei Twitch folgst, hierher übernehmen';
    sync.addEventListener('click', async () => {
      sync.disabled = true;
      await gx.twitchSyncFollows().catch(() => {});
      sync.disabled = false;
    });
    buttons.append(sync);
    const out = el('button', 'pill small ghost', 'Abmelden');
    out.addEventListener('click', async () => {
      tw.account = await gx.twitchLogout();
      ctx.toast('Bei Twitch abgemeldet');
      renderAccount();
    });
    buttons.append(out);
  } else {
    const phone = el('button', 'pill small', a?.expired ? 'Neu anmelden (Handy)' : 'Mit dem Handy anmelden');
    phone.title = 'Der PC zeigt einen Code, den du auf dem Handy unter twitch.tv/activate eingibst – wie bei Twitch auf dem Fernseher';
    phone.addEventListener('click', () => openLoginDialog());
    const here = el('button', 'pill small ghost', 'Hier im Fenster');
    here.title = 'Twitch-Anmeldeseite hier am PC öffnen';
    here.addEventListener('click', () => openLoginDialog({ inWindow: true }));
    buttons.append(phone, here);
  }
  const parts = [];
  if (a?.loggedIn && a.avatar) {
    const img = el('img', 'account-photo');
    img.src = a.avatar;
    img.alt = '';
    parts.push(img);
  }
  row.replaceChildren(...parts, label, buttons);
}

export function renderAccount() {
  const row = $('twitchAccountRow');
  if (row) fillAccountRow(row);
  ctx?.onTwitchAccount?.(tw.account);
}

/** Anmelden: Code zeigen (twitch.tv/activate auf dem Handy) – oder gleich die Seite im Fenster öffnen. */
export async function openLoginDialog({ inWindow = false } = {}) {
  ctx.closeMenu();
  if (!dialog.open) {
    dialog.open = true;
    dialog.phase = 'loading';
    renderDialog();
  }
  try {
    dialog.info = await gx.twitchLoginStart(inWindow);
    windowOpen = windowOpen || inWindow;
    if (dialog.open) dialog.phase = 'code';
  } catch (err) {
    dialog.phase = 'error';
    dialog.message = ctx.cleanError(err);
  }
  renderDialog();
}

export function dialogOpen() {
  return dialog.open;
}

export function closeLoginDialog({ cancel = true } = {}) {
  if (!dialog.open) return;
  if (cancel && dialog.phase === 'code') gx.twitchLoginCancel();
  dialog.open = false;
  dialog.phase = null;
  windowOpen = false;
  renderDialog();
}

function onLoginResult({ state: result, message }) {
  if (!dialog.open || result === 'cancelled') return;
  if (result === 'ok') {
    closeLoginDialog({ cancel: false });
    return;
  }
  dialog.phase = result;
  dialog.message = message;
  windowOpen = false;
  renderDialog();
}

function renderDialog() {
  $('twitchDialog').hidden = !dialog.open;
  clearInterval(dialogTimer);
  if (!dialog.open) return;
  const parts = [];
  if (dialog.phase === 'loading') {
    parts.push(el('p', 'dialog-wait', 'Code wird geholt …'));
  } else if (dialog.phase === 'code') {
    const url = dialog.info.verificationUrl.replace(/^https?:\/\/(www\.)?/, '').replace(/\?.*$/, '');
    if (windowOpen) parts.push(el('p', null, 'Melde dich im geöffneten Fenster bei Twitch an und tippe dort auf „Aktivieren“. Der Code ist schon eingetragen – sonst gib diesen ein:'));
    else {
      const steps = el('ol');
      const open = el('li', null, 'Öffne auf dem Handy ');
      open.append(el('b', null, url));
      steps.append(open, el('li', null, 'Gib diesen Code ein:'));
      parts.push(steps);
    }
    parts.push(el('div', 'device-code', dialog.info.userCode));
    if (!windowOpen) {
      const steps2 = el('ol');
      steps2.start = 3;
      steps2.append(el('li', null, 'Tippe auf „Aktivieren“ und bestätige mit „Autorisieren“.'));
      parts.push(steps2);
    }
    const wait = el('p', 'dialog-wait');
    const tick = () => {
      const min = Math.max(0, Math.ceil((dialog.info.expiresAt - Date.now()) / 60000));
      wait.textContent = `Warte auf die Bestätigung … (Code gilt noch ${min} Min.)`;
    };
    tick();
    dialogTimer = setInterval(tick, 5000);
    parts.push(wait, el('p', 'hint', 'Twitch zeigt dabei „Twitch auf dem Fernseher“ o. Ä. – das ist richtig so: GX Tube meldet sich wie ein Fernseher an. Dein Passwort bekommt GX Tube nie.'));
  } else {
    const text = { expired: 'Der Code ist abgelaufen.', denied: 'Die Anmeldung wurde abgelehnt.' }[dialog.phase] ?? `Das hat nicht geklappt: ${dialog.message || 'unbekannter Fehler'}`;
    const again = el('button', 'pill small', 'Neuen Code holen');
    again.addEventListener('click', () => openLoginDialog());
    const row = el('div', 'dialog-actions');
    row.style.justifyContent = 'flex-start';
    row.append(again);
    parts.push(el('p', 'dialog-problem', text), row);
  }
  const actions = el('div', 'dialog-actions');
  if (dialog.phase === 'code' && !windowOpen) {
    const here = el('button', 'pill small ghost', 'Lieber hier am PC anmelden');
    here.addEventListener('click', () => openLoginDialog({ inWindow: true }));
    actions.append(here);
  }
  const cancel = el('button', 'pill small ghost', 'Abbrechen');
  cancel.addEventListener('click', () => closeLoginDialog());
  actions.append(cancel);
  parts.push(actions);
  $('twitchBody').replaceChildren(...parts);
}
