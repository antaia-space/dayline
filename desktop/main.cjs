const { app, BrowserWindow, Menu, shell, dialog, safeStorage, session, powerMonitor, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.setName('Dayline');
const dataDirectory = process.env.DAYLINE_DATA_DIR || path.join(app.getPath('appData'), 'Dayline');
app.setPath('userData', dataDirectory);
let window;
let local;
let service;
let requestedPage = '/';
let browserRequested = false;
let bookingOrigin = null;
const windowBackground = () => nativeTheme.shouldUseDarkColors ? '#1c1f1d' : '#fbfbf8';

function openBrowserPlanner() {
  if (local) return shell.openExternal(local.launchUrl());
  browserRequested = true;
}

function nativeLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'dayline:' || url.username || url.password) return;
    if (url.href === 'dayline://browser' || url.href === 'dayline://browser/') {
      void openBrowserPlanner();
      return;
    }
    if (url.hostname === 'open') requestedPage = '/';
    else if (url.hostname === 'action' && /^\/[a-f0-9]{32}$/.test(url.pathname)) {
      requestedPage = '/action' + url.pathname + (url.searchParams.get('done') === '0' ? '?done=0' : '?done=1');
    } else return;
    if (local) showPlanner(requestedPage);
  } catch { /* Ignore malformed operating-system links. */ }
}

function external(url) {
  try {
    const target = new URL(url);
    const allowed = ['accounts.google.com', 'console.cloud.google.com', 'console.developers.google.com', 'developers.google.com',
      'developers.openai.com', 'geminicli.com', 'antigravity.google', 'code.claude.com', 'claude.com'];
    if (target.protocol === 'https:' && !target.username && !target.password &&
      (allowed.includes(target.hostname) || (target.hostname === 'github.com' && target.pathname.startsWith('/antaia-space/dayline')) ||
       (bookingOrigin && target.origin === bookingOrigin) ||
       service?.meetingAgenda.containsLink(target.href))) {
      void shell.openExternal(target.href);
    }
  } catch { /* Ignore unsupported navigation. */ }
}

function showPlanner(destination = '/') {
  if (!local) return;
  if (!window || window.isDestroyed()) {
    window = new BrowserWindow({
      title: 'Dayline', width: 1240, height: 850, minWidth: 590, minHeight: 460,
      titleBarStyle: 'default', backgroundColor: windowBackground(), show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true }
    });
    window.once('ready-to-show', () => window?.show());
    window.on('closed', () => { window = null; });
    window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, value) => {
      const url = typeof value === 'string' ? value : value?.url;
      try { if (new URL(url).origin === local.origin) return; } catch {}
      event.preventDefault();
      external(url);
    });
  } else {
    window.show();
    window.focus();
    if (destination === '/' && window.webContents.getURL() === local.origin + '/') return;
  }
  void window.loadURL(local.launchUrl(destination));
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Dayline', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [
      { label: 'Show Planner', accelerator: 'CmdOrCtrl+1', click: () => showPlanner() },
      { label: 'Open in Browser', accelerator: 'CmdOrCtrl+Shift+B', click: openBrowserPlanner },
      { type: 'separator' }, { role: 'close' }
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' }
  ]));
}

function loadBundledClient(resourceDirectory) {
  const file = path.join(resourceDirectory, 'google-client.json');
  if (!fs.existsSync(file)) return null;
  const { installed } = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!installed?.client_id) throw new Error('The bundled Google configuration must be for a Desktop OAuth client.');
  return { clientId: installed.client_id, clientSecret: installed.client_secret || '' };
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('open-url', (event, value) => { event.preventDefault(); nativeLink(value); });
  app.on('second-instance', () => showPlanner());
  app.on('activate', () => { if (!window) showPlanner(); else window.show(); });
  // On macOS, closing the last window keeps calendar synchronization and event links available.
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'system';
    nativeTheme.on('updated', () => {
      if (window && !window.isDestroyed()) window.setBackgroundColor(windowBackground());
    });
    const { openStore, keychainVault } = await import('../src/store.mjs');
    const { TaskAgents } = await import('../src/agents/manager.mjs');
    const { DaylineService } = await import('../src/service.mjs');
    const { startServer } = await import('../src/http.mjs');
    const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resources');
    const estimator = path.join(resources, 'estimator');
    const vault = keychainVault(safeStorage);
    const store = openStore(dataDirectory);
    const agents = new TaskAgents({ store, helperPath: fs.existsSync(estimator) ? estimator : null });
    service = new DaylineService({ store, vault,
      estimate: (text, context) => agents.estimate(text, context), bundledClient: loadBundledClient(resources) });
    const relay = process.env.DAYLINE_PUSH_RELAY ?? 'https://dayline-calendar.antaia-space.workers.dev';
    // The person's own public booking page lives on the receiver and may be opened from Settings.
    try { bookingOrigin = relay ? new URL(relay).origin : null; } catch { bookingOrigin = null; }
    local = await startServer({ service, agents, webRoot: path.join(__dirname, '..', 'web'), port: Number(process.env.DAYLINE_PORT || 43127),
      calendarPushOptions: relay ? { origin: relay } : undefined });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    if (app.isPackaged) app.setAsDefaultProtocolClient('dayline');
    powerMonitor.on('resume', () => local.resumeCalendars());
    installMenu();
    showPlanner(requestedPage);
    if (browserRequested) void openBrowserPlanner();
  }).catch(error => {
    dialog.showErrorBox('Dayline could not open', error.code === 'EADDRINUSE' ? 'Another process is using the local planner port. Close that process and open Dayline again.' : error.message);
    app.quit();
  });
}
