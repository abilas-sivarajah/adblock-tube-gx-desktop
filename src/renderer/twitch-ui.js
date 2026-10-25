// Twitch-Seiten von GX Tube Desktop: Startseite (Gefolgte live, beliebt, Kategorien), Suche,
// Kategorie, Kanal (live + VODs, Folgen) und die Twitch-Anmeldung. Der Player ist derselbe wie für
// YouTube (app.js), der Chat steckt in twitch-chat.js.

import { icon } from './icons.js';
import { count, duration, el, relativeTime } from './format.js';

const gx = window.gx;
const $ = (id) => document.getElementById(id);

let ctx = null; // aus app.js: { state, toast, showView, setWatch, openMenu, closeMenu, cleanError, history }

const tw = {
  account: { loggedIn: false },
  follows: [], // { login, userId, name, avatar }
  home: { cursor: null, loading: false, loadedAt: 0, language: null },
  category: null, // { name, language, next, loading, seq }
  channel: null, // { login, data, next, loading }
  search: { query: '', seq: 0 },
  prevView: 'twhome',
};

export function init(context) {
  ctx = context;
  bindScroll('view-twhome', () => loadMorePopular());
  bindScroll('view-twcategory', () => loadMoreCategory());
  bindScroll('view-twchannel', () => loadMoreChannel());
  gx.onTwitchAccount((a) => {
    tw.account = a;
    renderAccount();
  });
  gx.onTwitchFollows((list) => {
    tw.follows = list;
    renderFollowButtons();
  });
  gx.onTwitchLogin(onLoginResult);
  $('twitchDialog').addEventListener('click', (e) => {
    if (e.target === $('twitchDialog')) closeLoginDialog();
  });
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

/** Karte für einen Live-Stream oder ein VOD. */
export function streamCard(v, { progress = null, showChannel = true } = {}) {
  const card = el('div', 'card tw-card');
  card.dataset.id = v.id;
  const thumb = el('div', 'thumb');
  const img = el('img');
  img.loading = 'lazy';
  img.alt = '';
  // Live-Vorschau ändert sich laufend – nicht ewig aus dem Zwischenspeicher
  img.src = v.isLive && v.thumbnail ? `${v.thumbnail}${v.thumbnail.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / 300000)}` : v.thumbnail || '';
  img.addEventListener('error', () => img.classList.add('broken'), { once: true });
  thumb.append(img);
  if (v.isLive) {
    thumb.append(el('span', 'tw-live', 'LIVE'));
    if (v.viewers) thumb.append(el('span', 'tw-viewers', `${count(v.viewers)} Zuschauer`));
  } else if (v.durationSec > 0) thumb.append(el('span', 'duration', duration(v.durationSec)));
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
  text.append(el('div', 'card-title', v.title || (v.isLive ? `${v.channelName} ist live` : 'Video')));
  if (showChannel && v.channelName) {
    const ch = el('div', 'card-meta');
    const name = el('span', 'card-channel', v.channelName);
    name.title = 'Zum Kanal';
    name.addEventListener('click', (e) => {
      e.stopPropagation();
      openChannel(v.channelLogin, v.channelName);
    });
    ch.append(name);
    text.append(ch);
  }
  const meta = [];
  if (!v.isLive && v.publishedAt) meta.push(relativeTime(v.publishedAt));
  if (!v.isLive && v.views) meta.push(`${count(v.views)} Aufrufe`);
  if (meta.length) text.append(el('div', 'card-meta', meta.join(' • ')));
  if (v.game?.displayName) {
    const g = el('div', 'card-meta tw-game', v.game.displayName);
    g.title = 'Kategorie öffnen';
    g.addEventListener('click', (e) => {
      e.stopPropagation();
      openCategory(v.game.name);
    });
    text.append(g);
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
  const img = el('img');
  img.loading = 'lazy';
  img.alt = '';
  img.src = g.boxArt || '';
  card.append(img, el('div', 'tw-game-name', g.displayName));
  if (g.viewers) card.append(el('div', 'card-meta', `${count(g.viewers)} Zuschauer`));
  card.title = g.displayName;
  card.addEventListener('click', () => openCategory(g.name));
  return card;
}

function channelRow(c) {
  const card = el('div', 'card channel tw-channel-row');
  const img = el('img');
  img.src = c.avatar || '';
  img.alt = '';
  if (c.live) img.classList.add('live-ring');
  const text = el('div', 'card-text');
  text.append(el('div', 'card-title', c.name));
  const meta = [c.followers != null ? `${count(c.followers)} Follower` : null, c.live ? `🔴 Live: ${c.live.game?.displayName || c.live.title}` : null].filter(Boolean).join(' • ');
  text.append(el('div', 'card-meta', meta || 'Kanal'));
  if (c.live?.title) text.append(el('div', 'card-meta', c.live.title));
  card.append(img, text);
  if (c.live) {
    const watch = el('button', 'pill small', 'Ansehen');
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
  if (ctx?.state.view === 'twhome') renderFollowed();
}

// ------------------------------------------------------------------ Startseite

let homeSeq = 0;

export async function renderHome({ force = false } = {}) {
  renderFollowed();
  renderContinue();
  const fresh = Date.now() - tw.home.loadedAt < 3 * 60 * 1000 && tw.home.language === language();
  if (!force && fresh && $('twPopularGrid').childElementCount) return;
  const seq = ++homeSeq;
  const lang = language();
  $('twHomeStatus').textContent = $('twPopularGrid').childElementCount ? '' : 'Lädt …';
  $('twPopularHead').replaceChildren(el('h2', null, lang === 'de' ? 'Beliebt auf Deutsch' : lang === 'en' ? 'Beliebt auf Englisch' : 'Beliebte Streams'), languageChips(() => renderHome({ force: true })));
  try {
    const h = await gx.twitchHome(lang);
    if (seq !== homeSeq) return;
    tw.home = { cursor: h.next, loading: false, loadedAt: Date.now(), language: lang };
    $('twPopularGrid').replaceChildren(...h.streams.map((v) => streamCard(v)));
    $('twGamesGrid').replaceChildren(...h.games.map(gameCard));
    // Weltweit: nur was nicht schon oben steht
    const shown = new Set(h.streams.map((v) => v.id));
    const top = h.top.filter((v) => !shown.has(v.id));
    $('twShelfTop').hidden = lang === '' || top.length === 0;
    $('twTopGrid').replaceChildren(...top.map((v) => streamCard(v)));
    $('twHomeStatus').textContent = '';
  } catch (err) {
    if (seq === homeSeq) $('twHomeStatus').textContent = 'Twitch konnte nicht geladen werden: ' + ctx.cleanError(err);
  }
}

async function loadMorePopular() {
  const h = tw.home;
  if (h.loading || !h.cursor || ctx.state.view !== 'twhome') return;
  h.loading = true;
  const seq = homeSeq;
  try {
    const res = await gx.twitchMoreStreams(h.language, h.cursor);
    if (seq !== homeSeq) return;
    const shown = new Set([...$('twPopularGrid').querySelectorAll('.tw-card')].map((c) => c.dataset.id));
    $('twPopularGrid').append(...res.items.filter((v) => !shown.has(v.id)).map((v) => streamCard(v)));
    h.cursor = res.next;
  } catch {
    h.cursor = null;
  } finally {
    h.loading = false;
  }
}

let followedSeq = 0;

/** "Live – Kanäle, denen du folgst" plus die übrigen als runde Bilder. */
async function renderFollowed() {
  const shelf = $('twShelfFollowed');
  shelf.hidden = tw.follows.length === 0;
  if (!tw.follows.length) return;
  const seq = ++followedSeq;
  if (!$('twFollowedGrid').childElementCount) $('twFollowedHint').textContent = 'Lädt …';
  try {
    const list = await gx.twitchFollowed();
    if (seq !== followedSeq) return;
    const live = list.filter((c) => c.live);
    $('twFollowedGrid').replaceChildren(...live.map((c) => streamCard(c.live)));
    $('twFollowedHint').textContent = live.length ? `${live.length} live` : 'Gerade ist niemand live';
    $('twOfflineChips').replaceChildren(
      ...list
        .filter((c) => !c.live)
        .slice(0, 40)
        .map((c) => {
          const chip = el('div', 'sub-chip');
          chip.title = c.name;
          const img = el('img');
          img.loading = 'lazy';
          img.alt = '';
          if (c.avatar) img.src = c.avatar;
          chip.append(img, el('span', null, c.name));
          chip.addEventListener('click', () => openChannel(c.login, c.name));
          return chip;
        }),
    );
  } catch {
    if (seq === followedSeq) $('twFollowedHint').textContent = 'Konnte nicht geladen werden';
  }
}

async function renderContinue() {
  const lib = await gx.library();
  const cont = lib.history.filter((h) => h.video.id.startsWith('twitch-vod:') && h.durationMs > 0 && h.positionMs > 5000 && h.positionMs < h.durationMs - 15000).slice(0, 20);
  $('twShelfContinue').hidden = cont.length === 0;
  $('twContinueRow').replaceChildren(...cont.map((h) => streamCard({ ...h.video, vod: h.video.id.slice(11) }, { progress: h.positionMs / h.durationMs })));
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
  $('twSearchStatus').textContent = 'Suche läuft …';
  $('view-twsearch').scrollTop = 0;
  try {
    const res = await gx.twitchSearch(q);
    if (seq !== tw.search.seq) return;
    $('twSearchGamesHead').hidden = res.games.length === 0;
    $('twSearchGames').replaceChildren(...res.games.map(gameCard));
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
  tw.category = { name, next: null, loading: true, game: null };
  renderCategoryHead();
  $('twCategoryGrid').replaceChildren();
  $('twCategoryStatus').textContent = 'Lädt …';
  $('view-twcategory').scrollTop = 0;
  try {
    const res = await gx.twitchCategory(name, language(), null);
    if (seq !== categorySeq) return;
    tw.category.game = res.game;
    tw.category.next = res.next;
    renderCategoryHead();
    $('twCategoryGrid').replaceChildren(...res.items.map((v) => streamCard(v)));
    $('twCategoryStatus').textContent = res.items.length ? '' : language() ? 'Gerade keine Streams in dieser Sprache' : 'Gerade keine Streams';
  } catch (err) {
    if (seq === categorySeq) $('twCategoryStatus').textContent = 'Kategorie konnte nicht geladen werden: ' + ctx.cleanError(err);
  } finally {
    if (seq === categorySeq) tw.category.loading = false;
  }
}

async function loadMoreCategory() {
  const c = tw.category;
  if (!c || c.loading || !c.next) return;
  c.loading = true;
  const seq = categorySeq;
  try {
    const res = await gx.twitchCategory(c.name, language(), c.next);
    if (seq !== categorySeq) return;
    $('twCategoryGrid').append(...res.items.map((v) => streamCard(v)));
    c.next = res.next;
  } catch {
    c.next = null;
  } finally {
    c.loading = false;
  }
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
  if (c.game?.viewers) text.append(el('div', 'channel-meta', `${count(c.game.viewers)} Zuschauer`));
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
  tw.channel = { login, data: { login, name }, next: null, loading: true };
  renderChannelHead();
  $('twChannelLive').replaceChildren();
  $('twChannelGrid').replaceChildren();
  $('twChannelStatus').textContent = 'Lädt …';
  $('view-twchannel').scrollTop = 0;
  try {
    const data = await gx.twitchChannel(login);
    if (seq !== channelSeq) return;
    tw.channel.data = data;
    tw.channel.next = data.next;
    renderChannelHead();
    if (data.live) {
      const live = el('div', 'tw-channel-live');
      live.append(el('h2', null, 'Jetzt live'), streamCard(data.live, { showChannel: false }));
      $('twChannelLive').replaceChildren(live);
    }
    $('twChannelGrid').replaceChildren(...data.items.map((v) => streamCard(v, { showChannel: false })));
    $('twChannelVideosHead').hidden = data.items.length === 0;
    $('twChannelStatus').textContent = data.items.length ? '' : data.live ? '' : 'Keine Videos (Twitch löscht vergangene Streams meist nach einigen Tagen)';
  } catch (err) {
    if (seq === channelSeq) $('twChannelStatus').textContent = 'Kanal konnte nicht geladen werden: ' + ctx.cleanError(err);
  } finally {
    if (seq === channelSeq) tw.channel.loading = false;
  }
}

async function loadMoreChannel() {
  const c = tw.channel;
  if (!c || c.loading || !c.next) return;
  c.loading = true;
  const seq = channelSeq;
  try {
    const res = await gx.twitchChannelMore(c.login, c.next);
    if (seq !== channelSeq) return;
    $('twChannelGrid').append(...res.items.map((v) => streamCard(v, { showChannel: false })));
    c.next = res.next;
  } catch {
    c.next = null;
  } finally {
    c.loading = false;
  }
}

function renderChannelHead() {
  const d = tw.channel?.data;
  const head = $('twChannelHead');
  if (!d) return head.replaceChildren();
  const parts = [];
  if (d.banner) {
    const banner = el('img', 'channel-banner');
    banner.src = d.banner;
    banner.alt = '';
    parts.push(banner);
  }
  head.classList.toggle('no-banner', !d.banner);
  const backBtn = el('button', 'icon-btn channel-back');
  backBtn.title = 'Zurück';
  backBtn.append(icon('back'));
  backBtn.addEventListener('click', back);
  const info = el('div', 'channel-info');
  const avatar = el('img', 'channel-avatar');
  if (d.avatar) avatar.src = d.avatar;
  avatar.alt = '';
  if (d.live) avatar.classList.add('live-ring');
  const text = el('div', 'channel-text');
  text.append(el('h1', null, d.name || d.login));
  const meta = [`twitch.tv/${d.login}`, d.followers != null ? `${count(d.followers)} Follower` : null, d.live ? '🔴 Live' : null].filter(Boolean).join(' • ');
  text.append(el('div', 'channel-meta', meta));
  if (d.description) text.append(el('p', 'channel-desc', d.description));
  info.append(avatar, text, followButton({ login: d.login, userId: d.userId ?? null, name: d.name, avatar: d.avatar }));
  head.replaceChildren(...parts, backBtn, info);
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
