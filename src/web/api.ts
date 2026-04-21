import type { IncomingMessage, ServerResponse } from 'node:http';
import { base32ToHex, bytesToHex, parsePubkey } from '../p2p/format.js';
import { loadConfig, saveConfig } from '../p2p/identity.js';
import type { RoomManager } from '../p2p/manager.js';
import { type Room, clientKind } from '../p2p/room.js';
import type { Repo } from '../store/repo.js';

const MAX_BODY = 256 * 1024; // 256 KB JSON body cap

export interface ApiDeps {
  manager: RoomManager;
  repo: Repo;
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

/** Emit a JSON response and return `true` to signal "handled" to the router. */
function respond(res: ServerResponse, status: number, body: unknown): true {
  json(res, status, body);
  return true;
}

function roomWire(r: Room) {
  return {
    id: r.idHex,
    name: r.name,
    topic: r.topic,
    admission: r.admissionMode,
    is_creator: r.isCreator(),
    creator_pubkey: bytesToHex(r.creatorPubkey),
    epoch: r.epoch,
    member_count: r.memberCount,
    pending_count: r.pendingCount,
  };
}

function memberWire(m: {
  pubkey: Uint8Array;
  nickname: string;
  joined_at: number;
  online: boolean;
  client?: string;
  bio?: string;
}) {
  const client = m.client || '';
  return {
    pubkey: bytesToHex(m.pubkey),
    nickname: m.nickname,
    online: m.online,
    joined_at: new Date(m.joined_at).toISOString(),
    client,
    kind: clientKind(client),
    bio: m.bio || '',
  };
}

function msgRowWire(r: {
  id: string;
  sender: string;
  nickname: string;
  text: string;
  ts: string;
  reply_to: string | null;
}) {
  return {
    id: r.id,
    sender: base32ToHex(r.sender),
    nickname: r.nickname,
    text: r.text,
    ts: r.ts,
    reply_to: r.reply_to ?? undefined,
  };
}

/**
 * Route dispatch. Returns true if handled. All handlers validate their input
 * and return structured JSON; errors include a code + message.
 */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ApiDeps,
): Promise<boolean> {
  const { manager, repo } = deps;
  const path = url.pathname;
  const method = req.method || 'GET';

  if (path === '/api/me' && method === 'GET') {
    return respond(res, 200, {
      pubkey: bytesToHex(manager.identity.publicKey),
      nickname: manager.getNickname(),
      bio: manager.getBio(),
    });
  }

  if (path === '/api/bio' && method === 'POST') {
    const body = (await readJson(req)) as { bio?: string };
    const bio = (body.bio || '').trim();
    if (bio.length > 200) return respond(res, 400, { error: 'bio too long (max 200)' });
    manager.setBio(bio);
    try {
      const cfg = loadConfig();
      cfg.bio = bio;
      saveConfig(cfg);
    } catch {
      /* best-effort disk write */
    }
    return respond(res, 200, { ok: true, bio });
  }

  if (path === '/api/nickname' && method === 'POST') {
    const body = (await readJson(req)) as { nickname?: string };
    const nick = (body.nickname || '').trim();
    if (!nick || nick.length > 32) return respond(res, 400, { error: 'invalid nickname' });
    manager.setNickname(nick);
    try {
      const cfg = loadConfig();
      cfg.nickname = nick;
      saveConfig(cfg);
    } catch {
      // Best-effort: the runtime nickname is already updated; disk write
      // failures shouldn't block the response.
    }
    return respond(res, 200, { ok: true, nickname: nick });
  }

  if (path === '/api/rooms' && method === 'GET') {
    return respond(res, 200, { rooms: [...manager.rooms.values()].map(roomWire) });
  }

  if (path === '/api/sessions' && method === 'GET') {
    // 90s stale window = 3× the 30s heartbeat. Same constant as the MCP
    // tool; any dead sessions are GC'd on the read.
    const cutoff = Date.now() - 90_000;
    return respond(res, 200, { sessions: repo.listActiveSessions(cutoff) });
  }

  if (path === '/api/rooms' && method === 'POST') {
    const body = (await readJson(req)) as { name?: string; topic?: string; admission?: string };
    if (!body.name || body.name.length > 64) return respond(res, 400, { error: 'invalid name' });
    const admission = body.admission === 'approval' ? 'approval' : 'open';
    const room = await manager.createRoom(body.name, body.topic, admission);
    return respond(res, 200, { room: roomWire(room), ticket: room.toTicket() });
  }

  if (path === '/api/rooms/join' && method === 'POST') {
    const body = (await readJson(req)) as { ticket?: string };
    if (!body.ticket) return respond(res, 400, { error: 'ticket required' });
    try {
      const room = await manager.joinByTicket(body.ticket);
      return respond(res, 200, { room: roomWire(room) });
    } catch (e: any) {
      return respond(res, 400, { error: e.message || 'join failed' });
    }
  }

  const roomMatch = /^\/api\/rooms\/([^/]+)(\/.+)?$/.exec(path);
  if (roomMatch) {
    const [, roomRef, rest] = roomMatch;
    const room = manager.resolveRoom(decodeURIComponent(roomRef));
    if (!room) return respond(res, 404, { error: 'room not found' });

    // GET /api/rooms/:id
    if (!rest || rest === '/') {
      if (method === 'GET') return respond(res, 200, roomWire(room));
    }

    if (rest === '/members' && method === 'GET') {
      json(res, 200, { members: room.memberList().map(memberWire) });
      return true;
    }

    if (rest === '/messages' && method === 'GET') {
      const limit = Math.min(
        Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100,
        500,
      );
      const before = url.searchParams.get('before') || undefined;
      const rows = repo.fetchMessages(room.idHex, limit, before);
      json(res, 200, { messages: rows.map(msgRowWire) });
      return true;
    }

    if (rest === '/messages' && method === 'POST') {
      const body = (await readJson(req)) as { text?: string };
      const text = (body.text || '').trim();
      if (!text || text.length > 16 * 1024) {
        return respond(res, 400, { error: 'invalid text' });
      }
      const sent = room.sendMessage(text);
      return respond(res, 200, { id: sent.id, ts: new Date(sent.ts).toISOString() });
    }

    if (rest === '/invite' && method === 'GET') {
      json(res, 200, { ticket: room.toTicket() });
      return true;
    }

    if (rest === '/leave' && method === 'POST') {
      await manager.leaveRoom(room.idHex);
      json(res, 200, { ok: true });
      return true;
    }

    if (rest === '/topic' && method === 'POST') {
      const body = (await readJson(req)) as { topic?: string };
      if (body.topic === undefined || body.topic.length > 200)
        return respond(res, 400, { error: 'invalid topic' });
      room.setTopic(body.topic);
      json(res, 200, { ok: true });
      return true;
    }

    if (rest === '/admission' && method === 'POST') {
      const body = (await readJson(req)) as { mode?: string };
      if (body.mode !== 'open' && body.mode !== 'approval')
        return respond(res, 400, { error: 'invalid mode' });
      room.setAdmissionMode(body.mode);
      json(res, 200, { ok: true, mode: body.mode });
      return true;
    }

    if (rest === '/pending' && method === 'GET') {
      const pending = room.listPending().map((p) => ({
        pubkey: bytesToHex(p.pubkey),
        nickname: p.nickname,
        client: p.client,
        requested_at: new Date(p.ts).toISOString(),
      }));
      json(res, 200, { pending });
      return true;
    }

    const approveMatch = /^\/pending\/([^/]+)\/(approve|deny)$/.exec(rest || '');
    if (approveMatch && method === 'POST') {
      const [, pubkeyStr, action] = approveMatch;
      const target = parsePubkey(decodeURIComponent(pubkeyStr));
      if (!target) return respond(res, 400, { error: 'invalid pubkey' });
      const ok_ = action === 'approve' ? room.approveJoin(target) : room.denyJoin(target);
      if (!ok_) return respond(res, 404, { error: 'no such pending request' });
      json(res, 200, { ok: true });
      return true;
    }

    if (rest === '/kick' && method === 'POST') {
      if (!room.isCreator()) {
        return respond(res, 403, { error: 'only the room creator can kick' });
      }
      const body = (await readJson(req)) as { pubkey?: string };
      if (!body.pubkey) return respond(res, 400, { error: 'pubkey required' });
      const target = parsePubkey(body.pubkey);
      if (!target) return respond(res, 400, { error: 'invalid pubkey' });
      try {
        room.kick(target);
      } catch (e: any) {
        return respond(res, 403, { error: e.message || 'kick failed' });
      }
      return respond(res, 200, { ok: true });
    }

    if (rest === '/notes' && method === 'GET') {
      const tag = url.searchParams.get('tag') || undefined;
      const query = url.searchParams.get('q') || undefined;
      const limit = Math.min(Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);
      const notes = repo.listNotes(room.idHex, { tag, query, limit });
      json(res, 200, {
        notes: notes.map((n) => ({
          id: n.id,
          title: n.title,
          tags: n.tags,
          author: base32ToHex(n.author),
          updated_at: new Date(n.updated_at).toISOString(),
          preview: n.body.slice(0, 160),
        })),
      });
      return true;
    }

    if (rest === '/notes' && method === 'POST') {
      const body = (await readJson(req)) as {
        id?: string;
        title?: string;
        body?: string;
        tags?: string[];
      };
      if (!body.title || body.body === undefined)
        return respond(res, 400, { error: 'title and body required' });
      if (body.title.length > 256 || body.body.length > 64 * 1024)
        return respond(res, 400, { error: 'too large' });
      const tags = (body.tags || [])
        .filter((t) => /^[A-Za-z0-9._:/-]+$/.test(t) && t.length <= 64)
        .slice(0, 32);
      const saved = room.putNote({ id: body.id, title: body.title, body: body.body, tags });
      json(res, 200, { id: saved.id, updated_at: new Date(saved.updated_at).toISOString() });
      return true;
    }

    const noteIdMatch = /^\/notes\/([^/]+)$/.exec(rest || '');
    if (noteIdMatch) {
      const noteId = decodeURIComponent(noteIdMatch[1]);
      if (method === 'GET') {
        const n = repo.getNote(room.idHex, noteId);
        if (!n || n.deleted) return respond(res, 404, { error: 'note not found' });
        json(res, 200, {
          id: n.id,
          title: n.title,
          body: n.body,
          tags: n.tags,
          author: base32ToHex(n.author),
          updated_at: new Date(n.updated_at).toISOString(),
        });
        return true;
      }
      if (method === 'DELETE') {
        room.deleteNote(noteId);
        json(res, 200, { ok: true });
        return true;
      }
    }

    if (rest === '/graph' && method === 'GET') {
      const filter = {
        src: url.searchParams.get('src') || undefined,
        predicate: url.searchParams.get('predicate') || undefined,
        dst: url.searchParams.get('dst') || undefined,
        limit: Math.min(Number.parseInt(url.searchParams.get('limit') || '200', 10) || 200, 500),
      };
      json(res, 200, {
        triples: repo
          .queryGraph(room.idHex, filter)
          .map((t) => ({ ...t, author: base32ToHex(t.author) })),
      });
      return true;
    }

    if (rest === '/graph' && method === 'POST') {
      const body = (await readJson(req)) as { triples?: unknown };
      if (!Array.isArray(body.triples) || body.triples.length === 0 || body.triples.length > 100) {
        return respond(res, 400, { error: 'invalid triples batch' });
      }
      const valid: any[] = [];
      for (const t of body.triples) {
        if (!t || typeof t !== 'object') return respond(res, 400, { error: 'invalid triple' });
        const tt = t as any;
        if (
          typeof tt.src !== 'string' ||
          typeof tt.predicate !== 'string' ||
          typeof tt.dst !== 'string'
        ) {
          return respond(res, 400, { error: 'triple fields must be strings' });
        }
        if (tt.src.length > 512 || tt.predicate.length > 512 || tt.dst.length > 512) {
          return respond(res, 400, { error: 'triple field too long' });
        }
        valid.push(tt);
      }
      const result = room.assertTriples(valid);
      json(res, 200, { ids: result.ids });
      return true;
    }

    if (rest === '/graph/retract' && method === 'POST') {
      const body = (await readJson(req)) as { ids?: string[] };
      if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 100) {
        return respond(res, 400, { error: 'invalid ids' });
      }
      room.retractTriples(body.ids);
      json(res, 200, { ok: true });
      return true;
    }
  }

  return false;
}
