import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryOpenBrowser } from './open-browser.js';

/**
 * Runtime decision on *how* to surface the web UI once the server is up:
 *
 *   1. respect AGENTCHAT_WEB_OPEN=0 → do nothing (user has the URL)
 *   2. SSH session           → do nothing; user is on the terminal, opening a
 *                              local window would be wrong
 *   3. no display (Linux)    → do nothing
 *   4. AGENTCHAT_FORCE_BROWSER=1 → skip electron, go straight to browser
 *   5. electron installed    → launch the Electron shell (web UI wrapped as
 *                              a native window)
 *   6. otherwise             → open the default browser
 *
 * The Electron shell just loads the same `http://127.0.0.1:7879/#token=…`
 * URL, so TUI / web / Electron are automatically on parity.
 */

export type ShellKind = 'electron' | 'browser' | 'none';

const ELECTRON_MAIN_JS = String.raw`
'use strict';
const { app, BrowserWindow, Menu, shell } = require('electron');
const url = process.argv[process.argv.length - 1];

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 420,
    title: 'agentchat',
    backgroundColor: '#212121',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(url);
  // Any navigations that leave our host get opened in the real browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    try {
      const u = new URL(target);
      if (u.host !== new URL(url).host) {
        e.preventDefault();
        shell.openExternal(target);
      }
    } catch { /* ignore */ }
  });
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        { label: 'Open in browser', click() { shell.openExternal(url); } },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(createWindow);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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
    // Electron is an optional runtime dep — may not be installed. We use a
    // dynamic specifier to keep TS from resolving types at build time (no
    // @types/electron needed) and to keep tsup from inlining it.
    const specifier = 'electron';
    const mod: any = await import(specifier);
    const bin = (typeof mod === 'string' ? mod : mod?.default) as string | undefined;
    return bin && typeof bin === 'string' ? bin : null;
  } catch {
    return null;
  }
}

function writeElectronMain(): string {
  const path = join(tmpdir(), `agentchat-electron-${process.pid}.cjs`);
  writeFileSync(path, ELECTRON_MAIN_JS);
  return path;
}

/**
 * Decide the best shell for the current platform/session and launch it.
 * Returns which kind was used so the caller can log appropriately. Always
 * non-blocking; Electron is spawned detached so it outlives this process.
 */
export async function launchShell(url: string): Promise<ShellKind> {
  if (process.env.AGENTCHAT_WEB_OPEN === '0') return 'none';
  if (isOverSsh()) return 'none';
  if (!hasDisplay()) return 'none';

  const electronBin = await resolveElectron();
  if (electronBin) {
    try {
      const mainFile = writeElectronMain();
      const child = spawn(electronBin, [mainFile, url], {
        stdio: 'ignore',
        detached: true,
      });
      child.on('error', () => {
        /* swallow — fall through logged by caller */
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
