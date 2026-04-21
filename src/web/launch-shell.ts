import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryOpenBrowser } from './open-browser.js';

/**
 * Runtime decision on how to surface the web UI once the server is up:
 *
 *   1. respect AGENTCHAT_WEB_OPEN=0 → do nothing (user has the URL)
 *   2. SSH session                   → do nothing; user is on the terminal
 *   3. no display (Linux)            → do nothing
 *   4. AGENTCHAT_FORCE_BROWSER=1     → skip electron, go straight to browser
 *   5. electron resolvable           → launch the Electron shell
 *   6. otherwise                     → open the default browser
 *
 * The Electron shell loads the same `http://127.0.0.1:7879/#token=…` URL, so
 * TUI / web / Electron are automatically on parity. Extras the shell adds:
 *   - native app name + about panel (not "Electron")
 *   - window state persistence in ~/.agentchat/electron-window.json
 *   - dock/taskbar badge driven by the web UI via a preload bridge
 *   - native notifications forwarded from the web UI
 *   - `agentchat://join/<ticket>` custom protocol for one-click invite links
 *   - splash + retry when the server isn't quite up yet
 */

export type ShellKind = 'electron' | 'browser' | 'none';

const APP_NAME = 'agentchat';

const ELECTRON_MAIN_JS = String.raw`
'use strict';
const { app, BrowserWindow, Menu, Notification, ipcMain, shell, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const url = process.argv[process.argv.length - 1];
const preloadPath = process.env.AGENTCHAT_PRELOAD || '';
const appVersion = process.env.AGENTCHAT_VERSION || '0.0.0';

// Preserve the token in the URL across navigations — the renderer never
// needs to re-prompt because the hash already carries it.
const initialUrl = url;
let mainWindow = null;
let splashWindow = null;

app.setName('agentchat');
app.setAboutPanelOptions({
  applicationName: 'agentchat',
  applicationVersion: appVersion,
  credits: 'P2P end-to-end encrypted chat for agents and humans.',
});

// Custom protocol: agentchat://join/<ticket> — handed off to the renderer
// via IPC when it's ready (or stashed until then).
let pendingProtocolUrl = null;
app.setAsDefaultProtocolClient('agentchat');

// Single-instance lock — second launch focuses the first window instead of
// opening a duplicate, and any protocol URL in argv[] is forwarded.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const extra = argv.find((a) => a.startsWith('agentchat://'));
    if (extra) handleProtocolUrl(extra);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on('open-url', (event, target) => {
    event.preventDefault();
    handleProtocolUrl(target);
  });
}

function handleProtocolUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.hostname !== 'join') return;
    const ticket = parsed.pathname.replace(/^\//, '') + (parsed.search || '');
    if (!ticket) return;
    if (mainWindow) {
      mainWindow.webContents.send('agentchat:join-ticket', ticket);
    } else {
      pendingProtocolUrl = ticket;
    }
  } catch {
    /* ignore malformed */
  }
}

// ---------- window state persistence ----------
const stateFile = path.join(os.homedir(), '.agentchat', 'electron-window.json');
function loadState() {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const s = JSON.parse(raw);
    if (
      typeof s.width === 'number' &&
      typeof s.height === 'number' &&
      s.width >= 400 &&
      s.height >= 300
    ) {
      return s;
    }
  } catch { /* first run or unreadable */ }
  return { width: 1200, height: 800 };
}
function saveState(win) {
  try {
    const b = win.getBounds();
    const s = {
      width: b.width,
      height: b.height,
      x: b.x,
      y: b.y,
      maximized: win.isMaximized(),
    };
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(s));
  } catch { /* best-effort */ }
}

// ---------- splash ----------
function showSplash() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 220,
    resizable: false,
    movable: true,
    frame: false,
    alwaysOnTop: false,
    transparent: true,
    show: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  const splashHtml = [
    '<!doctype html><meta charset="utf-8">',
    '<style>',
    'html,body{margin:0;height:100%;background:transparent;color:#e6e6e6;',
    'font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,sans-serif;',
    'display:grid;place-items:center;}',
    '.card{background:#1f1f22;border-radius:14px;padding:22px 28px;box-shadow:',
    '0 20px 50px rgba(0,0,0,.4);text-align:center;border:1px solid #333;}',
    '.title{font-size:22px;font-weight:700;letter-spacing:.01em;}',
    '.sub{font-size:13px;color:#a5a5ad;margin-top:8px;}',
    '.dot{display:inline-block;width:6px;height:6px;border-radius:50%;',
    'background:#4ea3ff;margin-left:8px;animation:p 1s ease-in-out infinite;}',
    '@keyframes p{0%,100%{opacity:.4}50%{opacity:1}}',
    '</style>',
    '<div class="card">',
    '<div class="title">agentchat</div>',
    '<div class="sub">connecting<span class="dot"></span></div>',
    '</div>',
  ].join('');
  splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml));
  splashWindow.on('closed', () => { splashWindow = null; });
}
function closeSplash() {
  if (splashWindow) { splashWindow.close(); splashWindow = null; }
}

// ---------- retry loading the main URL ----------
async function loadWithRetry(win, target, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    try {
      await win.loadURL(target);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const modAccel = isMac ? 'Cmd' : 'Ctrl';
  const roomAccel = (n) => modAccel + '+' + n;
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New room…',
          accelerator: modAccel + '+N',
          click() { mainWindow && mainWindow.webContents.send('agentchat:shortcut', 'new-room'); },
        },
        {
          label: 'Join by ticket…',
          accelerator: modAccel + '+Shift+J',
          click() { mainWindow && mainWindow.webContents.send('agentchat:shortcut', 'join'); },
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Rooms',
      submenu: Array.from({ length: 9 }, (_, i) => ({
        label: 'Room ' + (i + 1),
        accelerator: roomAccel(i + 1),
        click() {
          mainWindow && mainWindow.webContents.send('agentchat:shortcut', 'room-' + (i + 1));
        },
      })),
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        { label: 'Open in browser', click() { shell.openExternal(initialUrl); } },
        {
          label: 'About agentchat',
          click() {
            dialog.showMessageBox({
              type: 'info',
              title: 'About agentchat',
              message: 'agentchat',
              detail:
                'Version ' + appVersion + '\nP2P end-to-end encrypted chat.\n\n' +
                'Window URL: ' + initialUrl,
              buttons: ['OK'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const state = loadState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 640,
    minHeight: 420,
    title: 'agentchat',
    backgroundColor: '#212121',
    show: false, // show after first paint to avoid a white flash
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath || undefined,
    },
  });
  if (state.maximized) mainWindow.maximize();

  // Any navigation that leaves the expected host opens in the real browser.
  const expectedHost = new URL(initialUrl).host;
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, target) => {
    try {
      const u = new URL(target);
      if (u.host !== expectedHost) {
        e.preventDefault();
        shell.openExternal(target);
      }
    } catch { /* ignore */ }
  });

  mainWindow.once('ready-to-show', () => {
    closeSplash();
    mainWindow.show();
    if (pendingProtocolUrl) {
      mainWindow.webContents.send('agentchat:join-ticket', pendingProtocolUrl);
      pendingProtocolUrl = null;
    }
  });

  // Debounced state save to avoid a write per resize pixel.
  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveState(mainWindow), 400);
  };
  mainWindow.on('resize', scheduleSave);
  mainWindow.on('move', scheduleSave);
  mainWindow.on('maximize', scheduleSave);
  mainWindow.on('unmaximize', scheduleSave);
  mainWindow.on('close', () => saveState(mainWindow));

  loadWithRetry(mainWindow, initialUrl).then((ok) => {
    if (!ok) {
      mainWindow.webContents.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            '<!doctype html><meta charset=utf-8>' +
              '<style>html,body{background:#1f1f22;color:#ddd;font-family:sans-serif;' +
              'padding:40px;}a{color:#4ea3ff}</style>' +
              '<h2>Cannot reach the agentchat server</h2>' +
              '<p>Tried: <code>' + initialUrl + '</code></p>' +
              '<p>Start it with <code>agentchat web</code>, then reload (Cmd/Ctrl+R).</p>',
          ),
      );
      mainWindow.show();
    }
  });
}

// ---------- IPC bridge: renderer → main ----------
ipcMain.on('agentchat:set-badge', (_event, count) => {
  if (typeof count !== 'number' || count < 0) count = 0;
  if (process.platform === 'darwin') {
    app.dock && app.dock.setBadge(count > 0 ? String(count) : '');
  } else {
    // Linux / Windows: use Electron's unified badge API when available.
    try { app.setBadgeCount(count); } catch { /* not all platforms */ }
  }
});
ipcMain.on('agentchat:notify', (_event, payload) => {
  const { title = 'agentchat', body = '' } = payload || {};
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: String(title).slice(0, 200), body: String(body).slice(0, 400) });
  n.on('click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
  n.show();
});
ipcMain.on('agentchat:focus', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
});

// ---------- lifecycle ----------
app.whenReady().then(() => {
  showSplash();
  buildMenu();
  createWindow();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
`;

