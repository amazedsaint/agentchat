import { EventEmitter } from 'node:events';
import type { Repo } from '../store/repo.js';
import { base32Decode, base32Encode } from './base32.js';
import { blake3, concatBytes, deriveRoomId, randomKey } from './crypto.js';
import { type Envelope, openEnvelope, sealEnvelope } from './envelope.js';
import type { Identity } from './identity.js';
import {
  type PresencePayload,
  type RemoteSession,
  derivePresenceParams,
  machineLabel,
} from './presence.js';
import { type AdmissionMode, Room } from './room.js';
import { Swarm } from './swarm.js';
import { decodeTicket } from './ticket.js';

export interface RoomManagerOptions {
  identity: Identity;
  repo: Repo;
  nickname: string;
  clientName: string;
  version: string;
  bio?: string;
  /** Stable UUID for this machine — used by the presence layer to
   * distinguish multiple agentchat installs that share the same Ed25519
   * identity. If omitted, presence sync is disabled. */
  machineId?: string;
  swarm?: Swarm;
}

export class RoomManager extends EventEmitter {
  readonly rooms: Map<string, Room> = new Map(); // keyed by idHex
  readonly identity: Identity;
  readonly repo: Repo;
  readonly clientName: string;
  readonly version: string;
  private nickname: string;
  private bio: string;
  readonly swarm: Swarm;
  private started = false;

  /** Presence-sync state. The topic is private-key-scoped so only the same
   * identity's other installs can find it; foreign peers can't derive it
   * without the private key. Null when machineId isn't set (presence
   * disabled). */
  private readonly presence: {
    machineId: string;
    topic: Uint8Array;
    topicHex: string;
    key: Uint8Array;
    timer: NodeJS.Timeout | null;
    /** Remote machines' latest sessions, keyed by machine_id. Purged when
     * the remote's `ts` is older than 3× the broadcast interval. */
    remote: Map<string, { ts: number; sessions: RemoteSession[] }>;
  } | null;

  constructor(opts: RoomManagerOptions) {
    super();
    this.setMaxListeners(100);
    this.identity = opts.identity;
    this.repo = opts.repo;
    this.nickname = opts.nickname;
    this.clientName = opts.clientName;
    this.version = opts.version;
    this.bio = opts.bio || '';
    this.swarm = opts.swarm || new Swarm();

    // Presence topic + key are derived from the Ed25519 seed. Only the
    // same identity's other machines can find the topic + decrypt.
    if (opts.machineId) {
      const { topic, key } = derivePresenceParams(this.identity.privateKey);
      this.presence = {
        machineId: opts.machineId,
        topic,
        topicHex: Buffer.from(topic).toString('hex'),
        key,
        timer: null,
        remote: new Map(),
      };
    } else {
      this.presence = null;
    }

    this.swarm.on('envelope', (env: Envelope) => {
      const key = Buffer.from(env.room).toString('hex');
      // Presence envelopes ride the same wire but route to the presence
      // sync handler, not a Room — they belong to a private-key-scoped
      // topic that nobody outside this identity can derive.
      if (this.presence && key === this.presence.topicHex && env.type === 'presence') {
        this.handlePresenceEnvelope(env);
        return;
      }
      const room = this.rooms.get(key);
      if (!room) return;
      room.handleEnvelope(env);
    });

    // Re-send our hello for every active room whenever a new peer connects.
    // Hyperswarm connections can appear any time after we've called joinTopic,
    // so a one-shot hello on join will miss every peer that connects later.
    this.swarm.on('connection', () => {
      for (const room of this.rooms.values()) {
        try {
          room.sendHello(this.nickname, this.clientName, this.version, this.bio);
        } catch {
          /* best-effort */
        }
      }
    });

    // Never let swarm decode errors bubble to an unhandled rejection.
    this.swarm.on('error', () => {
      /* swallow */
    });
  }

