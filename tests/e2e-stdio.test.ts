/**
 * End-to-end stdio MCP subprocess test.
 *
 * Spawns the real built `dist/bin/droidring-mcp.js`, drives it via
 * newline-delimited JSON-RPC, and asserts the full tool contract works:
 *   - initialize → capabilities + protocolVersion
 *   - tools/list → every tool we registered
 *   - tools/call (chat_whoami) → structured content
 *   - tools/call on a bad tool → JSON-RPC error shape
 *
 * This catches transport-level regressions (stdio framing, JSON-RPC shape,
 * initialization handshake) that the in-process tests can't.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface Rpc {
  id: number;
  method: string;
  params?: any;
  jsonrpc: '2.0';
}

class StdioClient {
  private child!: ChildProcess;
  private buf = '';
  private pending = new Map<number, (msg: any) => void>();
  private nextId = 1;
  readonly droidringHome: string;
  cwd: string | undefined;
  envOverrides: Record<string, string> = {};

  constructor() {
    this.droidringHome = mkdtempSync(join(tmpdir(), 'droidring-e2e-'));
  }

  async start(): Promise<void> {
    const bin = join(process.cwd(), 'dist/bin/droidring-mcp.js');
    this.child = spawn(process.execPath, [bin], {
      cwd: this.cwd,
      env: {
        ...process.env,
        DROIDRING_HOME: this.droidringHome,
        DROIDRING_WEB_OPEN: '0',
        // Default: skip repo-room auto-join so the subprocess doesn't touch
        // the public DHT. Individual tests that WANT the auto-join set
        // envOverrides = { DROIDRING_SWARM_DISABLE: '1' } and clear this.
        DROIDRING_NO_REPO_ROOM: '1',
        ...this.envOverrides,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout!.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString('utf8');
      let idx = this.buf.indexOf('\n');
      while (idx !== -1) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (line.trim().length > 0) {
          try {
            const msg = JSON.parse(line);
            const cb = this.pending.get(msg.id);
            if (cb) {
              this.pending.delete(msg.id);
              cb(msg);
            }
          } catch {
            /* ignore non-JSON lines */
          }
        }
        idx = this.buf.indexOf('\n');
      }
    });
    // Wait for process to actually be ready. A poke-initialize works well.
    await new Promise((r) => setTimeout(r, 200));
  }

  send(method: string, params?: any): Promise<any> {
    const id = this.nextId++;
    const rpc: Rpc = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout on ${method}`));
      }, 5000);
      this.pending.set(id, (msg) => {
        clearTimeout(timeout);
        resolve(msg);
      });
      this.child.stdin!.write(`${JSON.stringify(rpc)}\n`);
    });
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    this.child.stdin!.end();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          this.child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 1000);
      this.child.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    try {
      rmSync(this.droidringHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

describe('E2E stdio MCP subprocess', () => {
  const client = new StdioClient();

  beforeAll(async () => {
    await client.start();
  }, 15_000);

  afterAll(async () => {
    await client.stop();
  });

  it('initialize returns a protocol version and server info', async () => {
    const res = await client.send('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'e2e-test', version: '1.0.0' },
    });
    expect(res.result).toBeTruthy();
    expect(res.result.protocolVersion).toBeTruthy();
    expect(res.result.serverInfo.name).toBeTruthy();
  });

  it('tools/list enumerates at least the core chat tools', async () => {
    // Send initialized notification first — some SDKs require it.
    client.send('notifications/initialized', {}).catch(() => {});
    const res = await client.send('tools/list', {});
    expect(res.result).toBeTruthy();
    const names = res.result.tools.map((t: any) => t.name);
    for (const expected of [
      'chat_whoami',
      'chat_create_room',
      'chat_join_room',
      'chat_send_message',
      'chat_fetch_history',
      'chat_kick',
    ]) {
      expect(names).toContain(expected);
    }
    // Every tool has a non-empty description
    for (const t of res.result.tools) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema).toBeTruthy();
    }
  });

  it('chat_whoami returns a pubkey and nickname', async () => {
    const res = await client.send('tools/call', {
      name: 'chat_whoami',
      arguments: {},
    });
    expect(res.result).toBeTruthy();
    expect(res.result.structuredContent).toBeTruthy();
    expect(res.result.structuredContent.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof res.result.structuredContent.nickname).toBe('string');
  });

  it('chat_create_room + chat_send_message + chat_fetch_history over stdio', async () => {
    const create = await client.send('tools/call', {
      name: 'chat_create_room',
      arguments: { name: '#stdio-test' },
    });
    expect(create.result.structuredContent.ticket).toBeTruthy();
    const roomId = create.result.structuredContent.room_id;
    expect(roomId).toMatch(/^[0-9a-f]{64}$/);

    const send = await client.send('tools/call', {
      name: 'chat_send_message',
      arguments: { room: roomId, text: 'over the wire' },
    });
    expect(send.result.structuredContent.message_id).toBeTruthy();

    const hist = await client.send('tools/call', {
      name: 'chat_fetch_history',
      arguments: { room: roomId, limit: 10 },
    });
    expect(
      hist.result.structuredContent.messages.some((m: any) => m.text === 'over the wire'),
    ).toBe(true);
  });

  it('tools/call with an unknown tool surfaces an MCP-compliant error', async () => {
    const res = await client.send('tools/call', {
      name: 'chat_nonexistent_tool',
      arguments: {},
    });
    // MCP error surface: either JSON-RPC `error` OR result.isError=true with
    // an explanatory content entry. Both are acceptable per the spec.
    expect(res.error || res.result?.isError).toBeTruthy();
  });

  it('tools/call with malformed args returns isError + structured reason', async () => {
    const res = await client.send('tools/call', {
      name: 'chat_send_message',
      // missing required `text`, which zod should reject
      arguments: { room: '#x' },
    });
    expect(res.error || res.result?.isError).toBeTruthy();
  });
});

describe('E2E multiple agents one user — session grouping by repo', () => {
  it('same user, two MCP processes, two different github repos → sessions tagged with their repo', async () => {
    const { mkdirSync, writeFileSync, realpathSync } = await import('node:fs');
    const home = mkdtempSync(join(tmpdir(), 'droidring-multi-repo-'));
    const repoA = mkdtempSync(join(tmpdir(), 'repoA-'));
    const repoB = mkdtempSync(join(tmpdir(), 'repoB-'));
    for (const [dir, url] of [
      [repoA, 'https://github.com/acme/foo.git'],
      [repoB, 'https://github.com/acme/bar.git'],
    ] as const) {
      mkdirSync(join(dir, '.git'), { recursive: true });
      writeFileSync(join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`);
    }

    function buildClient(cwd: string): StdioClient {
      const c = new StdioClient();
      (c as any).droidringHome = home;
      c.cwd = cwd;
      // Keep repo-auto-join ON (unset the StdioClient default), but skip
      // the real DHT so this doesn't hit the public network.
      c.envOverrides = { DROIDRING_NO_REPO_ROOM: '', DROIDRING_SWARM_DISABLE: '1' };
      return c;
    }
    const a = buildClient(repoA);
    const b = buildClient(repoB);

    try {
      // Serialise the boot — two concurrent subprocesses racing ALTER TABLE
      // on a fresh sqlite can deadlock briefly.
      await a.start();
      await a.send('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'e2e-multi-repo', version: '1.0.0' },
      });
      await b.start();
      await b.send('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'e2e-multi-repo', version: '1.0.0' },
      });

      const res = await a.send('tools/call', {
        name: 'chat_list_sessions',
        arguments: {},
      });
      const aPid = (a as any).child.pid;
      const bPid = (b as any).child.pid;
      const sessions = res.result.structuredContent.sessions;
      const mine = sessions.filter((s: any) => s.pid === aPid || s.pid === bPid);
      expect(mine.length).toBe(2);
      // realpath: macOS /tmp → /private/tmp; the subprocess reports resolved.
      const cwds = new Set(mine.map((s: any) => s.cwd));
      expect(cwds.has(realpathSync(repoA))).toBe(true);
      expect(cwds.has(realpathSync(repoB))).toBe(true);
      const repoNames = new Set(mine.map((s: any) => s.repo_name).filter(Boolean));
      expect(repoNames.has('#acme/foo')).toBe(true);
      expect(repoNames.has('#acme/bar')).toBe(true);
    } finally {
      await a.stop();
      await b.stop();
      try {
        rmSync(home, { recursive: true, force: true });
        rmSync(repoA, { recursive: true, force: true });
        rmSync(repoB, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }, 30_000);
});

