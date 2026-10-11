const { app, BrowserWindow, ipcMain, dialog, clipboard, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { version } = require('../package.json');
const { dataDirectory, bridgeDirectory } = require('../shared/runtime.cjs');
const bridge = import('../shared/bridge.mjs');
const { registerCodex } = require('./codex.cjs');
const { registerVoice } = require('./voice.cjs');
let window,
  modelConfig = {};
const modelConnections = new Map();
const requests = new Map();
const liveRobot = process.argv.includes('--live-robot');
app.setName('Guard Lab');
require('node:fs').mkdirSync(dataDirectory(), { recursive: true, mode: 0o700 });
app.setPath('userData', dataDirectory());
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});
// `npm start` serves the renderer from a loopback Vite server. Packaged builds always load the
// bundled app, so a launch argument cannot point the desktop bridge at another page.
function devServerUrl() {
  const arg = process.argv.indexOf('--dev-url');
  if (arg === -1 || app.isPackaged) return null;
  try {
    const url = new URL(process.argv[arg + 1]);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
// Players get no Reload or Developer Tools: a reload silently ends the encounter and DevTools
// exposes hidden state. Development against the Vite server keeps Electron's default menu.
function setGameMenu() {
  const mac = process.platform === 'darwin';
  app.setAboutPanelOptions({ applicationName: 'Guard Lab', applicationVersion: version });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: mac ? 'appMenu' : 'fileMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
      ...(mac ? [] : [{ role: 'help', submenu: [{ role: 'about', label: 'About Guard Lab' }] }]),
    ]),
  );
}
function createWindow() {
  window = new BrowserWindow({
    show: !process.argv.includes('--test-desktop'),
    width: 1500,
    height: 1000,
    minWidth: 1080,
    minHeight: 760,
    title: 'Guard Lab',
    icon: path.join(__dirname, '../dist/icon.png'),
    backgroundColor: '#0c1013',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !liveRobot,
      autoplayPolicy: 'no-user-gesture-required',
      additionalArguments: [`--guard-lab-version=${version}`],
    },
  });
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error('[renderer]', event.message);
  });
  const url = devServerUrl();
  if (url) window.loadURL(url);
  else window.loadFile(path.join(__dirname, '../dist/index.html'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (e) => e.preventDefault());
}
function endpoint(base, suffix) {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Use an HTTP or HTTPS API base URL without credentials in the URL.');
  return base.replace(/\/$/, '') + suffix;
}
ipcMain.handle('model:configure', (_, config) => {
  endpoint(config.endpoint, '/models');
  modelConfig = {
    endpoint: config.endpoint,
    model: String(config.model),
    apiKey: String(config.apiKey || ''),
    connectionId: String(config.connectionId || ''),
  };
  modelConnections.set(
    `${modelConfig.connectionId}|${modelConfig.endpoint}|${modelConfig.model}`,
    modelConfig,
  );
  return true;
});
ipcMain.handle('model:test', async (_, config) => {
  const response = await fetch(endpoint(config.endpoint, '/models'), {
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    signal: AbortSignal.timeout(15000),
  }).catch(() => {
    throw new Error(
      `Nothing is answering at ${config.endpoint}. Start your model server (for example Ollama) and try again.`,
    );
  });
  if (!response.ok)
    throw new Error(`Connection failed (${response.status}). Check the endpoint and API key.`);
  const data = await response.json();
  return { models: (data.data || []).map((x) => x.id), ok: true };
});
ipcMain.handle(
  'model:request',
  async (_, { id, messages, tools, temperature, modelConfig: selected }) => {
    const connection = selected
      ? modelConnections.get(
          `${selected.connectionId || ''}|${selected.endpoint}|${selected.model}`,
        )
      : modelConfig;
    if (!connection?.model)
      throw new Error('Save your model connection in Model lab before starting.');
    const controller = new AbortController();
    requests.set(id, controller);
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      const body = {
        model: connection.model,
        messages,
        tools,
        tool_choice: 'auto',
        parallel_tool_calls: false,
        temperature: Number(temperature),
        stream: false,
      };
      const response = await fetch(endpoint(connection.endpoint, '/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        let details = '';
        try {
          const data = await response.json();
          details = data.error?.message || '';
        } catch {}
        if (connection.apiKey) details = details.split(connection.apiKey).join('[redacted]');
        throw new Error(`Model returned ${response.status}. ${String(details).slice(0, 500)}`);
      }
      const data = await response.json();
      if (!data.choices?.[0]?.message)
        throw new Error(
          'Endpoint returned no assistant message. Use a chat-completions model with tool support.',
        );
      return { message: data.choices[0].message, usage: data.usage || null };
    } finally {
      clearTimeout(timeout);
      requests.delete(id);
    }
  },
);
ipcMain.handle('model:cancel', (_, id) => {
  requests.get(id)?.abort();
});
ipcMain.handle('robot:session-mode', () =>
  process.argv.includes('--showcase') ? 'showcase' : liveRobot ? 'live' : null,
);
ipcMain.handle('robot:request', async (_, data) => {
  window?.webContents.setBackgroundThrottling(false);
  const actor = data.actor || 'robot';
  const controller = new AbortController();
  requests.set(data.id, controller);
  try {
    return await (
      await bridge
    ).requestTurn(bridgeDirectory(actor), data, { signal: controller.signal });
  } finally {
    requests.delete(data.id);
  }
});
ipcMain.handle('robot:result', async (_, { actor, observation, ended }) =>
  (await bridge).reportResult(bridgeDirectory(actor), { observation, ended }),
);
ipcMain.handle('robot:reset', async (_, actors) => {
  if (actors.length) window?.webContents.setBackgroundThrottling(false);
  for (const controller of requests.values()) controller.abort();
  for (const actor of actors) await (await bridge).resetChannel(bridgeDirectory(actor));
});
ipcMain.handle('clipboard:write', (_, text) => {
  clipboard.writeText(String(text ?? '').slice(0, 20000));
  return true;
});
ipcMain.handle('file:export', async (_, record) => {
  const result = await dialog.showSaveDialog(window, {
    title: 'Export experiment',
    defaultPath: `guard-lab-${record.id}.json`,
    filters: [{ name: 'Experiment transcript', extensions: ['json'] }],
  });
  if (result.canceled) return false;
  await fs.writeFile(result.filePath, JSON.stringify(record, null, 2), 'utf8');
  return true;
});
const codex = registerCodex({ ipcMain, getWindow: () => window });
const voice = registerVoice({ ipcMain, getWindow: () => window, app });
app.whenReady().then(async () => {
  // macOS ignores BrowserWindow.icon; packaged builds carry the icon, source runs set the Dock.
  if (process.platform === 'darwin' && !app.isPackaged)
    app.dock?.setIcon(path.join(__dirname, '../public/icon.png'));
  const protocol = await bridge;
  await Promise.allSettled(
    ['robot', 'human'].map((actor) => protocol.resetChannel(bridgeDirectory(actor))),
  );
  voice.ready?.();
  if (!devServerUrl()) setGameMenu();
  createWindow();
});
app.on('window-all-closed', () => {
  for (const c of requests.values()) c.abort();
  codex.close?.();
  voice.close?.();
  app.quit();
});
