// Twitch: Abfragen über Twitchs GraphQL-Schnittstelle (wie twitch.tv selbst), Wiedergabe-Adressen
// für Live-Streams und VODs, Folgen und die Anmeldung per Code (twitch.tv/activate, wie die
// Twitch-App auf dem Fernseher). Die Werbung entfernt der Werbeblocker aus Adblock GX im Fenster
// (renderer/vendor/twitch-adblock.js) – hier wird nur die Adresse gebaut.
//
// Ohne Electron-Abhängigkeit, damit die Umwandlungen testbar bleiben: fetch und das Konto kommen
// über configure().

export const WEB_CLIENT = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // twitch.tv
export const TV_CLIENT = 'ue6666qo983tsx6so1t0vnawi233wa'; // Twitch auf dem Fernseher (Anmeldung per Code)
export const SCOPES = 'chat:read chat:edit user:read:follows user:edit:follows';

const GQL_URL = 'https://gql.twitch.tv/gql';
const LOGIN = /^[a-z0-9_]{1,25}$/;
const VOD = /^\d{1,15}$/;
// Live: 'twitch:<login>', VOD: 'twitch-vod:<id>'
export const TWITCH_ID = /^twitch:[a-z0-9_]{1,25}$|^twitch-vod:\d{1,15}$/;

let fetchImpl = (...args) => fetch(...args);
let authImpl = () => null; // → { token, clientId } oder null
let onUnauthorized = () => {};

export function configure({ fetch: f, auth, unauthorized } = {}) {
  if (f) fetchImpl = f;
  if (auth) authImpl = auth;
  if (unauthorized) onUnauthorized = unauthorized;
}

export class TwitchError extends Error {
  constructor(message, { code = null, signIn = false } = {}) {
    super(message);
    this.code = code;
    this.signIn = signIn;
  }
}

// ------------------------------------------------------------------ IDs

/** 'twitch:<login>' (live) oder 'twitch-vod:<id>' → { login } bzw. { vod }. */
export function parseId(id) {
  if (typeof id !== 'string' || !TWITCH_ID.test(id)) return null;
  return id.startsWith('twitch-vod:') ? { vod: id.slice(11), login: null } : { vod: null, login: id.slice(7) };
}

export const liveId = (login) => `twitch:${String(login).toLowerCase()}`;
export const vodId = (id) => `twitch-vod:${id}`;
export const isTwitchId = (id) => typeof id === 'string' && TWITCH_ID.test(id);
export const validLogin = (login) => typeof login === 'string' && LOGIN.test(login.toLowerCase());

