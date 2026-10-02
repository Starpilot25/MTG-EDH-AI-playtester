// Desktop app: runs the playtester's local server inside the app and opens it in a window.
const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const path = require('path');

const updater = require('./updater.js');

// Saved decks and settings live in the app's own data folder.
process.env.EDH_DATA_DIR = app.getPath('userData');
let start; // the server is loaded after the update check, so it serves the newest game files

// A fixed port keeps your settings (they're stored per address); fall back if it's taken.
const PORTS = [47173, 47174, 47175, 47176, 0];

async function startServer() {
  for (const p of PORTS) {
    try {
      return await start(p, '127.0.0.1');
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error('No free port');
}

let win;
async function createWindow() {
  let port;
  let upd = { version: app.getVersion(), source: 'built-in' };
  try {
    upd = await updater.prepare({ appDir: __dirname, dataDir: app.getPath('userData'), appVersion: app.getVersion(), log: (m) => console.log(m) });
  } catch (e) {
    console.log('Update check failed: ' + e.message);
  }
  if (upd.dir) process.env.EDH_PUBLIC_DIR = upd.dir;
  process.env.EDH_VERSION = upd.version;
  process.env.EDH_VERSION_SOURCE = upd.justUpdated ? 'just updated' : upd.source;
  if (upd.needsReinstall) process.env.EDH_NEEDS_REINSTALL = upd.needsReinstall;
  start = require('./server.js').start;
  try {
    port = await startServer();
  } catch (e) {
    dialog.showErrorBox('EDH Playtester', 'Could not start: ' + e.message);
    app.quit();
    return;
  }
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    title: `EDH Playtester ${upd.version}`,
    backgroundColor: '#0f1a15',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  win.on('page-title-updated', (e) => e.preventDefault()); // keep the version in the title bar
  // links to Moxfield, Scryfall etc. open in your browser
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // pop-out boards for a second screen open as app windows
    if (/^edh-board-/.test(frameName || '') && (url === 'about:blank' || url === '' || url.startsWith(`http://127.0.0.1:${port}`))) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 1200, height: 720, backgroundColor: '#0f1a15', autoHideMenuBar: true, icon: path.join(__dirname, 'build', 'icon.png') },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
}

const template = [
  ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
  { role: 'editMenu' },
  {
    label: 'View',
    submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' }, { role: 'toggleDevTools' }],
  },
  { role: 'windowMenu' },
];

// one window only: opening the app again focuses it
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => app.quit());
}
