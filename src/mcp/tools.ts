import { z } from 'zod';
import { base32ToHex, bytesToHex, parsePubkey } from '../p2p/format.js';
import type { RoomManager } from '../p2p/manager.js';
import { decodeTicket } from '../p2p/ticket.js';
import type { Repo } from '../store/repo.js';
import type { Member, Message, RoomSummary } from './types.js';

export interface ToolContext {
  manager: RoomManager;
  repo: Repo;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: any;
  isError?: boolean;
}

export interface ToolDef<TArgs> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TArgs>;
  handler: (ctx: ToolContext, args: TArgs) => Promise<ToolResult> | ToolResult;
}

function ok(text: string, structured: any): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function err(text: string, structured: any = {}): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured, isError: true };
}

function memberToWire(m: {
  pubkey: Uint8Array;
  nickname: string;
  joined_at: number;
  online: boolean;
}): Member {
  return {
    pubkey: bytesToHex(m.pubkey),
    nickname: m.nickname,
    online: m.online,
    joined_at: new Date(m.joined_at).toISOString(),
  };
}

function msgRowToWire(r: {
  id: string;
  room_id: string;
  sender: string;
  nickname: string;
  text: string;
  ts: string;
  reply_to: string | null;
  signature: string;
}): Message {
  return {
    id: r.id,
    room_id: r.room_id,
    sender: base32ToHex(r.sender),
    nickname: r.nickname,
    text: r.text,
    ts: r.ts,
    reply_to: r.reply_to ?? undefined,
    signature: r.signature,
  };
}

// ---- tool definitions --------------------------------------------------

const whoami: ToolDef<Record<string, never>> = {
  name: 'chat_whoami',
  description:
    'Returns your own identity (public key + nickname) and the list of rooms you have currently joined. Use this first so other agents and humans can recognise you.',
  inputSchema: z.object({}).strict(),
  handler: async ({ manager }) => {
    const joined = [...manager.rooms.values()].map((r) => r.name);
    const pubkey = bytesToHex(manager.identity.publicKey);
    const payload = { pubkey, nickname: manager.getNickname(), joined_rooms: joined };
    return ok(
      `You are ${manager.getNickname()} (${pubkey.slice(0, 12)}…). In rooms: ${joined.join(', ') || '(none)'}`,
      payload,
    );
  },
};

const createRoom: ToolDef<{ name: string; topic?: string; admission?: 'open' | 'approval' }> = {
  name: 'chat_create_room',
  description:
    "Create a new encrypted chat room. Returns a room id and a base32 ticket you can share with other agents or humans so they can join. admission='open' (default) lets anyone with the ticket in immediately; admission='approval' holds joiners in a pending queue until you approve them.",
  inputSchema: z
    .object({
      name: z.string().min(1),
      topic: z.string().optional(),
      admission: z.enum(['open', 'approval']).optional(),
    })
    .strict(),
  handler: async ({ manager }, args) => {
    const room = await manager.createRoom(args.name, args.topic, args.admission || 'open');
    return ok(
      `Room "${args.name}" created (${room.admissionMode}). Share this ticket to invite members:\n${room.toTicket()}`,
      {
        room_id: room.idHex,
        name: room.name,
        ticket: room.toTicket(),
        admission: room.admissionMode,
      },
    );
  },
};

const joinRoom: ToolDef<{ ticket: string; nickname?: string }> = {
  name: 'chat_join_room',
  description:
    'Join an existing room using a base32 invite ticket. Messages sent to the room are visible to all current members. Use this to coordinate with other AI agents or humans collaborating in the same room.',
  inputSchema: z.object({ ticket: z.string().min(10), nickname: z.string().optional() }).strict(),
  handler: async ({ manager }, args) => {
    try {
      decodeTicket(args.ticket);
    } catch (e: any) {
      return err(`Invalid ticket: ${e.message}`);
    }
    const room = await manager.joinByTicket(args.ticket, args.nickname);
    return ok(`Joined room "${room.name}". Members online will acknowledge shortly.`, {
      room_id: room.idHex,
      name: room.name,
      members: room.memberList().map(memberToWire),
    });
  },
};