/** Vorschaubild eines Live-Streams (Twitch erneuert es alle paar Minuten). */
export function livePreview(login, width = 440, height = 248) {
  return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-${width}x${height}.jpg`;
}

// ------------------------------------------------------------------ GraphQL

const STREAM_FIELDS = 'id title viewersCount createdAt type previewImageURL(width: 440, height: 248) game { id name displayName boxArtURL(width: 72, height: 96) }';
const USER_FIELDS = 'id login displayName profileImageURL(width: 70)';
const VIDEO_FIELDS = 'id title lengthSeconds viewCount publishedAt broadcastType previewThumbnailURL(width: 320, height: 180) game { name displayName }';
const GAME_FIELDS = 'id name displayName viewersCount boxArtURL(width: 188, height: 250)';

/**
 * Eine GraphQL-Abfrage. [auth]: mit dem angemeldeten Konto (wirft, wenn keins da ist).
 * Gibt data zurück; Teilfehler (errors neben data) werden ignoriert.
 */
export async function gql(query, variables = {}, { auth = false } = {}) {
  const account = auth ? authImpl() : null;
  if (auth && !account) throw new TwitchError('Nicht bei Twitch angemeldet', { signIn: true });
  // Ohne Konto wie die Fernseher-App: Twitch verlangt dort beim Weiterblättern keine Integritätsprüfung
  const headers = { 'Client-ID': account?.clientId ?? TV_CLIENT, 'Content-Type': 'application/json' };
  if (account) headers.Authorization = `OAuth ${account.token}`;
  const res = await fetchImpl(GQL_URL, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
  const json = await res.json().catch(() => null);
  if (res.status === 401 || json?.status === 401) {
    if (account) onUnauthorized();
    throw new TwitchError('Twitch-Anmeldung abgelaufen', { code: 401, signIn: true });
  }
  if (!res.ok || !json) throw new TwitchError(`Twitch antwortet nicht (HTTP ${res.status})`, { code: res.status });
  if (!json.data) {
    const msg = json.errors?.[0]?.message ?? 'unbekannter Fehler';
    if (/unauthenticated|unauthorized/i.test(msg)) throw new TwitchError('Dafür musst du bei Twitch angemeldet sein', { code: 'auth', signIn: true });
    throw new TwitchError(`Twitch: ${msg}`, { code: json.errors?.[0]?.extensions?.code ?? null });
  }
  if (json.errors?.length && auth && json.errors.some((e) => /unauthenticated/i.test(e.message ?? ''))) {
    onUnauthorized();
    throw new TwitchError('Twitch-Anmeldung abgelaufen', { code: 401, signIn: true });
  }
  return json.data;
}

// ------------------------------------------------------------------ Umwandlung (für die Oberfläche)

function ms(iso) {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : null;
}

function game(g) {
  return g ? { id: g.id ?? null, name: g.name ?? '', displayName: g.displayName || g.name || '', boxArt: g.boxArtURL ?? null } : null;
}

/** Ein Live-Stream als Karte (id 'twitch:<login>'). [user]: Kanal, falls der Stream ihn nicht selbst mitbringt. */
export function toStream(node, user = null) {
  const b = node?.broadcaster ?? user;
  if (!node || !b?.login) return null;
  const login = b.login.toLowerCase();
  return {
    kind: 'stream',
    platform: 'twitch',
    id: liveId(login),
    title: node.title ?? '',
    channelName: b.displayName || b.login,
    channelLogin: login,
    channelUserId: b.id ?? null,
    avatar: b.profileImageURL ?? null,
    thumbnail: node.previewImageURL || livePreview(login),
    viewers: Number(node.viewersCount) || 0,
    startedAt: ms(node.createdAt),
    game: game(node.game),
    isLive: true,
    durationSec: -1,
  };
}

const PROCESSING = /\/_404\/|404_processing/;

/** Ein VOD (id 'twitch-vod:<id>'). */
export function toVod(node, owner = null) {
  const o = node?.owner ?? owner;
  if (!node?.id || !VOD.test(String(node.id))) return null;
  const login = o?.login?.toLowerCase() ?? '';
  const thumb = node.previewThumbnailURL && !PROCESSING.test(node.previewThumbnailURL) ? node.previewThumbnailURL : null;
  return {
    kind: 'vod',
    platform: 'twitch',
    id: vodId(node.id),
    vod: String(node.id),
    title: node.title ?? '',
    channelName: o?.displayName || o?.login || '',
    channelLogin: login || null,
    avatar: o?.profileImageURL ?? null,
    thumbnail: thumb ?? (login ? livePreview(login, 320, 180) : null),
    durationSec: Number(node.lengthSeconds) || 0,
    views: Number(node.viewCount) || 0,
    publishedAt: ms(node.publishedAt),
    broadcastType: node.broadcastType ?? null,
    game: game(node.game),
    isLive: false,
  };
}

export function toGame(node) {
  if (!node?.name) return null;
  return { kind: 'game', id: node.id ?? null, name: node.name, displayName: node.displayName || node.name, boxArt: node.boxArtURL ?? null, viewers: Number(node.viewersCount) || 0 };
}

/** Ein Kanal (Suche, Folgen). live: laufender Stream oder null. */
export function toChannel(u) {
  if (!u?.login) return null;
  const login = u.login.toLowerCase();
  return {
    kind: 'channel',
    platform: 'twitch',
    login,
    userId: u.id ?? null,
    name: u.displayName || u.login,
    avatar: u.profileImageURL ?? null,
    followers: u.followers?.totalCount ?? null,
    live: u.stream ? toStream(u.stream, u) : null,
  };
}

const edges = (conn) => (Array.isArray(conn?.edges) ? conn.edges : []);
const nextCursor = (conn) => {
  const list = edges(conn);
  return conn?.pageInfo?.hasNextPage && list.length ? (list[list.length - 1].cursor ?? null) : null;
};

// ------------------------------------------------------------------ Abfragen

const LANG = { de: 'DE', en: 'EN' };

function streamOptions(language) {
  const lang = LANG[language];
  return lang ? `{sort: VIEWER_COUNT, broadcasterLanguages: [${lang}]}` : '{sort: VIEWER_COUNT}';
}

/** Startseite: beliebte Streams (Sprache), weltweit beliebt und die größten Kategorien. */
export async function home({ language = 'de' } = {}) {
  const data = await gql(
    `query { lang: streams(first: 24, options: ${streamOptions(language)}) { edges { cursor node { ${STREAM_FIELDS} broadcaster { ${USER_FIELDS} } } } pageInfo { hasNextPage } }
      top: streams(first: 12, options: {sort: VIEWER_COUNT}) { edges { node { ${STREAM_FIELDS} broadcaster { ${USER_FIELDS} } } } }
      games(first: 24, options: {sort: VIEWER_COUNT}) { edges { node { ${GAME_FIELDS} } } } }`,
  );
  return {
    streams: edges(data.lang).map((e) => toStream(e.node)).filter(Boolean),
    next: nextCursor(data.lang),
    top: edges(data.top).map((e) => toStream(e.node)).filter(Boolean),
    games: edges(data.games).map((e) => toGame(e.node)).filter(Boolean),
  };
}

/** Weitere beliebte Streams (Startseite weiter unten). */
export async function moreStreams({ language = 'de', cursor }) {
  const data = await gql(
    `query($after: Cursor) { streams(first: 24, after: $after, options: ${streamOptions(language)}) { edges { cursor node { ${STREAM_FIELDS} broadcaster { ${USER_FIELDS} } } } pageInfo { hasNextPage } } }`,
    { after: cursor },
  );
  return { items: edges(data.streams).map((e) => toStream(e.node)).filter(Boolean), next: nextCursor(data.streams) };
}

/** Streams einer Kategorie. */
export async function category(name, { language = '', cursor = null } = {}) {
  const data = await gql(
    `query($name: String!, $after: Cursor) { game(name: $name) { ${GAME_FIELDS} streams(first: 30, after: $after, options: ${streamOptions(language)}) { edges { cursor node { ${STREAM_FIELDS} broadcaster { ${USER_FIELDS} } } } pageInfo { hasNextPage } } } }`,
    { name: String(name).slice(0, 200), after: cursor },
  );
  if (!data.game) throw new TwitchError('Kategorie nicht gefunden');
  return { game: toGame(data.game), items: edges(data.game.streams).map((e) => toStream(e.node)).filter(Boolean), next: nextCursor(data.game.streams) };
}

/** Suche nach Kanälen und Kategorien. Laufende Streams zuerst. */
export async function search(query) {
  const data = await gql(
    `query($q: String!) { searchFor(userQuery: $q, platform: "web", options: {targets: [{index: CHANNEL}]}) {
      channels { items { ${USER_FIELDS} followers { totalCount } stream { ${STREAM_FIELDS} } } } }
      searchCategories(query: $q, first: 12) { edges { node { ${GAME_FIELDS} } } } }`,
    { q: String(query).slice(0, 200) },
  );
  const channels = (data.searchFor?.channels?.items ?? []).map(toChannel).filter(Boolean);
  // Genau der gesuchte Kanal zuerst, dann wer live ist (nach Zuschauern), dann der Rest
  const wanted = String(query).trim().toLowerCase().replace(/^@/, '');
  const exact = channels.filter((c) => c.login === wanted || c.name.toLowerCase() === wanted);
  const rest = channels.filter((c) => !exact.includes(c));
  const live = rest.filter((c) => c.live).sort((a, b) => b.live.viewers - a.live.viewers);
  return {
    channels: [...exact, ...live, ...rest.filter((c) => !c.live)],
    games: edges(data.searchCategories).map((e) => toGame(e.node)).filter(Boolean),
  };
}

const CHANNEL_QUERY = `query($login: String!, $after: Cursor) { user(login: $login) {
  ${USER_FIELDS} profileImageURL150: profileImageURL(width: 150) description bannerImageURL followers { totalCount }
  stream { ${STREAM_FIELDS} }
  videos(first: 30, after: $after, sort: TIME) { edges { cursor node { ${VIDEO_FIELDS} } } pageInfo { hasNextPage } } } }`;

/** Kanalseite: Kopf, laufender Stream und VODs. */
export async function channel(login) {
  if (!validLogin(login)) throw new TwitchError('Ungültiger Kanal');
  const data = await gql(CHANNEL_QUERY, { login: login.toLowerCase(), after: null });
  const u = data.user;
  if (!u) throw new TwitchError('Kanal nicht gefunden');
  const owner = { login: u.login, displayName: u.displayName, profileImageURL: u.profileImageURL };
  return {
    platform: 'twitch',
    login: u.login.toLowerCase(),
    userId: u.id,
    name: u.displayName || u.login,
    avatar: u.profileImageURL150 || u.profileImageURL || null,
    banner: u.bannerImageURL ?? null,
    description: u.description ?? '',
    followers: u.followers?.totalCount ?? null,
    live: u.stream ? toStream(u.stream, u) : null,
    items: edges(u.videos).map((e) => toVod(e.node, owner)).filter(Boolean),
    next: nextCursor(u.videos),
  };
}

/** Weitere VODs eines Kanals. */
export async function channelMore(login, cursor) {
  if (!validLogin(login)) throw new TwitchError('Ungültiger Kanal');
  const data = await gql(CHANNEL_QUERY, { login: login.toLowerCase(), after: cursor });
  const u = data.user;
  if (!u) return { items: [], next: null };
  const owner = { login: u.login, displayName: u.displayName, profileImageURL: u.profileImageURL };
  return { items: edges(u.videos).map((e) => toVod(e.node, owner)).filter(Boolean), next: nextCursor(u.videos) };
}

/** Kanäle (z. B. die, denen man auf diesem PC folgt) mit ihrem Live-Status. */
export async function users(logins) {
  const list = [...new Set((logins ?? []).map((l) => String(l).toLowerCase()).filter((l) => LOGIN.test(l)))];
  const out = [];
  for (let i = 0; i < list.length; i += 50) {
    const data = await gql(`query($logins: [String!]) { users(logins: $logins) { ${USER_FIELDS} stream { ${STREAM_FIELDS} } } }`, { logins: list.slice(i, i + 50) });
    out.push(...(data.users ?? []).map(toChannel).filter(Boolean));
  }
  return out;
}

/** Was gerade läuft (für den Player): Titel, Kategorie, Zuschauer, Kanal. */
export async function watchInfo(id) {
  const t = parseId(id);
  if (!t) throw new TwitchError('Ungültiger Twitch-Stream');
  if (t.vod) {
    const data = await gql(`query($id: ID!) { video(id: $id) { ${VIDEO_FIELDS} owner { ${USER_FIELDS} followers { totalCount } } } }`, { id: t.vod });
    if (!data.video) throw new TwitchError('Dieses Video gibt es nicht mehr');
    const v = toVod(data.video);
    return { ...v, channelUserId: data.video.owner?.id ?? null, followers: data.video.owner?.followers?.totalCount ?? null };
  }
  const data = await gql(`query($login: String!) { user(login: $login) { ${USER_FIELDS} followers { totalCount } stream { ${STREAM_FIELDS} } } }`, { login: t.login });
  const u = data.user;
  if (!u) throw new TwitchError('Kanal nicht gefunden');
  if (!u.stream) throw new TwitchError(`${u.displayName || u.login} ist gerade nicht live`, { code: 'offline' });
  return { ...toStream(u.stream, u), followers: u.followers?.totalCount ?? null };
}

// ------------------------------------------------------------------ Wiedergabe

const TOKEN_QUERY =
  'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {' +
  '  streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature authorization { isForbidden forbiddenReasonCode } __typename }' +
  '  videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }';

function randomHex(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

const FORBIDDEN = {
  UNAUTHORIZED_ENTITLEMENTS: 'Nur für Abonnenten des Kanals – melde dich mit einem Konto an, das den Kanal abonniert hat.',
  GEOBLOCK: 'Dieser Stream ist in deinem Land nicht verfügbar.',
};

/** Usher-Adresse (HLS-Master-Playlist) bauen. */
export function usherUrl({ login = null, vod = null, token }) {
  const u = new URL(vod ? `https://usher.ttvnw.net/vod/${vod}.m3u8` : `https://usher.ttvnw.net/api/channel/hls/${login}.m3u8`);
  const p = u.searchParams;
  p.set('allow_source', 'true');
  p.set('allow_audio_only', 'true');
  p.set('cdm', 'wv');
  p.set('fast_bread', 'true');
  p.set('p', String(Math.floor(Math.random() * 1e7)));
  p.set('play_session_id', randomHex(32));
  p.set('player_backend', 'mediaplayer');
  p.set('playlist_include_framerate', 'true');
  p.set('reassignments_supported', 'true');
  // Nur H.264: läuft überall, und das schwarze Ersatz-Stück des Werbeblockers ist H.264
  p.set('supported_codecs', 'avc1');
  p.set('sig', token.signature);
  p.set('token', token.value);
  return u.toString();
}

