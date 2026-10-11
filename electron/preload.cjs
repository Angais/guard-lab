const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel) => (callback) => {
  const listener = (_, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
const versionArg = '--guard-lab-version=';
contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  version: (process.argv.find((arg) => arg.startsWith(versionArg)) || '').slice(versionArg.length),
  configureModel: (config) => ipcRenderer.invoke('model:configure', config),
  testModel: (config) => ipcRenderer.invoke('model:test', config),
  requestModel: (data) => ipcRenderer.invoke('model:request', data),
  requestRobot: (data) => ipcRenderer.invoke('robot:request', data),
  reportResult: (data) => ipcRenderer.invoke('robot:result', data),
  resetBridge: (actors) => ipcRenderer.invoke('robot:reset', actors),
  sessionMode: () => ipcRenderer.invoke('robot:session-mode'),
  cancelModel: (id) => ipcRenderer.invoke('model:cancel', id),
  exportRecord: (record) => ipcRenderer.invoke('file:export', record),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  codex: {
    status: (options) => ipcRenderer.invoke('codex:status', options),
    onStatus: subscribe('codex:status'),
    login: (options) => ipcRenderer.invoke('codex:login', options),
    cancelLogin: () => ipcRenderer.invoke('codex:cancel-login'),
    models: (options) => ipcRenderer.invoke('codex:models', options),
    prepare: (data) => ipcRenderer.invoke('codex:prepare', data),
    request: (data) => ipcRenderer.invoke('codex:request', data),
    cancel: (id) => ipcRenderer.invoke('codex:cancel', id),
    reset: (sessionId) => ipcRenderer.invoke('codex:reset', sessionId),
  },
  voice: {
    status: () => ipcRenderer.invoke('voice:status'),
    onStatus: subscribe('voice:status'),
    install: (kind) => ipcRenderer.invoke('voice:install', kind),
    remove: (kind) => ipcRenderer.invoke('voice:remove', kind),
    voices: () => ipcRenderer.invoke('voice:voices'),
    synthesize: (data) => ipcRenderer.invoke('voice:synthesize', data),
    transcribe: (data) => ipcRenderer.invoke('voice:transcribe', data),
    microphone: (request) => ipcRenderer.invoke('voice:microphone', request),
  },
});