const leaveRoom: ToolDef<{ room: string }> = {
  name: 'chat_leave_room',
  description: 'Leave a room you are currently in. The room id or name is accepted.',
  inputSchema: z.object({ room: z.string().min(1) }).strict(),
  handler: async ({ manager }, args) => {
    const ok_ = await manager.leaveRoom(args.room);
    if (!ok_) return err(`No such room: ${args.room}`);
    return ok(`Left room ${args.room}.`, { ok: true });
  },
};

const listRooms: ToolDef<Record<string, never>> = {
  name: 'chat_list_rooms',
  description:
    'List all rooms you are currently in, with member counts. Use this to discover where you can coordinate with other agents.',
  inputSchema: z.object({}).strict(),
  handler: async ({ manager }) => {
    const rooms: RoomSummary[] = [...manager.rooms.values()].map((r) => ({
      id: r.idHex,
      name: r.name,
      topic: r.topic,
      members: r.members.size,
      unread: 0,
    }));
    const text = rooms.length
      ? rooms.map((r) => `- ${r.name} (${r.members} members)`).join('\n')
      : 'No rooms. Use chat_create_room or chat_join_room.';
    return ok(text, { rooms });
  },
};

const listMembers: ToolDef<{ room: string }> = {
  name: 'chat_list_members',
  description:
    'List the current members of a room, including their public keys and nicknames. Online status is a best-effort.',
  inputSchema: z.object({ room: z.string().min(1) }).strict(),
  handler: async ({ manager }, args) => {
    const room = manager.resolveRoom(args.room);
    if (!room) return err(`No such room: ${args.room}`);
    const members = room.memberList().map(memberToWire);
    const text = members
      .map((m) => `- @${m.nickname || '?'} (${m.pubkey.slice(0, 12)}…)`)
      .join('\n');
    return ok(text || '(no members)', { members });
  },
};

const sendMessage: ToolDef<{ room: string; text: string; reply_to?: string }> = {
  name: 'chat_send_message',
  description:
    'Post a message to a room. All current members receive the message. Use this to coordinate with other AI agents or humans in the same room, hand off work, or share status.',
  inputSchema: z
    .object({ room: z.string().min(1), text: z.string().min(1), reply_to: z.string().optional() })
    .strict(),
  handler: async ({ manager }, args) => {
    const room = manager.resolveRoom(args.room);
    if (!room) return err(`No such room: ${args.room}`);
    const text = args.text.trim();
    if (!text) return err('message text is empty or whitespace-only');
    const { id, ts } = room.sendMessage(text, args.reply_to);
    return ok(`Sent to ${room.name}: ${text}`, {
      message_id: id,
      ts: new Date(ts).toISOString(),
    });
  },
};

const directMessage: ToolDef<{ peer: string; text: string }> = {
  name: 'chat_direct_message',
  description:
    'Send a private 1:1 message to a peer by public key (hex) or by a known nickname. Creates or reuses the direct-message room. Messages are end-to-end encrypted between the two of you.',
  inputSchema: z.object({ peer: z.string().min(1), text: z.string().min(1) }).strict(),
  handler: async ({ manager, repo }, args) => {
    let peerKey = parsePubkey(args.peer);
    if (!peerKey) {
      const contact = repo.findContactByNick(args.peer);
      if (contact) peerKey = parsePubkey(contact.pubkey);
    }
    if (!peerKey) {
      return err(
        `Unknown peer: ${args.peer}. Provide a 64-char hex pubkey or a nickname that has been seen before.`,
      );
    }
    try {
      const room = await manager.openDM(peerKey);
      const { id } = room.sendMessage(args.text);
      return ok('DM sent.', { message_id: id, room_id: room.idHex });
    } catch (e: any) {
      return err(`DM failed: ${e.message || String(e)}`);
    }
  },
};

