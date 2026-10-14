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

  setFullscreen: (on) => ipcRenderer.send('window:fullscreen', on),
  isFullscreen: () => ipcRenderer.invoke('window:isFullscreen'),
  kick: (id) => ipcRenderer.send('clients:kick', id),
  openExternal: (url) => ipcRenderer.send('open:external', url),

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
});