  getNickname(): string {
    return this.nickname;
  }
  getBio(): string {
    return this.bio;
  }
  setBio(bio: string): void {
    this.bio = bio;
    // Same rationale as setNickname — re-broadcast so peers learn the new bio
    // without waiting for the next reconnect or message.
    for (const room of this.rooms.values()) {
      try {
        room.sendHello(this.nickname, this.clientName, this.version, this.bio);
      } catch {
        /* ignore */
      }
    }
  }
  setNickname(nick: string): void {
    this.nickname = nick;
    // Re-broadcast hello to every active room so peers learn the new
    // nickname without waiting for a reconnect. Best-effort — silent on
    // error because a swarm that's mid-teardown may refuse a write.
    for (const room of this.rooms.values()) {
      try {
        room.sendHello(this.nickname, this.clientName, this.version, this.bio);
      } catch {
        /* ignore */
      }
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.swarm.start();
    this.started = true;
    await Promise.all(this.repo.listRooms().map((r) => this.rehydrateRoom(r)));
    await this.startPresence();
  }

  private async startPresence(): Promise<void> {
    if (!this.presence) return;
    await this.swarm.joinTopic(this.presence.topic);
    // Broadcast immediately so peers that are already listening don't have
    // to wait the full interval for our first snapshot.
    this.broadcastPresence();
    const INTERVAL_MS = 30_000;
    this.presence.timer = setInterval(() => {
      this.broadcastPresence();
      this.gcRemoteSessions();
    }, INTERVAL_MS);
    this.presence.timer.unref?.();
    this.swarm.on('connection', () => this.broadcastPresence());
  }

  private broadcastPresence(): void {
    if (!this.presence) return;
    const cutoff = Date.now() - 90_000;
    const localSessions = this.repo.listActiveSessions(cutoff);
    const inner: PresencePayload = {
      v: 1,
      machine_id: this.presence.machineId,
      ts: Date.now(),
      sessions: localSessions.map((s) => ({
        id: s.id,
        pid: s.pid,
        client: s.client,
        kind: s.kind,
        cwd: s.cwd,
        repo_name: s.repo_name,
        repo_room_id: s.repo_room_id,
        started_at: s.started_at,
        last_seen: s.last_seen,
      })),
    };
    try {
      const env = sealEnvelope(
        'presence',
        this.presence.topic,
        this.identity.publicKey,
        this.identity.privateKey,
        this.presence.key,
        inner,
      );
      this.swarm.broadcast(env);
    } catch {
      /* best-effort — a missed broadcast just means the next one catches up */
    }
  }

  private handlePresenceEnvelope(env: Envelope): void {
    if (!this.presence) return;
    // Any peer with our Ed25519 private key signs as our pubkey, so the
    // `from` match alone doesn't distinguish local from remote. The
    // machine_id INSIDE the payload is what differentiates installs.
    const inner = openEnvelope<PresencePayload>(env, [this.presence.key]);
    if (!inner || inner.v !== 1 || typeof inner.machine_id !== 'string') return;
    if (!Array.isArray(inner.sessions)) return;
    if (inner.machine_id === this.presence.machineId) return; // our own echo
    const remoteSessions: RemoteSession[] = inner.sessions.map((s) => ({
      ...s,
      machine_id: inner.machine_id,
      machine_label: machineLabel(inner.machine_id),
    }));
    this.presence.remote.set(inner.machine_id, {
      ts: inner.ts,
      sessions: remoteSessions,
    });
    this.emit('remote_sessions_updated');
  }

  private gcRemoteSessions(): void {
    if (!this.presence) return;
    const cutoff = Date.now() - 90_000;
    for (const [mid, entry] of this.presence.remote) {
      if (entry.ts < cutoff) this.presence.remote.delete(mid);
    }
  }

  /** Flat list of sessions from every other machine running this identity. */
  getRemoteSessions(): RemoteSession[] {
    if (!this.presence) return [];
    this.gcRemoteSessions();
    const out: RemoteSession[] = [];
    for (const entry of this.presence.remote.values()) out.push(...entry.sessions);
    return out;
  }

  /**
   * Rehydrate any rooms in the DB we don't already have in memory.
   *
   * Intended use: periodic refresh when the user has multiple local
   * processes (e.g. agentchat mcp + agentchat web) running on the same
   * identity. If the MCP process creates a room, the web process's
   * manager won't know until it rehydrates. Each call only wakes rooms
   * not already in `this.rooms`, so it's a no-op when there's nothing new.
   */
  async rehydrateNewRooms(): Promise<number> {
    if (!this.started) return 0;
    const missing = this.repo.listRooms().filter((r) => !this.rooms.has(r.id));
    await Promise.all(missing.map((r) => this.rehydrateRoom(r)));
    return missing.length;
  }

  private async rehydrateRoom(r: import('../store/repo.js').RoomRow): Promise<void> {
    try {
      const rootSecret = base32Decode(r.root_secret);
      const currentKey = base32Decode(r.current_key);
      const creatorPubkey = base32Decode(r.creator_pubkey);
      const room = new Room(
        {
          name: r.name,
          rootSecret,
          creatorPubkey,
          topic: r.topic,
          bootstrap: [creatorPubkey],
          admissionMode: r.admission_mode === 'approval' ? 'approval' : 'open',
        },
        this.identity,
        this.repo,
        (env) => this.swarm.broadcast(env),
      );
      if (r.epoch > 0) room.seedEpochKey(r.epoch, currentKey);
      for (const jr of this.repo.listJoinRequests(r.id)) {
        try {
          room.pending.set(jr.pubkey, {
            pubkey: base32Decode(jr.pubkey),
            x25519_pub: base32Decode(jr.x25519_pub),
            nickname: jr.nickname,
            client: jr.client,
            ts: jr.ts,
          });
        } catch {
          // skip malformed row; schema is validated on write
        }
      }
      for (const mem of this.repo.listMembers(r.id)) {
        try {
          // x25519_pub may be empty for rows written before the column existed
          // or before a peer's first hello post-restart; key rotations skip
          // members whose x25519 isn't 32 bytes, so those get refreshed lazily.
          room.seedMember({
            pubkey: base32Decode(mem.pubkey),
            nickname: mem.nickname,
            joined_at: new Date(mem.joined_at).getTime(),
            x25519_pub: mem.x25519_pub ? base32Decode(mem.x25519_pub) : new Uint8Array(0),
            online: false,
            client: mem.client || '',
            bio: mem.bio || '',
          });
        } catch {
          // skip malformed row
        }
      }
      this.attachRoom(room);
      await this.swarm.joinTopic(room.id);
      room.sendHello(this.nickname, this.clientName, this.version, this.bio);
    } catch {
      // Individual room rehydration failures are isolated — one bad row
      // shouldn't block the rest of the rooms from coming up.
    }
  }

  async stop(): Promise<void> {
    if (this.presence?.timer) {
      clearInterval(this.presence.timer);
      this.presence.timer = null;
    }
    await this.swarm.destroy();
    this.started = false;
  }

  private attachRoom(room: Room): void {
    room.on('message', (m) => this.emit('message', m, room));
    room.on('member_joined', (m) => this.emit('member_joined', m, room));
    room.on('member_kicked', (p) => this.emit('member_kicked', p, room));
    room.on('members_update', (ms) => this.emit('members_update', ms, room));
    // When the room closes — either because we received the creator-signed
    // close envelope, or because we (as creator) broadcast one via
    // closeRoom() — drop the in-memory Room and mark it closed. The
    // swarm.leaveTopic call is deferred only on the creator path (handled
    // by leaveRoom, which sleeps first so the broadcast flushes); for
    // non-creators receiving the close we tear down the swarm immediately.
    room.on('closed', (info: { closed_at: number; reason?: string }) => {
      this.emit('room_closed', { room_id: room.idHex, name: room.name, ...info }, room);
      this.rooms.delete(room.idHex);
      this.repo.markRoomLeft(room.idHex);
      if (!room.isCreator()) {
        this.swarm.leaveTopic(room.id).catch(() => {
          /* already gone is fine */
        });
      }
    });
    // Creator kicked us: room.ts deletes the local member row and emits
    // 'self_kicked', but without this we'd keep the Room in memory and stay
    // joined to the swarm topic — silently receiving traffic we can no
    // longer decrypt after the creator's rotate_key. Tear it down the same
    // way a remote-close would.
    room.on('self_kicked', () => {
      this.emit('room_kicked', { room_id: room.idHex, name: room.name }, room);
      this.rooms.delete(room.idHex);
      this.repo.markRoomLeft(room.idHex);
      this.swarm.leaveTopic(room.id).catch(() => {
        /* already gone is fine */
      });
    });
    this.rooms.set(room.idHex, room);
  }

  /**
   * Join (or create locally, if not yet in memory) a leaderless room keyed
   * to a deterministic rootSecret — useful for "everyone working on this
   * GitHub repo" scenarios where peers can't exchange tickets ahead of
   * time. The creator pubkey is the all-zeros placeholder so nobody can
   * sign kick/close/members; peers discover each other via mutual hellos
   * and the key never rotates (epoch 0 only).
   *
   * Idempotent across restarts — the same canonical URL always derives
   * the same room id. Pass the same `name` ("#owner/repo") so the UI
   * shows a stable label.
   */
  async joinOrCreateLeaderlessRoom(
    name: string,
    rootSecret: Uint8Array,
    leaderlessCreator: Uint8Array,
  ): Promise<Room> {
    const roomId = deriveRoomId(name, rootSecret);
    const idHex = Buffer.from(roomId).toString('hex');
    const existing = this.rooms.get(idHex);
    if (existing) return existing;
    const room = new Room(
      {
        name,
        rootSecret,
        creatorPubkey: leaderlessCreator,
        bootstrap: [],
        admissionMode: 'open',
      },
      this.identity,
      this.repo,
      (env) => this.swarm.broadcast(env),
    );
    this.attachRoom(room);
    room.initSelf(this.nickname, this.clientName, this.bio);
    await this.swarm.joinTopic(room.id);
    room.sendHello(this.nickname, this.clientName, this.version, this.bio);
    return room;
  }

  async createRoom(
    name: string,
    topic?: string,
    admissionMode: AdmissionMode = 'open',
  ): Promise<Room> {
    const rootSecret = randomKey();
    const room = new Room(
      {
        name,
        rootSecret,
        creatorPubkey: this.identity.publicKey,
        topic,
        bootstrap: [this.identity.publicKey],
        admissionMode,
      },
      this.identity,
      this.repo,
      (env) => this.swarm.broadcast(env),
    );
    this.attachRoom(room);
    room.initSelf(this.nickname, this.clientName, this.bio);
    // In approval mode, immediately rotate so the initial msg key is NOT
    // derivable from the ticket alone. Anyone joining must be approved to
    // receive the epoch-1+ key.
    if (admissionMode === 'approval') {
      room.rotateKey();
    }
    await this.swarm.joinTopic(room.id);
    return room;
  }

  async joinByTicket(ticket: string, nicknameOverride?: string): Promise<Room> {
    const t = decodeTicket(ticket);
    const nickname = nicknameOverride || this.nickname;
    const precomputedId = deriveRoomId(t.roomName, t.rootSecret);
    const idHex = Buffer.from(precomputedId).toString('hex');
    if (this.repo.isRoomClosed(idHex)) {
      throw new Error('This room has been closed by its creator.');
    }
    const existing = this.rooms.get(idHex);
    if (existing) return existing;
    const room = new Room(
      {
        name: t.roomName,
        rootSecret: t.rootSecret,
        creatorPubkey: t.bootstrapPubkeys[0] || this.identity.publicKey,
        bootstrap: t.bootstrapPubkeys,
      },
      this.identity,
      this.repo,
      (env) => this.swarm.broadcast(env),
    );
    this.attachRoom(room);
    room.initSelf(nickname, this.clientName, this.bio);
    await this.swarm.joinTopic(room.id);
    room.sendHello(nickname, this.clientName, this.version, this.bio);
    return room;
  }

  resolveRoom(roomIdOrName: string): Room | undefined {
    if (this.rooms.has(roomIdOrName)) return this.rooms.get(roomIdOrName);
    for (const r of this.rooms.values()) if (r.name === roomIdOrName) return r;
    const row = this.repo.resolveRoom(roomIdOrName);
    return row ? this.rooms.get(row.id) : undefined;
  }

  async leaveRoom(idOrName: string): Promise<boolean> {
    const room = this.resolveRoom(idOrName);
    if (!room) return false;
    if (room.isCreator()) {
      // Creator leaving closes the room for everyone. Broadcast the signed
      // close envelope first, give it a moment to flush to connected peers,
      // then tear down the swarm connection.
      try {
        room.closeRoom();
      } catch {
        /* fall through to leave anyway */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    await this.swarm.leaveTopic(room.id);
    this.repo.markRoomLeft(room.idHex);
    this.rooms.delete(room.idHex);
    return true;
  }

  /** Explicit close — same effect as the creator leaving, but without the
   * overload on `leaveRoom`. Safe to call from UI "Close room" buttons. */
  async closeAndLeave(idOrName: string): Promise<boolean> {
    return this.leaveRoom(idOrName);
  }

  /**
   * Direct message room derivation. Both participants must land on the same
   * room id + root secret independently. We derive:
   *   - a deterministic dm name from the sorted pair of pubkey prefixes
   *   - a root secret = BLAKE3("agentchat v1 dm" || sortedA || sortedB)
   * So both sides produce identical rootSecret and room id.
   */
  async openDM(peerPubkey: Uint8Array): Promise<Room> {
    const mine = this.identity.publicKey;
    if (Buffer.compare(mine, peerPubkey) === 0) {
      throw new Error('cannot DM yourself');
    }
    const [a, b] = [mine, peerPubkey].sort((x, y) => Buffer.compare(x, y));
    const aShort = base32Encode(a).slice(0, 6);
    const bShort = base32Encode(b).slice(0, 6);
    const dmName = `dm:${aShort}-${bShort}`;

    const dmLabel = new TextEncoder().encode('agentchat v1 dm');
    const rootSecret = blake3(concatBytes(dmLabel, a, b), 32);

    // Compute the id directly so we can dedupe without instantiating.
    const roomId = deriveRoomId(dmName, rootSecret);
    const roomIdHex = Buffer.from(roomId).toString('hex');
    const existing = this.rooms.get(roomIdHex);
    if (existing) return existing;

    const room = new Room(
      {
        name: dmName,
        rootSecret,
        // Creator-is-the-alphabetically-lower-pubkey, so both sides agree.
        creatorPubkey: a,
        bootstrap: [a, b],
      },
      this.identity,
      this.repo,
      (env) => this.swarm.broadcast(env),
    );
    this.attachRoom(room);
    if (Buffer.compare(mine, a) === 0) room.initSelf(this.nickname);
    else room.initSelf(this.nickname);
    await this.swarm.joinTopic(room.id);
    room.sendHello(this.nickname, this.clientName, this.version, this.bio);
    return room;
  }
}
