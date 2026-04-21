import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { base32ToHex } from '../p2p/format.js';
import type { RoomManager } from '../p2p/manager.js';
import type { Room } from '../p2p/room.js';
import type { MessageRow, Repo } from '../store/repo.js';
import { handleApi } from './api.js';
import { extractBearer, loadOrCreateToken, verifyToken } from './auth.js';
import { UI_HTML } from './ui.js';
import { type WsConnection, acceptWebSocket } from './ws.js';

export interface WebServerOptions {
  host?: string;
  port?: number;
  manager: RoomManager;
  repo: Repo;
  token?: string;
}

export interface WebServerHandle {
  url: string;
  token: string;
  close: () => Promise<void>;
  address: { host: string; port: number };
}

/**
 * Starts the web UI + REST + WebSocket server. Binds to 127.0.0.1 by default
 * (explicit host required for remote exposure). All /api/* and /ws endpoints
 * require a Bearer token.
 *
 * Security posture:
 *   - Bearer token auth (no cookies → no CSRF)
 *   - CSP restricts scripts/styles to self
 *   - UI renders all user-supplied content via textContent
 *   - GET / serves the HTML bundle directly (no filesystem access surface)
 */
export async function startWebServer(opts: WebServerOptions): Promise<WebServerHandle> {
  const host = opts.host || '127.0.0.1';
  const port = opts.port ?? 7879;
  const token = opts.token || loadOrCreateToken();
  const { manager, repo } = opts;

  const wsClients = new Set<WsConnection>();
  // Pre-encode every broadcast once, then fan out the already-serialised
  // payload to each connection. Stringifying inside the loop was ~O(clients)
  // JSON.stringify calls per event.
  const broadcast = (msg: unknown) => {
    const text = JSON.stringify(msg);
    for (const c of wsClients) c.sendRaw(text);
  };
  // Wire room events to the WebSocket channel so the UI updates live.
  manager.on('message', (row: MessageRow) =>
    broadcast({ type: 'message', room_id: row.room_id, payload: msgToWire(row) }),
  );
  manager.on('member_joined', (_m: unknown, room: Room) =>
    broadcast({ type: 'member_joined', room_id: room.idHex }),
  );
  manager.on('members_update', (_ms: unknown, room: Room) =>
    broadcast({ type: 'members_update', room_id: room.idHex }),
  );
  manager.on('member_kicked', (_p: unknown, room: Room) =>
    broadcast({ type: 'member_kicked', room_id: room.idHex }),
  );
  manager.on(
    'room_closed',
    (info: { room_id: string; name: string; closed_at: number; reason?: string }) => {
      broadcast({ type: 'room_closed', ...info });
    },
  );
  // `join_request` and `nickname_changed` fire on the Room, not the manager.
  // Bind once per room so re-firing `member_joined` doesn't leak listeners.
  const boundRooms = new Set<string>();
  const bindRoom = (room: Room) => {
    if (boundRooms.has(room.idHex)) return;
    boundRooms.add(room.idHex);
    room.on('join_request', () => broadcast({ type: 'join_request', room_id: room.idHex }));
    room.on(
      'nickname_changed',
      (info: { old_nickname?: string; new_nickname: string; pubkey: Uint8Array }) => {
        broadcast({
          type: 'nickname_changed',
          room_id: room.idHex,
          pubkey: Buffer.from(info.pubkey).toString('hex'),
          old_nickname: info.old_nickname || '',
          new_nickname: info.new_nickname,
        });
      },
    );
  };
  for (const r of manager.rooms.values()) bindRoom(r);
  manager.on('member_joined', (_m: any, room: Room) => bindRoom(room));

  const srv = createServer(async (req, res) => {
    try {
      await handleHttp(req, res);
    } catch (err: any) {
      res
        .writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: err.message || 'internal error' }));
    }
  });

  srv.on('upgrade', (req, socket) => {
    if (!hostAllowed(req.headers.host)) {
      socket.end('HTTP/1.1 421 Misdirected Request\r\n\r\n');
      return;
    }
    // Cross-site WebSocket hijacking defense: the Origin header is the only
    // reliable signal of which site initiated the handshake (unlike Host,
    // which a same-origin attacker can't forge but a different-origin page
    // can't influence anyway). Bearer-token auth already requires the
    // attacker to know the token, but defence-in-depth is cheap here.
    if (!originAllowed(req.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    const presented = extractBearer(
      req.headers.authorization,
      url.searchParams.get('token') || undefined,
    );
    if (url.pathname !== '/ws' || !verifyToken(token, presented)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const conn = acceptWebSocket(req, socket as any);
    if (!conn) return;
    wsClients.add(conn);
    conn.on('close', () => wsClients.delete(conn));
  });

  // DNS-rebinding defense: reject requests whose Host header doesn't match
  // our bind interface. When we're bound to 127.0.0.1/localhost we only
  // accept those names; when bound to 0.0.0.0 (opt-in exposure) we accept
  // any Host so reverse proxies work.
  function hostAllowed(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    if (host === '0.0.0.0' || host === '::' || host === '::0') return true;
    const name = hostHeader.split(':')[0].toLowerCase();
    return (
      name === host.toLowerCase() ||
      name === 'localhost' ||
      name === '127.0.0.1' ||
      name === '[::1]' ||
      name === '::1'
    );
  }

  function originAllowed(originHeader: string | undefined): boolean {
    // Non-browser clients (curl, node ws) often omit Origin — the bearer
    // token is sufficient for them. Only reject when Origin is present and
    // doesn't match our allowlist.
    if (!originHeader) return true;
    if (host === '0.0.0.0' || host === '::' || host === '::0') return true;
    let parsed: URL;
    try {
      parsed = new URL(originHeader);
    } catch {
      return false;
    }
    const name = parsed.hostname.toLowerCase();
    return (
      name === host.toLowerCase() ||
      name === 'localhost' ||
      name === '127.0.0.1' ||
      name === '[::1]' ||
      name === '::1'
    );
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req.headers.host)) {
      res
        .writeHead(421, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'misdirected host' }));
      return;
    }
    const url = new URL(req.url || '/', `http://${host}:${port}`);

    // Root UI — no auth needed for the static HTML (token is entered in the form).
    if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'content-security-policy':
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(UI_HTML);
      return;
    }

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }

    // Everything under /api requires auth.
    if (url.pathname.startsWith('/api/')) {
      const presented = extractBearer(
        req.headers.authorization,
        url.searchParams.get('token') || undefined,
      );
      if (!verifyToken(token, presented)) {
        res
          .writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
          .end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const handled = await handleApi(req, res, url, { manager, repo });
      if (!handled)
        res
          .writeHead(404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'not found' }));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      srv.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      srv.off('error', onError);
      resolve();
    };
    srv.once('error', onError);
    srv.once('listening', onListening);
    srv.listen(port, host);
  });
  const addr = srv.address();
  const boundPort = typeof addr === 'object' && addr ? (addr as any).port : port;

  return {
    url: `http://${host}:${boundPort}`,
    token,
    address: { host, port: boundPort },
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wsClients) c.close();
        srv.close(() => resolve());
      }),
  };
}

function msgToWire(r: MessageRow) {
  return {
    id: r.id,
    sender: base32ToHex(r.sender),
    nickname: r.nickname,
    text: r.text,
    ts: r.ts,
    reply_to: r.reply_to ?? undefined,
  };
}