const fetchHistory: ToolDef<{ room: string; limit?: number; before?: string }> = {
  name: 'chat_fetch_history',
  description:
    'Fetch the most recent N messages from a room (local store). Use to catch up on conversation state before deciding how to act.',
  inputSchema: z
    .object({
      room: z.string().min(1),
      limit: z.number().int().positive().max(500).optional(),
      before: z.string().optional(),
    })
    .strict(),
  handler: async ({ manager, repo }, args) => {
    const room = manager.resolveRoom(args.room);
    if (!room) return err(`No such room: ${args.room}`);
    const rows = repo.fetchMessages(room.idHex, args.limit || 50, args.before);
    const messages = rows.map(msgRowToWire);
    const text = messages
      .map((m) => `[${m.ts}] @${m.nickname || m.sender.slice(0, 6)}: ${m.text}`)
      .join('\n');
    return ok(text || '(no messages)', { messages });
  },
};

const tail: ToolDef<{ room: string; since?: string; wait_ms?: number }> = {
  name: 'chat_tail',
  description:
    'Fetch any new messages in a room since the given timestamp. If wait_ms > 0, long-poll up to that many milliseconds for a new message. Agents can loop this in a tight polling loop.',
  inputSchema: z
    .object({
      room: z.string().min(1),
      since: z.string().optional(),
      wait_ms: z.number().int().min(0).max(60_000).optional(),
    })
    .strict(),
  handler: async ({ manager, repo }, args) => {
    const room = manager.resolveRoom(args.room);
    if (!room) return err(`No such room: ${args.room}`);
    const initial = repo.fetchSince(room.idHex, args.since);
    if (initial.length > 0 || !args.wait_ms) {
      return ok(
        initial
          .map((m) => `[${m.ts}] @${m.nickname || m.sender.slice(0, 6)}: ${m.text}`)
          .join('\n') || '(no new messages)',
        { messages: initial.map(msgRowToWire) },
      );
    }

    // Long-poll. Install the listener FIRST, then recheck the store to close
    // the race where a message lands between fetchSince and listener install.
    const theRoom = room;
    const waitMs = args.wait_ms;
    const msg: Message | null = await new Promise((resolve) => {
      let done = false;
      const finish = (m: Message | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        theRoom.off('message', onMessage);
        resolve(m);
      };
      const onMessage = (r: any): void => finish(msgRowToWire(r));
      const timer = setTimeout(() => finish(null), waitMs);
      theRoom.on('message', onMessage);
      // Re-check after listener install — defends against the race.
      const raced = repo.fetchSince(room.idHex, args.since);
      if (raced.length > 0) finish(msgRowToWire(raced[0]));
    });
    if (!msg) return ok('(no new messages)', { messages: [] });
    return ok(`[${msg.ts}] @${msg.nickname || msg.sender.slice(0, 6)}: ${msg.text}`, {
      messages: [msg],
    });
  },
};

const setNickname: ToolDef<{ nickname: string }> = {
  name: 'chat_set_nickname',
  description: 'Change your display nickname. Propagated to rooms on your next hello or message.',
  inputSchema: z.object({ nickname: z.string().min(1).max(32) }).strict(),
  handler: async ({ manager }, args) => {
    manager.setNickname(args.nickname);
    return ok(`Nickname set to ${args.nickname}.`, { ok: true });
  },
};

const setTopic: ToolDef<{ room: string; topic: string }> = {
  name: 'chat_set_topic',
  description:
    "Set the topic of a room you have joined. Only the creator's topic changes are authoritative.",
  inputSchema: z.object({ room: z.string().min(1), topic: z.string().max(200) }).strict(),
  handler: async ({ manager }, args) => {
    const room = manager.resolveRoom(args.room);
    if (!room) return err(`No such room: ${args.room}`);
    room.setTopic(args.topic);
    return ok('Topic set.', { ok: true });
  },
};

