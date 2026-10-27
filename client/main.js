const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { Cache, Assets } = require('./lib/cache');
const { discover } = require('./lib/discovery');
const { startLocalServer } = require('./lib/local-server');

// LIRO_PROFILE=<dir> runs the client with a separate settings/cache folder (e.g. two clients on one PC).
if (process.env.LIRO_PROFILE) app.setPath('userData', path.resolve(process.env.LIRO_PROFILE));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const userData = app.getPath('userData');
const settingsFile = path.join(userData, 'settings.json');
const cache = new Cache(path.join(userData, 'cache'));
const assets = new Assets(path.join(userData, 'assets'));
let localPort = 0;
let mainWindow = null;

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(s) {
  fs.mkdirSync(userData, { recursive: true });
  const tmp = `${settingsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, settingsFile);
}

function localMediaUrl(serverId, boardId, name) {
  return cache.hasMedia(serverId, boardId, name)
    ? `http://127.0.0.1:${localPort}/cache/${encodeURIComponent(serverId)}/${encodeURIComponent(boardId)}/${name}`
    : null;
}

function registerIpc() {
  ipcMain.handle('discover', () => discover());
  // Server backups etc.: Electron shows a save dialog for the download.
  ipcMain.handle('download', (_e, url) => { if (/^https?:\/\//.test(url) && mainWindow) mainWindow.webContents.downloadURL(url); });
  ipcMain.handle('settings:get', () => readSettings());
  ipcMain.handle('settings:set', (_e, s) => writeSettings(s || {}));

  ipcMain.handle('cache:load', (_e, serverId, boardId) => cache.load(serverId, boardId));
  ipcMain.handle('cache:save', (_e, serverId, boardId, data) => cache.save(serverId, boardId, data));
  ipcMain.handle('cache:remove', (_e, serverId, boardId) => cache.remove(serverId, boardId));
  ipcMain.handle('cache:list', (_e, serverId) => cache.list(serverId));

  ipcMain.on('media:localUrl', (e, serverId, boardId, name) => {
    try {
      e.returnValue = localMediaUrl(serverId, boardId, name);
    } catch {
      e.returnValue = null;
    }
  });
  ipcMain.handle('media:save', async (_e, serverId, boardId, name, buffer) => {
    await cache.saveMedia(serverId, boardId, name, buffer);
    return localMediaUrl(serverId, boardId, name);
  });
  ipcMain.handle('media:download', async (_e, serverUrl, serverId, boardId, name) => {
    try {
      return (await cache.downloadMedia(serverUrl, serverId, boardId, name)) ? localMediaUrl(serverId, boardId, name) : null;
    } catch {
      return null;
    }
  });
  ipcMain.handle('media:upload', (_e, serverUrl, targetBoardId, serverId, sourceBoardId, name) =>
    cache.uploadMedia(serverUrl, targetBoardId, serverId, sourceBoardId, name));
  ipcMain.handle('media:read', async (_e, serverId, boardId, name) => {
    try { return await fs.promises.readFile(cache.mediaFile(serverId, boardId, name)); } catch { return null; }
  });

  ipcMain.handle('assets:list', async (_e, kind) => (await assets.list(kind)).map((name) => ({
    name, url: `http://127.0.0.1:${localPort}/assets/${kind}/${encodeURIComponent(name)}`,
  })));
  ipcMain.handle('assets:save', async (_e, kind, name, buffer) => {
    await assets.save(kind, name, buffer);
    return `http://127.0.0.1:${localPort}/assets/${kind}/${encodeURIComponent(name)}`;
  });
  ipcMain.handle('assets:read', (_e, kind, name) => assets.read(kind, name));
  ipcMain.handle('assets:remove', (_e, kind, name) => assets.remove(kind, name));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 500,
    title: 'Liro',
    icon: path.join(__dirname, 'web', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${localPort}/index.html`);

  // Links (e.g. "download file") open in the system browser instead of new Electron windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${localPort}/`)) e.preventDefault();
  });
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      mainWindow.webContents.toggleDevTools();
    }
    if (input.type === 'keyDown' && (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r'))) {
      mainWindow.webContents.reload();
    }
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerIpc();
  const { port } = await startLocalServer(path.join(__dirname, 'web'), cache, assets);
  localPort = port;
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