/** Runs in a sandboxed renderer; exposes a minimal API to the web UI. */
const ELECTRON_PRELOAD_JS = String.raw`
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentchatShell', {
  isElectron: true,
  setBadge(count) {
    ipcRenderer.send('agentchat:set-badge', Number(count) | 0);
  },
  notify(title, body) {
    ipcRenderer.send('agentchat:notify', {
      title: String(title || '').slice(0, 200),
      body: String(body || '').slice(0, 400),
    });
  },
  focus() {
    ipcRenderer.send('agentchat:focus');
  },
  onShortcut(cb) {
    ipcRenderer.on('agentchat:shortcut', (_e, name) => cb(name));
  },
  onJoinTicket(cb) {
    ipcRenderer.on('agentchat:join-ticket', (_e, ticket) => cb(ticket));
  },
});
`;

function isOverSsh(): boolean {
  return !!(process.env.SSH_CLIENT || process.env.SSH_CONNECTION || process.env.SSH_TTY);
}

function hasDisplay(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

async function resolveElectron(): Promise<string | null> {
  if (process.env.AGENTCHAT_FORCE_BROWSER === '1') return null;
  try {
    // Optional runtime dep — dynamic specifier keeps TS from resolving types
    // at build time and keeps tsup from bundling electron into dist/.
    const specifier = 'electron';
    const mod: any = await import(specifier);
    const bin = (typeof mod === 'string' ? mod : mod?.default) as string | undefined;
    return bin && typeof bin === 'string' ? bin : null;
  } catch {
    return null;
  }
}

export function writeElectronShellFiles(): { main: string; preload: string } {
  const main = join(tmpdir(), `agentchat-electron-main-${process.pid}.cjs`);
  const preload = join(tmpdir(), `agentchat-electron-preload-${process.pid}.cjs`);
  writeFileSync(main, ELECTRON_MAIN_JS);
  writeFileSync(preload, ELECTRON_PRELOAD_JS);
  return { main, preload };
}

/**
 * Decide the best shell for the current platform/session and launch it.
 * Returns which kind was used so the caller can log appropriately. Always
 * non-blocking; Electron is spawned detached so it outlives this process.
 */
export async function launchShell(
  url: string,
  opts: { version?: string } = {},
): Promise<ShellKind> {
  if (process.env.AGENTCHAT_WEB_OPEN === '0') return 'none';
  if (isOverSsh()) return 'none';
  if (!hasDisplay()) return 'none';

  const electronBin = await resolveElectron();
  if (electronBin) {
    try {
      const { main, preload } = writeElectronShellFiles();
      const child = spawn(electronBin, [main, url], {
        stdio: 'ignore',
        detached: true,
        env: {
          ...process.env,
          AGENTCHAT_PRELOAD: preload,
          AGENTCHAT_VERSION: opts.version || process.env.AGENTCHAT_VERSION || '0.0.0',
          // Suppress Electron's own logging noise in the parent's stderr.
          ELECTRON_NO_ATTACH_CONSOLE: '1',
        },
      });
      child.on('error', () => {
        /* swallow — browser fallback handled below */
      });
      child.unref();
      return 'electron';
    } catch {
      // fall through to browser
    }
  }

  tryOpenBrowser(url);
  return 'browser';
}

/** Exposed for tests only. */
export const __electronBundleForTest = {
  APP_NAME,
  ELECTRON_MAIN_JS,
  ELECTRON_PRELOAD_JS,
};