const createInvite: ToolDef<{ room: string }> = {
  name: 'chat_create_invite',
  description:
    'Create (or reprint) an invite ticket for a room so you can share it with another agent or human.',
  inputSchema: z.object({ room: z.string().min(1) }).strict(),
  handler: async ({ manager }, args) => {
    const room = manager.resolveRoom(args.room);
    if (!room) return err(`No such room: ${args.room}`);
    return ok(`Invite ticket for ${room.name}:\n${room.toTicket()}`, { ticket: room.toTicket() });
  },
};

const kick: ToolDef<{ room: string; pubkey: string }> = {
  name: 'chat_kick',
  description:
    "Kick a member from a room and rotate the room key. Only the room creator's kick is durable.",
  inputSchema: z.object({ room: z.string().min(1), pubkey: z.string().min(10) }).strict(),
  handler: async ({ manager }, args) => {
    const room = manager.resolveRoom(args.room);
    if (!room) return err(`No such room: ${args.room}`);
    const target = parsePubkey(args.pubkey);
    if (!target) return err(`Invalid pubkey: ${args.pubkey}`);
    try {
      room.kick(target);
    } catch (e: any) {
      return err(e.message || 'kick failed');
    }
    return ok('Kicked.', { ok: true });
  },
};

// ---- Notes + Graph -----------------------------------------------------

const NOTE_BODY_MAX = 64 * 1024; // 64 KB
const NOTE_TITLE_MAX = 256;
const GRAPH_PROPS_MAX = 4 * 1024; // 4 KB serialised
const GRAPH_BATCH_MAX = 100;
const GRAPH_STRING_MAX = 512;
// Tags: lower-case alphanumerics + dash + underscore + dot + colon + slash.
// Permissive enough for "design", "project/foo", "issue:42"; restrictive
// enough that our JSON-encoded-blob tag filter can't be injected with %, _,
// or escape chars.
const TAG_PATTERN = /^[A-Za-z0-9._:/-]+$/;

function sizeOfJson(v: unknown): number {
  return JSON.stringify(v).length;
}

/** Notes and graph rows store authors as base32; MCP responses surface hex. */
const authorToHex = base32ToHex;

const notePut: ToolDef<{
  room: string;
  id?: string;
  title: string;
  body: string;
  tags?: string[];
}> = {
  name: 'chat_note_put',
  description:
    'Create or update a shared note in a room. Notes are markdown documents visible to every room member. Conflicts resolve by last-write-wins on the update timestamp. Use this to publish a document, design doc, or task plan that multiple agents and humans can read and update.',
  inputSchema: z
    .object({
      room: z.string().min(1),
      id: z.string().min(1).max(128).optional(),
      title: z.string().min(1).max(NOTE_TITLE_MAX),
      body: z.string().max(NOTE_BODY_MAX),
      tags: z.array(z.string().min(1).max(64).regex(TAG_PATTERN)).max(32).optional(),
    })
    .strict(),
  handler: async ({ manager }, args) => {
    const room = manager.resolveRoom(args.room);
    if (!room) return err(`No such room: ${args.room}`);
    const res = room.putNote({ id: args.id, title: args.title, body: args.body, tags: args.tags });
    return ok(`Note "${args.title}" saved.`, {
      note_id: res.id,
      updated_at: new Date(res.updated_at).toISOString(),
    });
  },
};

const noteGet: ToolDef<{ room: string; id: string }> = {
  name: 'chat_note_get',
  description: 'Fetch a single note by id.',
  inputSchema: z.object({ room: z.string().min(1), id: z.string().min(1) }).strict(),
  handler: async ({ manager, repo }, args) => {
    const room = manager.resolveRoom(args.room);
    if (!room) return err(`No such room: ${args.room}`);
    const n = repo.getNote(room.idHex, args.id);
    if (!n || n.deleted) return err('Note not found (or deleted).');
    return ok(`# ${n.title}\n\n${n.body}`, {
      id: n.id,
      title: n.title,
      body: n.body,
      tags: n.tags,
      author: authorToHex(n.author),
      updated_at: new Date(n.updated_at).toISOString(),
    });
  },
};