/**
 * Wiedergabe-Adresse für 'twitch:<login>' bzw. 'twitch-vod:<id>'. Angemeldet zuerst mit dem Konto
 * (Abo-Streams, Abonnenten ohne Werbung), sonst anonym.
 */
export async function playback(id) {
  const t = parseId(id);
  if (!t) throw new TwitchError('Ungültiger Twitch-Stream');
  const variables = { isLive: !t.vod, login: t.login ?? '', isVod: Boolean(t.vod), vodID: t.vod ?? '', playerType: 'site', platform: 'web' };
  let lastError = null;
  for (const auth of authImpl() ? [true, false] : [false]) {
    try {
      const data = await gql(TOKEN_QUERY, variables, { auth });
      const tok = data.streamPlaybackAccessToken ?? data.videoPlaybackAccessToken;
      if (!tok?.value || !tok.signature) throw new TwitchError(t.vod ? 'Dieses Video gibt es nicht mehr' : 'Kanal nicht gefunden');
      if (tok.authorization?.isForbidden) {
        const code = tok.authorization.forbiddenReasonCode;
        throw new TwitchError(FORBIDDEN[code] ?? `Twitch erlaubt die Wiedergabe nicht (${code || 'gesperrt'})`, { code, signIn: code === 'UNAUTHORIZED_ENTITLEMENTS' && !authImpl() });
      }
      return { url: usherUrl({ login: t.login, vod: t.vod, token: tok }), isLive: !t.vod, login: t.login, vod: t.vod, account: auth };
    } catch (err) {
      lastError = err;
      if (err.code && FORBIDDEN[err.code] && !auth) break;
    }
  }
  throw lastError;
}