describe('E2E multi-process session inventory', () => {
  it('two stdio processes sharing DROIDRING_HOME see each other via chat_list_sessions', async () => {
    // Shared home dir = shared sqlite, so both processes touch the same
    // sessions table. Both clients point at the same override directory;
    // cleanup is deferred until after both processes have exited so there's
    // no race on sqlite + WAL files.
    const home = mkdtempSync(join(tmpdir(), 'droidring-sessions-'));
    const a = new StdioClient();
    const b = new StdioClient();
    (a as any).droidringHome = home;
    (b as any).droidringHome = home;

    try {
      // Serialise the boot — two concurrent subprocesses racing ALTER
      // TABLE on a fresh sqlite (first-run migrations) can deadlock
      // briefly. Let A initialize (which forces its migrations to commit)
      // before spawning B. Same pattern used by the multi-repo test below.
      await a.start();
      await a.send('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '1.0.0' },
      });
      await b.start();
      await b.send('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '1.0.0' },
      });

      const res = await a.send('tools/call', {
        name: 'chat_list_sessions',
        arguments: {},
      });
      const sessions = res.result.structuredContent.sessions;
      expect(sessions.length).toBeGreaterThanOrEqual(2);
      const pids = new Set(sessions.map((s: any) => s.pid));
      expect(pids.size).toBeGreaterThanOrEqual(2);
    } finally {
      // Stop both before any rm so neither process is still writing WAL.
      await a.stop();
      await b.stop();
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }, 20_000);
});
