// Brücke zwischen Fenster und Hauptprozess – nur diese Funktionen sind im Fenster sichtbar.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('gx', {
  search: (q) => ipcRenderer.invoke('yt:search', q),
  searchMore: (token) => ipcRenderer.invoke('yt:searchMore', token),
  suggestions: (q) => ipcRenderer.invoke('yt:suggestions', q),

  info: () => ipcRenderer.invoke('app:info'),
  settings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  library: () => ipcRenderer.invoke('library:get'),
  removeHistory: (id) => ipcRenderer.invoke('library:removeHistory', id),

  session: () => ipcRenderer.invoke('session:get'),
  play: (video, queue) => ipcRenderer.send('session:play', video, queue),
  add: (video, next) => ipcRenderer.send('session:add', video, next),
  jump: (index) => ipcRenderer.send('session:jump', index),
  remove: (index) => ipcRenderer.send('session:remove', index),
  next: () => ipcRenderer.send('session:next'),
  previous: (positionMs) => ipcRenderer.send('session:previous', positionMs),
  clearUpcoming: () => ipcRenderer.send('session:clearUpcoming'),
  stop: () => ipcRenderer.send('session:stop'),
  retry: () => ipcRenderer.send('session:retry'),

  report: (state) => ipcRenderer.send('player:report', state),
  ended: (token) => ipcRenderer.send('player:ended', token),
  failed: (info) => ipcRenderer.send('player:failed', info),
  channel: (id) => ipcRenderer.invoke('yt:channel', id),
  channelMore: (token) => ipcRenderer.invoke('yt:channelMore', token),
  subscriptions: () => ipcRenderer.invoke('subs:list'),
  setSubscribed: (channel, on) => ipcRenderer.invoke('subs:set', channel, on),
  subscriptionFeed: () => ipcRenderer.invoke('subs:feed'),
  mintPoToken: (binding) => ipcRenderer.invoke('potoken:mint', binding),
  sabrReload: (id, client, reloadContext) => ipcRenderer.invoke('yt:sabrReload', id, client, reloadContext),

  setFullscreen: (on) => ipcRenderer.send('window:fullscreen', on),
  isFullscreen: () => ipcRenderer.invoke('window:isFullscreen'),
  kick: (id) => ipcRenderer.send('clients:kick', id),
  openExternal: (url) => ipcRenderer.send('open:external', url),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  accountStatus: () => ipcRenderer.invoke('account:status'),
  login: () => ipcRenderer.invoke('account:login'),
  logout: () => ipcRenderer.invoke('account:logout'),
  deviceLoginStart: () => ipcRenderer.invoke('account:deviceStart'),
  deviceLoginCancel: () => ipcRenderer.send('account:deviceCancel'),

  // Twitch
  twitchHome: (language) => ipcRenderer.invoke('tw:home', language),
  twitchMoreStreams: (language, cursor) => ipcRenderer.invoke('tw:moreStreams', language, cursor),
  twitchCategory: (name, language, cursor) => ipcRenderer.invoke('tw:category', name, language, cursor),
  twitchSearch: (q) => ipcRenderer.invoke('tw:search', q),
  twitchChannel: (login) => ipcRenderer.invoke('tw:channel', login),
  twitchChannelMore: (login, cursor) => ipcRenderer.invoke('tw:channelMore', login, cursor),
  twitchFollows: () => ipcRenderer.invoke('tw:follows'),
  twitchFollowed: () => ipcRenderer.invoke('tw:followed'),
  twitchSetFollow: (channel, on) => ipcRenderer.invoke('tw:setFollow', channel, on),
  twitchStatus: () => ipcRenderer.invoke('twitch:status'),
  twitchLoginStart: (inWindow) => ipcRenderer.invoke('twitch:loginStart', inWindow),
  twitchLoginCancel: () => ipcRenderer.send('twitch:loginCancel'),
  twitchLogout: () => ipcRenderer.invoke('twitch:logout'),
  twitchChatAuth: () => ipcRenderer.invoke('twitch:chatAuth'),
  onTwitchAccount: on('twitch:account'),
  onTwitchLogin: on('twitch:login'),
  onTwitchFollows: on('twitch:follows'),

  onLoading: on('player:loading'),
  onSource: on('player:source'),
  onError: on('player:error'),
  onVideo: on('player:video'),
  onDetails: on('player:details'),
  onSegments: on('player:segments'),
  onStop: on('player:stop'),
  onCommand: on('player:command'),
  onQueue: on('session:queue'),
  onClients: on('clients'),
  onToast: on('toast'),
  onInfo: on('app:info'),
  onSettings: on('settings'),
  onFullscreen: on('window:fullscreen'),
  onShowWatch: on('ui:watch'),
  onUpdateStatus: on('update:status'),
  onAccount: on('account'),
  onDeviceLogin: on('account:device'),
  onSubs: on('subs'),
});
