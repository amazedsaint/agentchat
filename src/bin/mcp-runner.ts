import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startHttpMcp } from '../mcp/http.js';
import { buildServer } from '../mcp/server.js';
import { loadConfig, loadOrCreateIdentity } from '../p2p/identity.js';
import { RoomManager } from '../p2p/manager.js';
import { clientKind } from '../p2p/room.js';
import { type DB, openDatabase } from '../store/db.js';
import { Repo } from '../store/repo.js';

const VERSION = '0.1.0';
const SESSION_HEARTBEAT_MS = 30_000;

function detectClient(): string {
  // The env var is set by MCP clients in some cases; otherwise we guess from argv.
  return process.env.MCP_CLIENT_NAME || 'unknown';
}

/**
 * Register this process as an active session in the shared sqlite store.
 * All local processes (multiple MCP agents + TUI + web) share `agentchatDir()`
 * so they can see each other's sessions and the UI can render a "My
 * sessions" panel. Returns a cleanup function that removes the row on
 * shutdown; also starts a heartbeat interval to keep last_seen fresh.
 */
export function registerSession(
  repo: Repo,
  opts: { client: string },
): { id: string; cleanup: () => void } {
  const id = randomUUID();
  const client = opts.client || 'unknown';
  const now = Date.now();
  repo.upsertSession({
    id,
    pid: process.pid,
    client,
    kind: clientKind(client),
    started_at: now,
    last_seen: now,
  });
  const hb = setInterval(() => {
    try {
      repo.touchSession(id, Date.now());
    } catch {
      /* DB closed already — nothing to do */
    }
  }, SESSION_HEARTBEAT_MS);
  // Prevent heartbeat from keeping the event loop alive when we otherwise
  // would exit — MCP sessions end when the client closes stdin.
  hb.unref?.();
  return {
    id,
    cleanup: () => {
      clearInterval(hb);
      try {
        repo.removeSession(id);
      } catch {
        /* ignore */
      }
    },
  };
}

export async function buildContextAndServer(): Promise<{
  server: any;
  manager: RoomManager;
  repo: Repo;
  db: DB;
}> {
  const identity = loadOrCreateIdentity();
  const config = loadConfig();
  const db = openDatabase();
  const repo = new Repo(db);
  const manager = new RoomManager({
    identity,
    repo,
    nickname: config.nickname,
    bio: config.bio || '',
    clientName: detectClient(),
    version: VERSION,
  });
  await manager.start();
  const server = buildServer({ ctx: { manager, repo }, version: VERSION });
  return { server, manager, repo, db };
}

/**
 * Graceful shutdown — flush the WAL and close the sqlite handle. Without
 * this, a kill -9 is fine (sqlite recovers from WAL), but normal SIGTERM
 * / stdin-close on the stdio runner would leave the WAL un-checkpointed
 * and the handle un-finalized. Registered once per process.
 */
let shutdownRegistered = false;
function registerShutdown(db: DB, manager: RoomManager, beforeDbClose?: () => void): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  let ran = false;
  const cleanup = () => {
    if (ran) return;
    ran = true;
    // Best-effort — swallow errors so we still exit.
    if (beforeDbClose) {
      try {
        beforeDbClose();
      } catch {
        /* ignore */
      }
    }
    manager.stop().catch(() => {});
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* ignore */
    }
    try {
      db.close();
    } catch {
      /* ignore */
    }
  };
  process.once('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.once('beforeExit', cleanup);
  // Stdio MCP sessions end when the client closes stdin.
  process.stdin.once('end', () => {
    cleanup();
    process.exit(0);
  });
}

export async function runStdioServer(opts: { web?: boolean } = {}): Promise<void> {
  const { server, manager, repo, db } = await buildContextAndServer();
  const session = registerSession(repo, { client: detectClient() });
  registerShutdown(db, manager, session.cleanup);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (opts.web) await launchWebSidecar(manager, repo);
}

async function launchWebSidecar(manager: RoomManager, repo: Repo): Promise<void> {
  const { startWebServer } = await import('../web/server.js');
  const { loadOrCreateToken } = await import('../web/auth.js');
  const { launchShell } = await import('../web/launch-shell.js');
  const { writeWebUrl } = await import('../web/url-file.js');

  const token = loadOrCreateToken();
  const preferredPort = Number(process.env.AGENTCHAT_WEB_PORT || 7879);

  let srv: Awaited<ReturnType<typeof startWebServer>>;
  try {
    srv = await startWebServer({ host: '127.0.0.1', port: preferredPort, manager, repo, token });
  } catch (e: any) {
    if (e?.code === 'EADDRINUSE') {
      // Port busy. Could be another agentchat, could be an unrelated service.
      // Fall back to an OS-chosen ephemeral port so the UI still works, and
      // the user can discover the actual URL via ~/.agentchat/web-url.
      try {
        srv = await startWebServer({ host: '127.0.0.1', port: 0, manager, repo, token });
        process.stderr.write(
          `[agentchat] port ${preferredPort} was busy, using ${srv.address.port} instead.\n`,
        );
      } catch (e2: any) {
        process.stderr.write(`[agentchat] web UI failed to start: ${e2?.message || e2}\n`);
        return;
      }
    } else {
      process.stderr.write(`[agentchat] web UI failed to start: ${e?.message || e}\n`);
      return;
    }
  }

  const url = `${srv.url}/#token=${token}`;
  writeWebUrl(url);

  // Prominent banner so it's not lost in a sea of other stderr.
  process.stderr.write('\n');
  process.stderr.write('  ┌─ agentchat web UI ──────────────────────────────────────\n');
  process.stderr.write(`  │  ${url}\n`);
  process.stderr.write('  │\n');
  process.stderr.write('  │  also saved to ~/.agentchat/web-url\n');
  process.stderr.write('  │  recover anytime with:  agentchat url\n');
  process.stderr.write('  └─────────────────────────────────────────────────────────\n\n');

  // Delay the shell open so short-lived verification probes (e.g.
  // `claude mcp add` sends initialize then closes stdin ~200ms later)
  // don't leave an orphaned window pointing at a dead server. A real
  // session keeps stdin open for the whole session so the timer fires.
  const openTimer = setTimeout(async () => {
    const kind = await launchShell(url);
    if (kind !== 'none') process.stderr.write(`[agentchat] shell launched (${kind}).\n`);
  }, 1500);
  const cancel = () => clearTimeout(openTimer);
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  process.once('beforeExit', cancel);
  process.stdin.once('end', cancel);
  process.stdin.once('close', cancel);
}

export async function runHttpServer(host: string, port: number): Promise<void> {
  const { manager, repo, db } = await buildContextAndServer();
  const session = registerSession(repo, { client: 'http-mcp' });
  registerShutdown(db, manager, session.cleanup);
  startHttpMcp({
    host,
    port,
    build: async () => buildServer({ ctx: { manager, repo }, version: VERSION }),
  });
  console.error(`[agentchat] Streamable HTTP MCP listening on http://${host}:${port}/mcp`);
}