const noteList: ToolDef<{ room: string; tag?: string; query?: string; limit?: number }> = {
  name: 'chat_note_list',
  description:
    'List shared notes in a room. Optionally filter by tag or full-text query (substring match on title + body). Returns metadata + snippet.',
  inputSchema: z
    .object({
      room: z.string().min(1),
      tag: z.string().min(1).max(64).regex(TAG_PATTERN).optional(),
      query: z.string().min(1).max(256).optional(),
      limit: z.number().int().positive().max(200).optional(),
    })
    .strict(),
  handler: async ({ manager, repo }, args) => {
    const room = manager.resolveRoom(args.room);
    if (!room) return err(`No such room: ${args.room}`);
    const notes = repo.listNotes(room.idHex, {
      tag: args.tag,
      query: args.query,
      limit: args.limit,
    });
    const wire = notes.map((n) => ({
      id: n.id,
      title: n.title,
      tags: n.tags,
      author: authorToHex(n.author),
      updated_at: new Date(n.updated_at).toISOString(),
      preview: n.body.slice(0, 160),
    }));
    const text = wire.length
      ? wire.map((n) => `- ${n.title} (${n.id.slice(0, 8)}…) [${n.tags.join(', ')}]`).join('\n')
      : '(no notes)';
    return ok(text, { notes: wire });
  },
};

const noteDelete: ToolDef<{ room: string; id: string }> = {
  name: 'chat_note_delete',
  description:
    'Delete a shared note. Creates a cryptographic tombstone so replays cannot resurrect it.',
  inputSchema: z.object({ room: z.string().min(1), id: z.string().min(1) }).strict(),
  handler: async ({ manager }, args) => {
    const room = manager.resolveRoom(args.room);
    if (!room) return err(`No such room: ${args.room}`);
    room.deleteNote(args.id);
    return ok('Deleted.', { ok: true });
  },
};

