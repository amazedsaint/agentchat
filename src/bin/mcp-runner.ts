import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startHttpMcp } from '../mcp/http.js';
import { buildServer } from '../mcp/server.js';
import { loadConfig, loadOrCreateIdentity } from '../p2p/identity.js';
import { RoomManager } from '../p2p/manager.js';
import { openDatabase } from '../store/db.js';
import { Repo } from '../store/repo.js';

const VERSION = '0.1.0';

function detectClient(): string {
  // The env var is set by MCP clients in some cases; otherwise we guess from argv.
  return process.env.MCP_CLIENT_NAME || 'unknown';
}

export async function buildContextAndServer(): Promise<{
  server: any;
  manager: RoomManager;
  repo: Repo;
}> {
  const identity = loadOrCreateIdentity();
  const config = loadConfig();
  const db = openDatabase();
  const repo = new Repo(db);
  const manager = new RoomManager({
    identity,
    repo,
    nickname: config.nickname,
    clientName: detectClient(),
    version: VERSION,
  });
  await manager.start();
  const server = buildServer({ ctx: { manager, repo }, version: VERSION });
  return { server, manager, repo };
}

export async function runStdioServer(opts: { web?: boolean } = {}): Promise<void> {
  const { server, manager, repo } = await buildContextAndServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (opts.web) await launchWebSidecar(manager, repo);
}

async function launchWebSidecar(manager: RoomManager, repo: Repo): Promise<void> {
  const { startWebServer } = await import('../web/server.js');
  const { loadOrCreateToken } = await import('../web/auth.js');
  const { tryOpenBrowser } = await import('../web/open-browser.js');
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

  if (process.env.AGENTCHAT_WEB_OPEN !== '0') {
    // Delay the browser open so short-lived verification probes (e.g.
    // `claude mcp add` spawns agentchat-mcp, sends an initialize, then
    // closes stdin to see that it responded) don't leave an orphaned tab
    // pointing at a server that's already shutting down. A real Claude
    // Code session keeps stdin open for the whole session, so the timer
    // fires and the browser opens normally.
    const openTimer = setTimeout(() => tryOpenBrowser(url), 1500);
    const cancel = () => clearTimeout(openTimer);
    process.once('SIGTERM', cancel);
    process.once('SIGINT', cancel);
    process.once('beforeExit', cancel);
    process.stdin.once('end', cancel);
    process.stdin.once('close', cancel);
  }
}

export async function runHttpServer(host: string, port: number): Promise<void> {
  const { manager, repo } = await buildContextAndServer();
  startHttpMcp({
    host,
    port,
    build: async () => buildServer({ ctx: { manager, repo }, version: VERSION }),
  });
  console.error(`[agentchat] Streamable HTTP MCP listening on http://${host}:${port}/mcp`);
}