// ------------------------------------------------------------------ Mit Konto

/** Wer ist angemeldet? */
export async function currentUser() {
  const data = await gql(`query { currentUser { ${USER_FIELDS} } }`, {}, { auth: true });
  const u = data.currentUser;
  if (!u) throw new TwitchError('Twitch-Anmeldung abgelaufen', { code: 401, signIn: true });
  return { id: u.id, login: u.login.toLowerCase(), name: u.displayName || u.login, avatar: u.profileImageURL ?? null };
}

/**
 * Kanäle, denen das Konto folgt: über die offizielle Twitch-API (Berechtigung "user:read:follows"),
 * sonst über GraphQL. [userId]: das angemeldete Konto.
 */
export async function followedChannels(userId) {
  let helixError = null;
  if (userId) {
    try {
      return await followedHelix(userId);
    } catch (err) {
      if (err.code === 401) throw err;
      helixError = err;
    }
  }
  let list;
  try {
    list = await followedGql();
  } catch (err) {
    throw helixError ?? err;
  }
  // GraphQL kennt das Konto nicht (currentUser leer) – dann lieber den Fehler der offiziellen API melden
  if (!list.length && helixError) throw helixError;
  return list;
}

/** Gefolgte über Helix: GET /helix/channels/followed (Bilder und Live-Status kommen danach über users()). */
export async function followedHelix(userId, limit = 2000) {
  const account = authImpl();
  if (!account) throw new TwitchError('Nicht bei Twitch angemeldet', { signIn: true });
  const out = [];
  let after = null;
  while (out.length < limit) {
    const url = `https://api.twitch.tv/helix/channels/followed?user_id=${encodeURIComponent(userId)}&first=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    const res = await fetchImpl(url, { headers: { 'Client-Id': account.clientId, Authorization: `Bearer ${account.token}` } });
    const j = await res.json().catch(() => null);
    if (res.status === 401) {
      // Fehlende Berechtigung heißt nicht, dass die Anmeldung abgelaufen ist
      if (/scope/i.test(j?.message ?? '')) throw new TwitchError(`Twitch erlaubt das Lesen der gefolgten Kanäle nicht (${j.message})`, { code: 'scope', signIn: true });
      onUnauthorized();
      throw new TwitchError('Twitch-Anmeldung abgelaufen', { code: 401, signIn: true });
    }
    if (!res.ok || !j) throw new TwitchError(`Twitch-API: HTTP ${res.status} ${j?.message ?? ''}`.trim(), { code: res.status });
    for (const f of j.data ?? []) {
      const login = String(f.broadcaster_login ?? '').toLowerCase();
      if (LOGIN.test(login)) out.push({ kind: 'channel', platform: 'twitch', login, userId: f.broadcaster_id ?? null, name: f.broadcaster_name || login, avatar: null, followers: null, live: null, followedAt: ms(f.followed_at) });
    }
    after = j.pagination?.cursor ?? null;
    if (!after) break;
  }
  return out;
}

async function followedGql(limit = 300) {
  const out = [];
  let after = null;
  while (out.length < limit) {
    const data = await gql(
      `query($after: Cursor) { currentUser { follows(first: 100, after: $after) { edges { cursor followedAt node { ${USER_FIELDS} stream { ${STREAM_FIELDS} } } } pageInfo { hasNextPage } } } }`,
      { after },
      { auth: true },
    );
    const conn = data.currentUser?.follows;
    for (const e of edges(conn)) {
      const c = toChannel(e.node);
      if (c) out.push({ ...c, followedAt: ms(e.followedAt) });
    }
    after = nextCursor(conn);
    if (!after) break;
  }
  return out;
}

/** Folgen / Entfolgen mit dem Konto. */
export async function follow(userId, on) {
  if (!/^\d{1,20}$/.test(String(userId ?? ''))) throw new TwitchError('Ungültiger Kanal');
  const query = on
    ? 'mutation($id: ID!) { followUser(input: {targetID: $id, disableNotifications: false}) { follow { followedAt } error { code } } }'
    : 'mutation($id: ID!) { unfollowUser(input: {targetID: $id}) { follow { followedAt } } }';
  const data = await gql(query, { id: String(userId) }, { auth: true });
  const code = data.followUser?.error?.code;
  if (code) throw new TwitchError(`Twitch: ${code}`);
  if (on ? !data.followUser : !data.unfollowUser) throw new TwitchError('Twitch hat nicht geantwortet');
  return true;
}

// ------------------------------------------------------------------ Anmeldung per Code (twitch.tv/activate)

export class DeviceLoginError extends Error {
  constructor(reason, message) {
    super(message ?? reason);
    this.reason = reason; // 'expired' | 'denied' | 'cancelled' | 'error'
  }
}

async function postForm(url, params) {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

/**
 * Code holen. Ergebnis: { userCode, verificationUrl, activateUrl, expiresAt, done, cancel } –
 * done liefert die Tokens { access_token, refresh_token, expires_at, scopes, client_id }.
 */
export async function startDeviceLogin({ wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const start = await postForm('https://id.twitch.tv/oauth2/device', { client_id: TV_CLIENT, scopes: SCOPES });
  if (!start.ok || !start.json.device_code) throw new Error(`Twitch gibt gerade keinen Code heraus (${start.json.message ?? start.status})`);
  const { device_code: deviceCode, user_code: userCode, verification_uri: verificationUrl, expires_in: expiresIn = 1800, interval = 5 } = start.json;
  const expiresAt = Date.now() + expiresIn * 1000;
  let cancelled = false;
  let cancelWait = null;
  const done = (async () => {
    let delay = Math.max(2, interval) * 1000;
    while (!cancelled) {
      await Promise.race([wait(delay), new Promise((r) => (cancelWait = r))]);
      if (cancelled) break;
      if (Date.now() > expiresAt) throw new DeviceLoginError('expired', 'Der Code ist abgelaufen');
      const r = await postForm('https://id.twitch.tv/oauth2/token', {
        client_id: TV_CLIENT,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        scopes: SCOPES,
      }).catch(() => null);
      if (!r) continue;
      if (r.ok && r.json.access_token) return tokensFrom(r.json, TV_CLIENT);
      const msg = String(r.json.message ?? '');
      if (/authorization_pending/.test(msg)) continue;
      if (/slow_down/.test(msg)) {
        delay += 5000;
        continue;
      }
      if (/expired|invalid device code/i.test(msg)) throw new DeviceLoginError('expired', 'Der Code ist abgelaufen');
      if (/denied/i.test(msg)) throw new DeviceLoginError('denied', 'Die Anmeldung wurde abgelehnt');
      throw new DeviceLoginError('error', msg || `HTTP ${r.status}`);
    }
    throw new DeviceLoginError('cancelled', 'Abgebrochen');
  })();
  return {
    userCode,
    verificationUrl,
    // Mit vorausgefülltem Code (fürs Anmeldefenster am PC)
    activateUrl: `${verificationUrl}${verificationUrl.includes('?') ? '&' : '?'}device-code=${encodeURIComponent(userCode)}`,
    expiresAt,
    done,
    cancel() {
      cancelled = true;
      cancelWait?.();
    },
  };
}

export function tokensFrom(json, clientId) {
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? null,
    expires_at: json.expires_in ? Date.now() + json.expires_in * 1000 : null,
    scopes: Array.isArray(json.scope) ? json.scope : String(json.scope ?? '').split(' ').filter(Boolean),
    client_id: clientId,
  };
}

/** Zugangs-Token erneuern (öffentlicher Client: ohne Geheimnis). */
export async function refreshTokens(tokens) {
  if (!tokens?.refresh_token) throw new TwitchError('Twitch-Anmeldung abgelaufen', { code: 401, signIn: true });
  const r = await postForm('https://id.twitch.tv/oauth2/token', { client_id: tokens.client_id ?? TV_CLIENT, grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  if (!r.ok || !r.json.access_token) throw new TwitchError('Twitch-Anmeldung abgelaufen', { code: 401, signIn: true });
  return tokensFrom({ ...r.json, refresh_token: r.json.refresh_token ?? tokens.refresh_token }, tokens.client_id ?? TV_CLIENT);
}

/** Token prüfen: { login, userId, clientId, scopes, expiresIn } oder null (ungültig). */
export async function validate(token) {
  const res = await fetchImpl('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${token}` } });
  if (res.status === 401) return null;
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.login) throw new TwitchError(`Twitch-Prüfung fehlgeschlagen (HTTP ${res.status})`);
  return { login: j.login, userId: j.user_id, clientId: j.client_id, scopes: j.scopes ?? [], expiresIn: j.expires_in ?? null };
}

/** Abmelden: Token bei Twitch widerrufen. */
export async function revoke(tokens) {
  if (!tokens?.access_token) return;
  await postForm('https://id.twitch.tv/oauth2/revoke', { client_id: tokens.client_id ?? TV_CLIENT, token: tokens.access_token }).catch(() => {});
}