const graphAssert: ToolDef<{
  room: string;
  triples: Array<{
    id?: string;
    src: string;
    predicate: string;
    dst: string;
    src_type?: string;
    dst_type?: string;
    src_label?: string;
    dst_label?: string;
    props?: Record<string, unknown>;
  }>;
}> = {
  name: 'chat_graph_assert',
  description:
    'Assert one or more knowledge-graph triples in a room. A triple is (src, predicate, dst) with optional types, labels, and properties. Use this to record facts other agents can query: "service-A depends_on service-B", "issue-42 assigned_to alice", "document-X references document-Y". Batch up to 100 triples per call.',
  inputSchema: z
    .object({
      room: z.string().min(1),
      triples: z
        .array(
          z
            .object({
              id: z.string().min(1).max(128).optional(),
              src: z.string().min(1).max(GRAPH_STRING_MAX),
              predicate: z.string().min(1).max(GRAPH_STRING_MAX),
              dst: z.string().min(1).max(GRAPH_STRING_MAX),
              src_type: z.string().max(GRAPH_STRING_MAX).optional(),
              dst_type: z.string().max(GRAPH_STRING_MAX).optional(),
              src_label: z.string().max(GRAPH_STRING_MAX).optional(),
              dst_label: z.string().max(GRAPH_STRING_MAX).optional(),
              props: z.record(z.unknown()).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(GRAPH_BATCH_MAX),
    })
    .strict(),
  handler: async ({ manager }, args) => {
    const room = manager.resolveRoom(args.room);
    if (!room) return err(`No such room: ${args.room}`);
    for (const t of args.triples) {
      if (t.props && sizeOfJson(t.props) > GRAPH_PROPS_MAX) {
        return err(
          `props for triple "${t.src} ${t.predicate} ${t.dst}" exceed ${GRAPH_PROPS_MAX} bytes`,
        );
      }
    }
    const res = room.assertTriples(args.triples);
    return ok(`Asserted ${res.ids.length} triples.`, { ids: res.ids });
  },
};

const graphRetract: ToolDef<{ room: string; ids: string[] }> = {
  name: 'chat_graph_retract',
  description:
    'Retract knowledge-graph triples by id. Replays of the original assertion with earlier timestamps are rejected.',
  inputSchema: z
    .object({
      room: z.string().min(1),
      ids: z.array(z.string().min(1).max(128)).min(1).max(GRAPH_BATCH_MAX),
    })
    .strict(),
  handler: async ({ manager }, args) => {
    const room = manager.resolveRoom(args.room);
    if (!room) return err(`No such room: ${args.room}`);
    const res = room.retractTriples(args.ids);
    return ok(`Retracted ${res.ids.length} triples.`, { ids: res.ids });
  },
};

const graphQuery: ToolDef<{
  room: string;
  src?: string;
  predicate?: string;
  dst?: string;
  src_type?: string;
  dst_type?: string;
  limit?: number;
}> = {
  name: 'chat_graph_query',
  description:
    'Query the room knowledge graph. Any combination of src / predicate / dst / src_type / dst_type acts as a filter (undefined = wildcard). Returns matching triples ordered by recency. Use this to answer "what does X depend on?", "who owns Y?", etc.',
  inputSchema: z
    .object({
      room: z.string().min(1),
      src: z.string().max(GRAPH_STRING_MAX).optional(),
      predicate: z.string().max(GRAPH_STRING_MAX).optional(),
      dst: z.string().max(GRAPH_STRING_MAX).optional(),
      src_type: z.string().max(GRAPH_STRING_MAX).optional(),
      dst_type: z.string().max(GRAPH_STRING_MAX).optional(),
      limit: z.number().int().positive().max(500).optional(),
    })
    .strict(),
  handler: async ({ manager, repo }, args) => {
    const room = manager.resolveRoom(args.room);
    if (!room) return err(`No such room: ${args.room}`);
    const rows = repo
      .queryGraph(room.idHex, args)
      .map((r) => ({ ...r, author: authorToHex(r.author) }));
    const text = rows.length
      ? rows.map((r) => `(${r.src}) -[${r.predicate}]-> (${r.dst})`).join('\n')
      : '(no matches)';
    return ok(text, { triples: rows });
  },
};

const setAdmission: ToolDef<{ room: string; mode: 'open' | 'approval' }> = {
  name: 'chat_set_admission',
  description:
    "Set a room's admission mode. 'open' (default): anyone with the ticket joins immediately. 'approval': joiners land in a pending queue until the creator explicitly approves each one. Only the creator's admission setting is authoritative.",
  inputSchema: z
    .object({
      room: z.string().min(1),
      mode: z.enum(['open', 'approval']),
    })
    .strict(),
  handler: async ({ manager }, args) => {
    const room = manager.resolveRoom(args.room);
    if (!room) return err(`No such room: ${args.room}`);
    room.setAdmissionMode(args.mode);
    return ok(`Admission mode set to ${args.mode}.`, { ok: true, mode: args.mode });
  },
};

const listPending: ToolDef<{ room: string }> = {
  name: 'chat_list_pending',
  description:
    'List peers that have requested to join an approval-mode room but have not yet been approved. Creator-only.',
  inputSchema: z.object({ room: z.string().min(1) }).strict(),
  handler: async ({ manager }, args) => {
    const room = manager.resolveRoom(args.room);
    if (!room) return err(`No such room: ${args.room}`);
    const pending = room.listPending().map((p) => ({
      pubkey: bytesToHex(p.pubkey),
      nickname: p.nickname,
      client: p.client,
      requested_at: new Date(p.ts).toISOString(),
    }));
    const text = pending.length
      ? pending.map((p) => `- @${p.nickname} (${p.pubkey.slice(0, 12)}…)`).join('\n')
      : '(no pending requests)';
    return ok(text, { pending });
  },
};

const approveJoin: ToolDef<{ room: string; pubkey: string }> = {
  name: 'chat_approve_join',
  description:
    'Approve a pending join request. The approved peer receives a sealed key update and joins the room. Only the creator can approve.',
  inputSchema: z.object({ room: z.string().min(1), pubkey: z.string().min(10) }).strict(),
  handler: async ({ manager }, args) => {
    const room = manager.resolveRoom(args.room);
    if (!room) return err(`No such room: ${args.room}`);
    const target = parsePubkey(args.pubkey);
    if (!target) return err(`Invalid pubkey: ${args.pubkey}`);
    const approved = room.approveJoin(target);
    return approved ? ok('Approved.', { ok: true }) : err('No pending request for that pubkey.');
  },
};

const denyJoin: ToolDef<{ room: string; pubkey: string }> = {
  name: 'chat_deny_join',
  description: 'Deny a pending join request. The peer never receives the room key. Creator-only.',
  inputSchema: z.object({ room: z.string().min(1), pubkey: z.string().min(10) }).strict(),
  handler: async ({ manager }, args) => {
    const room = manager.resolveRoom(args.room);
    if (!room) return err(`No such room: ${args.room}`);
    const target = parsePubkey(args.pubkey);
    if (!target) return err(`Invalid pubkey: ${args.pubkey}`);
    const denied = room.denyJoin(target);
    return denied ? ok('Denied.', { ok: true }) : err('No pending request for that pubkey.');
  },
};

const graphNeighbors: ToolDef<{ room: string; node: string; depth?: number; limit?: number }> = {
  name: 'chat_graph_neighbors',
  description:
    'Return the subgraph within `depth` hops of a node (default 1). Bounded in breadth by `limit` (default 100).',
  inputSchema: z
    .object({
      room: z.string().min(1),
      node: z.string().min(1).max(GRAPH_STRING_MAX),
      depth: z.number().int().min(1).max(4).optional(),
      limit: z.number().int().positive().max(500).optional(),
    })
    .strict(),
  handler: async ({ manager, repo }, args) => {
    const room = manager.resolveRoom(args.room);
    if (!room) return err(`No such room: ${args.room}`);
    const sub = repo.neighbors(room.idHex, args.node, args.depth ?? 1, args.limit ?? 100);
    const edges = sub.edges.map((e) => ({ ...e, author: authorToHex(e.author) }));
    return ok(`${sub.nodes.length} nodes, ${edges.length} edges`, { nodes: sub.nodes, edges });
  },
};

const openWeb: ToolDef<Record<string, never>> = {
  name: 'chat_open_web',
  description:
    "Return the local web UI URL (with auto-login token) and attempt to open it in the user's default browser. Call this when the user asks to open the chat / web UI / switch to the browser view.",
  inputSchema: z.object({}).strict(),
  handler: async () => {
    const { readWebUrl } = await import('../web/url-file.js');
    const url = readWebUrl();
    if (!url) {
      return err(
        'No web UI URL recorded. Start the server with `agentchat web` or restart the MCP session (the sidecar writes the URL on boot).',
      );
    }
    try {
      const { tryOpenBrowser } = await import('../web/open-browser.js');
      tryOpenBrowser(url);
    } catch {
      // best-effort — URL is still returned to the caller
    }
    return ok(`Opening ${url}\n\nIf no browser opened, click or paste the URL above.`, {
      url,
      opened_browser: true,
    });
  },
};

export const ALL_TOOLS: ToolDef<any>[] = [
  whoami,
  createRoom,
  joinRoom,
  leaveRoom,
  listRooms,
  listMembers,
  sendMessage,
  directMessage,
  fetchHistory,
  tail,
  setNickname,
  setTopic,
  createInvite,
  kick,
  notePut,
  noteGet,
  noteList,
  noteDelete,
  graphAssert,
  graphRetract,
  graphQuery,
  graphNeighbors,
  setAdmission,
  listPending,
  approveJoin,
  denyJoin,
  openWeb,
];
