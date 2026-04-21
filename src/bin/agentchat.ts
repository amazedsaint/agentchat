import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { agentchatDir, loadConfig, loadOrCreateIdentity, saveConfig } from '../p2p/identity.js';
import { openDatabase } from '../store/db.js';
import { Repo } from '../store/repo.js';
import { buildContextAndServer, runHttpServer, runStdioServer } from './mcp-runner.js';

const program = new Command();

program.name('agentchat').description('Peer-to-peer encrypted chat for AI agents').version('0.1.0');

program
  .command('mcp')
  .description('Run the MCP server')
  .option('--http <addr>', 'Run Streamable HTTP MCP (e.g. :7777 or 127.0.0.1:7777)')
  .option('--web', 'Also boot the web UI on a local port and auto-open the browser')
  .action(async (opts) => {
    if (opts.http) {
      const [hostPart, portPart] = String(opts.http).includes(':')
        ? String(opts.http).split(':')
        : ['127.0.0.1', String(opts.http)];
      const host = hostPart || '127.0.0.1';
      const port = Number(portPart || 7777);
      await runHttpServer(host, port);
    } else {
      await runStdioServer({ web: Boolean(opts.web) });
    }
  });

program
  .command('daemon')
  .description('Run the long-lived daemon (swarm + HTTP MCP)')
  .option('--port <port>', 'HTTP port', '7777')
  .option('--host <host>', 'HTTP host', '127.0.0.1')
  .action(async (opts) => {
    await runHttpServer(opts.host, Number(opts.port));
  });

program
  .command('web')
  .description('Run the Discord-like web UI + REST + WebSocket server')
  .option('--port <port>', 'port (default 7879)', '7879')
  .option('--host <host>', 'bind host (default 127.0.0.1 — use 0.0.0.0 to expose)', '127.0.0.1')
  .action(async (opts) => {
    const { buildContextAndServer, registerSession, maybeJoinRepoRoom } = await import(
      './mcp-runner.js'
    );
    const { manager, repo } = await buildContextAndServer();
    const { startWebServer } = await import('../web/server.js');
    const { loadOrCreateToken } = await import('../web/auth.js');
    const { writeWebUrl, clearWebUrl } = await import('../web/url-file.js');
    const token = loadOrCreateToken();
    const session = registerSession(repo, { client: 'web' });
    await maybeJoinRepoRoom(manager, session);
    const srv = await startWebServer({
      host: opts.host,
      port: Number(opts.port),
      manager,
      repo,
      token,
    });
    const linkable = `${srv.url}/#token=${token}`;
    writeWebUrl(linkable);
    process.stderr.write('\n  ┌─ agentchat web UI ──────────────────────────────────────\n');
    process.stderr.write(`  │  open this:  ${linkable}\n`);
    process.stderr.write(`  │  bind:       ${srv.url}\n`);
    process.stderr.write('  │  also saved to ~/.agentchat/web-url  (agentchat url to print)\n');
    process.stderr.write('  └─────────────────────────────────────────────────────────\n\n');
    const stop = async () => {
      session.cleanup();
      clearWebUrl();
      await srv.close();
      await manager.stop();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

program
  .command('url')
  .description('Print the current web UI URL (with auto-login token)')
  .action(async () => {
    const { readWebUrl, webUrlPath } = await import('../web/url-file.js');
    const url = readWebUrl();
    if (!url) {
      process.stderr.write(
        `No web URL recorded at ${webUrlPath()}.\nStart one with \`agentchat web\` or let \`agentchat-mcp\` boot it.\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`${url}\n`);
  });

program
  .command('tui')
  .description('Attach the Ink TUI to a running daemon (or start one in-process)')
  .option('--daemon <url>', 'Daemon URL (e.g. http://127.0.0.1:7777/mcp)')
  .action(async (opts) => {
    const { startTui } = await import('../tui/app.js');
    await startTui({ daemonUrl: opts.daemon });
  });

program
  .command('ticket')
  .description('Ticket utilities')
  .addCommand(
    new Command('create').argument('<name>', 'room name').action(async (name: string) => {
      const { manager } = await buildContextAndServer();
      const room = await manager.createRoom(name);
      process.stdout.write(`${room.toTicket()}\n`);
      await manager.stop();
      process.exit(0);
    }),
  )
  .addCommand(
    new Command('show').argument('<room>', 'room name or id').action(async (name: string) => {
      const db = openDatabase();
      const repo = new Repo(db);
      const row = repo.resolveRoom(name);
      if (!row) {
        console.error('No such room');
        process.exit(2);
      }
      // We cannot regenerate the live peer list here, so ticket.show prints a minimal ticket.
      const { encodeTicket } = await import('../p2p/ticket.js');
      const { base32Decode } = await import('../p2p/base32.js');
      const id = loadOrCreateIdentity();
      process.stdout.write(
        `${encodeTicket({
          roomName: row.name,
          rootSecret: base32Decode(row.root_secret),
          bootstrapPubkeys: [id.publicKey],
        })}\n`,
      );
    }),
  );

program
  .command('doctor')
  .description('Check install health')
  .action(async () => {
    const dir = agentchatDir();
    const checks: Array<[string, boolean, string]> = [];
    checks.push(['~/.agentchat exists', existsSync(dir), dir]);
    const id = loadOrCreateIdentity();
    checks.push([
      'identity loaded',
      true,
      `pub=${Buffer.from(id.publicKey).toString('hex').slice(0, 12)}…`,
    ]);
    try {
      openDatabase().close();
      checks.push(['sqlite writable', true, join(dir, 'store.db')]);
    } catch (e: any) {
      checks.push(['sqlite writable', false, e.message]);
    }
    try {
      const { Swarm } = await import('../p2p/swarm.js');
      const s = new Swarm();
      await s.start();
      await s.destroy();
      checks.push(['hyperswarm reachable', true, 'ok']);
    } catch (e: any) {
      checks.push(['hyperswarm reachable', false, e.message]);
    }
    let all = true;
    for (const [name, ok, detail] of checks) {
      if (!ok) all = false;
      process.stdout.write(`${ok ? '[OK] ' : '[FAIL]'} ${name.padEnd(24)} ${detail}\n`);
    }
    const cfg = loadConfig();
    process.stdout.write(`nickname: ${cfg.nickname}\n`);
    const { readWebUrl } = await import('../web/url-file.js');
    const url = readWebUrl();
    if (url) process.stdout.write(`web URL:  ${url}\n`);
    process.exit(all ? 0 : 1);
  });

program
  .command('nick')
  .argument('<nickname>')
  .description('Set your nickname')
  .action((nick: string) => {
    const cfg = loadConfig();
    cfg.nickname = nick;
    saveConfig(cfg);
    process.stdout.write(`nickname set to ${nick}\n`);
  });

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
