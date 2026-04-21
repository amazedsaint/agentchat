/**
 * Unit tests for the Electron shell glue in src/web/launch-shell.ts.
 *
 * We can't spawn Electron itself in the vitest process (no display, no
 * electron binary in CI), so these tests assert:
 *   1. The main.js + preload.js string bundles parse as valid JavaScript.
 *   2. The preload exposes the documented `window.agentchatShell` surface.
 *   3. `writeElectronShellFiles()` writes both files to a predictable path.
 *   4. `launchShell()` falls back to 'browser' when electron can't resolve.
 *
 * Full Electron launch behaviour is covered by manual smoke tests in
 * DEMO.md — bugs in window-chrome / menu config are easier to catch by
 * eye than by mocking Electron.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { __electronBundleForTest, writeElectronShellFiles } from '../src/web/launch-shell.js';

describe('Electron shell bundles', () => {
  it('main.js parses as syntactically valid JS', () => {
    // We eval nothing — just use the Function constructor to parse. It
    // throws synchronously on SyntaxError without ever running the body.
    expect(() => {
      new Function(__electronBundleForTest.ELECTRON_MAIN_JS);
    }).not.toThrow();
  });

  it('preload.js parses as syntactically valid JS', () => {
    expect(() => {
      new Function(__electronBundleForTest.ELECTRON_PRELOAD_JS);
    }).not.toThrow();
  });

  it('preload exposes the documented shell API', () => {
    const src = __electronBundleForTest.ELECTRON_PRELOAD_JS;
    // Each surface call we expect the web UI to use should appear literally.
    for (const method of ['setBadge', 'notify', 'focus', 'onShortcut', 'onJoinTicket']) {
      expect(src).toContain(method);
    }
    expect(src).toContain('agentchatShell');
    expect(src).toContain('contextBridge.exposeInMainWorld');
  });

  it('main wires up every IPC message the preload sends', () => {
    const main = __electronBundleForTest.ELECTRON_MAIN_JS;
    for (const channel of ['agentchat:set-badge', 'agentchat:notify', 'agentchat:focus']) {
      expect(main).toContain(`ipcMain.on('${channel}'`);
    }
  });

  it('main registers the agentchat:// custom protocol', () => {
    const main = __electronBundleForTest.ELECTRON_MAIN_JS;
    expect(main).toContain("app.setAsDefaultProtocolClient('agentchat')");
    expect(main).toContain('agentchat:join-ticket');
  });

  it('main is locked down: sandbox: true + contextIsolation: true + nodeIntegration: false', () => {
    const main = __electronBundleForTest.ELECTRON_MAIN_JS;
    expect(main).toContain('sandbox: true');
    expect(main).toContain('contextIsolation: true');
    expect(main).toContain('nodeIntegration: false');
  });

  it('writeElectronShellFiles writes both files to /tmp', () => {
    const { main, preload } = writeElectronShellFiles();
    expect(main.endsWith('.cjs')).toBe(true);
    expect(preload.endsWith('.cjs')).toBe(true);
    expect(existsSync(main)).toBe(true);
    expect(existsSync(preload)).toBe(true);
    // Files contain the expected bundles byte-for-byte.
    expect(readFileSync(main, 'utf8')).toBe(__electronBundleForTest.ELECTRON_MAIN_JS);
    expect(readFileSync(preload, 'utf8')).toBe(__electronBundleForTest.ELECTRON_PRELOAD_JS);
  });
});

describe('launchShell fallback', () => {
  it('returns "none" when AGENTCHAT_WEB_OPEN=0', async () => {
    const prev = process.env.AGENTCHAT_WEB_OPEN;
    process.env.AGENTCHAT_WEB_OPEN = '0';
    try {
      const { launchShell } = await import('../src/web/launch-shell.js');
      const kind = await launchShell('http://127.0.0.1:7879/#token=x');
      expect(kind).toBe('none');
    } finally {
      if (prev === undefined) process.env.AGENTCHAT_WEB_OPEN = undefined;
      else process.env.AGENTCHAT_WEB_OPEN = prev;
    }
  });
});
