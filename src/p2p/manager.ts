import { EventEmitter } from 'node:events';
import type { Repo } from '../store/repo.js';
import { base32Decode, base32Encode } from './base32.js';
import { blake3, concatBytes, deriveRoomId, randomKey } from './crypto.js';
import type { Envelope } from './envelope.js';
import type { Identity } from './identity.js';
import { type AdmissionMode, Room } from './room.js';
import { Swarm } from './swarm.js';
import { decodeTicket } from './ticket.js';

export interface RoomManagerOptions {
  identity: Identity;
  repo: Repo;
  nickname: string;
  clientName: string;
  version: string;
  swarm?: Swarm;
}

export class RoomManager extends EventEmitter {
  readonly rooms: Map<string, Room> = new Map(); // keyed by idHex
  readonly identity: Identity;
  readonly repo: Repo;
  readonly clientName: string;
  readonly version: string;
  private nickname: string;
  readonly swarm: Swarm;
  private started = false;

  constructor(opts: RoomManagerOptions) {
    super();
    this.setMaxListeners(100);
    this.identity = opts.identity;
    this.repo = opts.repo;
    this.nickname = opts.nickname;
    this.clientName = opts.clientName;
    this.version = opts.version;
    this.swarm = opts.swarm || new Swarm();

    this.swarm.on('envelope', (env: Envelope) => {
      const key = Buffer.from(env.room).toString('hex');
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
          room.sendHello(this.nickname, this.clientName, this.version);
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
  setNickname(nick: string): void {
    this.nickname = nick;
    // Re-broadcast hello to every active room so peers learn the new
    // nickname without waiting for a reconnect. Best-effort — silent on
    // error because a swarm that's mid-teardown may refuse a write.
    for (const room of this.rooms.values()) {
      try {
        room.sendHello(this.nickname, this.clientName, this.version);
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
          });
        } catch {
          // skip malformed row
        }
      }
      this.attachRoom(room);
      await this.swarm.joinTopic(room.id);
      room.sendHello(this.nickname, this.clientName, this.version);
    } catch {
      // Individual room rehydration failures are isolated — one bad row
      // shouldn't block the rest of the rooms from coming up.
    }
  }

  async stop(): Promise<void> {
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
    room.initSelf(this.nickname);
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
    room.initSelf(nickname);
    await this.swarm.joinTopic(room.id);
    room.sendHello(nickname, this.clientName, this.version);
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
    room.sendHello(this.nickname, this.clientName, this.version);
    return room;
  }
}
