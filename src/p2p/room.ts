import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Repo } from '../store/repo.js';
import { base32Encode } from './base32.js';
import { deriveRoomId, hkdf, openSealedBox, randomKey, sealToX25519 } from './crypto.js';
import {
  type Envelope,
  type InnerClose,
  type InnerGraphAssert,
  type InnerGraphRetract,
  type InnerHello,
  type InnerKeyUpdate,
  type InnerKick,
  type InnerMembers,
  type InnerMsg,
  type InnerNoteDelete,
  type InnerNotePut,
  openEnvelope,
  sealEnvelope,
} from './envelope.js';
import type { Identity } from './identity.js';
import { encodeTicket } from './ticket.js';

export type AdmissionMode = 'open' | 'approval';

export interface RoomInit {
  name: string;
  rootSecret: Uint8Array;
  creatorPubkey: Uint8Array;
  topic?: string;
  bootstrap?: Uint8Array[];
  admissionMode?: AdmissionMode;
}

export interface PendingRequest {
  pubkey: Uint8Array;
  x25519_pub: Uint8Array;
  nickname: string;
  client: string;
  ts: number;
}

export interface MemberInfo {
  pubkey: Uint8Array;
  nickname: string;
  joined_at: number;
  x25519_pub: Uint8Array;
  online: boolean;
  /** Client string from the peer's latest hello. Known agent clients get
   * a 🤖 badge in UIs; known human clients get 👤. See clientKind() for
   * the derivation. Empty string means we've never seen a hello yet. */
  client: string;
  /** Short bio self-declared by the peer in their latest hello. */
  bio: string;
}

/**
 * Known client strings → 'agent' | 'human'. Everything else is treated as
 * 'unknown' and shown as a human in UIs (conservative default — we'd rather
 * not falsely label a human as a bot). New agent clients should be added
 * to the agent list as they come online; the wire protocol doesn't change.
 */
const AGENT_CLIENTS = new Set([
  'claude-code',
  'codex-cli',
  'claude-desktop',
  'codex-desktop',
  'cursor',
  'windsurf',
  'mcp',
  'mcp-runner',
]);
const HUMAN_CLIENTS = new Set(['tui', 'web', 'cli']);

export function clientKind(client: string | undefined | null): 'agent' | 'human' | 'unknown' {
  if (!client) return 'unknown';
  if (AGENT_CLIENTS.has(client)) return 'agent';
  if (HUMAN_CLIENTS.has(client)) return 'human';
  return 'unknown';
}

/**
 * Inbound size caps — enforced on every decoded envelope before we act on
 * it. Tool-level zod schemas only guard OUTGOING requests; a peer that
 * already holds a ticket can speak the wire protocol directly, so the
 * authoritative limits must live here. Violations are silently dropped
 * (return false); the envelope has been decrypted and signature-verified
 * by the time we get here, so we know the sender's pubkey — they'd show
 * up in telemetry if we wanted to warn.
 */
export const INBOUND_LIMITS = {
  MSG_TEXT: 16 * 1024, // 16 KB per message
  NOTE_TITLE: 256,
  NOTE_BODY: 64 * 1024, // 64 KB
  NOTE_TAG_COUNT: 32,
  NOTE_TAG_CHARS: 64,
  NOTE_ID: 128,
  GRAPH_TRIPLE_COUNT: 100,
  GRAPH_STRING: 512,
  GRAPH_PROPS_BYTES: 4 * 1024,
  /** Max epoch keys to retain. Older keys are evicted to bound memory on
   * long-lived rooms with churn — in-flight messages still have ~2s to arrive. */
  EPOCH_KEY_HISTORY: 16,
  /** Max pending join requests (approval-mode) — caps hostile hello floods. */
  PENDING_REQUESTS: 256,
  /** Max members per room roster. Practical IRC-scale rooms are well under
   * this; the cap exists to bound a forged-members gossip's memory blast. */
  ROOM_MEMBERS: 10_000,
  /** Max members per single members-gossip envelope. */
  MEMBERS_GOSSIP: 10_000,
  NICKNAME_CHARS: 128,
  BIO_CHARS: 200,
};

function validHello(inner: InnerHello): boolean {
  if (typeof inner.nickname !== 'string' || inner.nickname.length > INBOUND_LIMITS.NICKNAME_CHARS)
    return false;
  if (typeof inner.client !== 'string' || inner.client.length > INBOUND_LIMITS.NICKNAME_CHARS)
    return false;
  if (typeof inner.version !== 'string' || inner.version.length > INBOUND_LIMITS.NICKNAME_CHARS)
    return false;
  if (!(inner.x25519_pub instanceof Uint8Array) || inner.x25519_pub.length !== 32) return false;
  if (inner.bio !== undefined) {
    if (typeof inner.bio !== 'string' || inner.bio.length > INBOUND_LIMITS.BIO_CHARS) return false;
  }
  return true;
}

function validMembers(inner: InnerMembers): boolean {
  if (!Array.isArray(inner.members)) return false;
  if (inner.members.length > INBOUND_LIMITS.MEMBERS_GOSSIP) return false;
  for (const m of inner.members) {
    if (!(m.pubkey instanceof Uint8Array) || m.pubkey.length !== 32) return false;
    if (!(m.x25519_pub instanceof Uint8Array) || m.x25519_pub.length !== 32) return false;
    if (typeof m.nickname !== 'string' || m.nickname.length > INBOUND_LIMITS.NICKNAME_CHARS)
      return false;
    if (typeof m.joined_at !== 'number' || !Number.isFinite(m.joined_at)) return false;
  }
  return true;
}

function validMsg(inner: InnerMsg): boolean {
  if (typeof inner.text !== 'string' || inner.text.length > INBOUND_LIMITS.MSG_TEXT) return false;
  if (typeof inner.id !== 'string' || inner.id.length > INBOUND_LIMITS.NOTE_ID) return false;
  if (inner.reply_to !== undefined) {
    if (typeof inner.reply_to !== 'string' || inner.reply_to.length > INBOUND_LIMITS.NOTE_ID)
      return false;
  }
  return true;
}

function validNotePut(inner: InnerNotePut): boolean {
  if (
    typeof inner.id !== 'string' ||
    inner.id.length === 0 ||
    inner.id.length > INBOUND_LIMITS.NOTE_ID
  )
    return false;
  if (typeof inner.title !== 'string' || inner.title.length > INBOUND_LIMITS.NOTE_TITLE)
    return false;
  if (typeof inner.body !== 'string' || inner.body.length > INBOUND_LIMITS.NOTE_BODY) return false;
  if (!Array.isArray(inner.tags) || inner.tags.length > INBOUND_LIMITS.NOTE_TAG_COUNT) return false;
  for (const t of inner.tags) {
    if (typeof t !== 'string' || t.length === 0 || t.length > INBOUND_LIMITS.NOTE_TAG_CHARS)
      return false;
  }
  if (typeof inner.updated_at !== 'number' || !Number.isFinite(inner.updated_at)) return false;
  return true;
}

function validNoteDelete(inner: InnerNoteDelete): boolean {
  if (
    typeof inner.id !== 'string' ||
    inner.id.length === 0 ||
    inner.id.length > INBOUND_LIMITS.NOTE_ID
  )
    return false;
  if (typeof inner.deleted_at !== 'number' || !Number.isFinite(inner.deleted_at)) return false;
  return true;
}

function validGraphAssert(inner: InnerGraphAssert): boolean {
  if (
    !Array.isArray(inner.triples) ||
    inner.triples.length === 0 ||
    inner.triples.length > INBOUND_LIMITS.GRAPH_TRIPLE_COUNT
  ) {
    return false;
  }
  for (const t of inner.triples) {
    if (typeof t.id !== 'string' || t.id.length === 0 || t.id.length > INBOUND_LIMITS.NOTE_ID)
      return false;
    for (const field of [t.src, t.predicate, t.dst]) {
      if (
        typeof field !== 'string' ||
        field.length === 0 ||
        field.length > INBOUND_LIMITS.GRAPH_STRING
      )
        return false;
    }
    for (const field of [t.src_type, t.dst_type, t.src_label, t.dst_label]) {
      if (
        field !== undefined &&
        (typeof field !== 'string' || field.length > INBOUND_LIMITS.GRAPH_STRING)
      )
        return false;
    }
    if (t.props !== undefined) {
      if (typeof t.props !== 'object' || t.props === null || Array.isArray(t.props)) return false;
      try {
        if (JSON.stringify(t.props).length > INBOUND_LIMITS.GRAPH_PROPS_BYTES) return false;
      } catch {
        return false;
      }
    }
    if (typeof t.updated_at !== 'number' || !Number.isFinite(t.updated_at)) return false;
  }
  return true;
}

function validClose(inner: InnerClose): boolean {
  if (typeof inner.closed_at !== 'number' || !Number.isFinite(inner.closed_at)) return false;
  if (inner.reason !== undefined && typeof inner.reason !== 'string') return false;
  return true;
}

function validGraphRetract(inner: InnerGraphRetract): boolean {
  if (
    !Array.isArray(inner.ids) ||
    inner.ids.length === 0 ||
    inner.ids.length > INBOUND_LIMITS.GRAPH_TRIPLE_COUNT
  ) {
    return false;
  }
  for (const id of inner.ids) {
    if (typeof id !== 'string' || id.length === 0 || id.length > INBOUND_LIMITS.NOTE_ID)
      return false;
  }
  if (typeof inner.retracted_at !== 'number' || !Number.isFinite(inner.retracted_at)) return false;
  return true;
}

/**
 * Key schedule summary:
 *   metaKey  = epoch-0 key derived from the root secret. Used for *meta*
 *              envelopes (hello, members, key_update, kick). Anyone with the
 *              ticket can derive it — that's the point: newcomers must be
 *              able to open hello/members/key_update *before* they learn
 *              the current epoch's sender key.
 *   msgKey   = current-epoch key used only for `msg` envelopes. Rotates on
 *              kick/leave via key_update.
 *
 * On decrypt we try msgKey first, then fall back to every key we remember
 * (current + meta + any prior epoch we've seen), so in-flight messages that
 * cross a rotation boundary still decode.
 */
export class Room extends EventEmitter {
  readonly id: Uint8Array;
  readonly idHex: string;
  readonly name: string;
  readonly rootSecret: Uint8Array;
  topic: string;

  epoch = 0;
  /** Map of epoch -> msg key. Epoch 0 is the meta key. */
  private readonly epochKeys: Map<number, Uint8Array> = new Map();

  members: Map<string, MemberInfo> = new Map();
  readonly creatorPubkey: Uint8Array;
  readonly bootstrap: Uint8Array[];
  admissionMode: AdmissionMode = 'open';
  /** Pending join requests (creator-only, approval-mode rooms). Keyed by base32(pubkey). */
  readonly pending: Map<string, PendingRequest> = new Map();
  /** Unix ms of the creator-signed close. Non-null ⇒ the room is frozen. */
  closedAt: number | null = null;

  constructor(
    init: RoomInit,
    private readonly identity: Identity,
    private readonly repo: Repo,
    private readonly broadcast: (env: Envelope) => void,
  ) {
    super();
    this.setMaxListeners(100);
    this.name = init.name;
    this.rootSecret = init.rootSecret;
    this.creatorPubkey = init.creatorPubkey;
    this.topic = init.topic || '';
    this.bootstrap = init.bootstrap || [];
    this.admissionMode = init.admissionMode || 'open';
    this.id = deriveRoomId(this.name, this.rootSecret);
    this.idHex = Buffer.from(this.id).toString('hex');
    this.epochKeys.set(0, this.deriveEpochKey(0, this.rootSecret));
  }

  /** Restore a persisted epoch key after reload. Epoch 0 is always derivable. */
  seedEpochKey(epoch: number, key: Uint8Array): void {
    this.epoch = Math.max(this.epoch, epoch);
    this.setEpochKey(epoch, key);
  }

  /** Install an epoch key, evicting the oldest non-zero entry if we'd exceed
   * the history cap. Epoch 0 (the meta key) is never evicted. */
  private setEpochKey(epoch: number, key: Uint8Array): void {
    this.epochKeys.set(epoch, key);
    while (this.epochKeys.size > INBOUND_LIMITS.EPOCH_KEY_HISTORY) {
      let oldest = Number.POSITIVE_INFINITY;
      for (const e of this.epochKeys.keys()) {
        if (e !== 0 && e !== this.epoch && e < oldest) oldest = e;
      }
      if (!Number.isFinite(oldest)) break;
      this.epochKeys.delete(oldest);
    }
  }

  /** Read-only views for external callers that previously touched internals. */
  get memberCount(): number {
    return this.members.size;
  }
  get pendingCount(): number {
    return this.pending.size;
  }
  isCreator(): boolean {
    return Buffer.compare(this.identity.publicKey, this.creatorPubkey) === 0;
  }
  /** Used by RoomManager to rehydrate members from the store on restart. */
  seedMember(info: MemberInfo): void {
    this.members.set(base32Encode(info.pubkey), info);
  }

  private deriveEpochKey(epoch: number, ikm: Uint8Array): Uint8Array {
    return hkdf(ikm, this.id, `agentchat v1 epoch ${epoch}`, 32);
  }

  private get metaKey(): Uint8Array {
    return this.epochKeys.get(0)!;
  }

  private get msgKey(): Uint8Array {
    return this.epochKeys.get(this.epoch)!;
  }

  /** Candidate keys for decryption, newest first, meta next, then any remembered priors. */
  private candidateKeys(): Uint8Array[] {
    const out: Uint8Array[] = [];
    const cur = this.epochKeys.get(this.epoch);
    if (cur) out.push(cur);
    if (this.epoch !== 0) out.push(this.metaKey);
    for (const [e, k] of this.epochKeys) {
      if (e !== 0 && e !== this.epoch) out.push(k);
    }
    return out;
  }

  get myPubkey(): Uint8Array {
    return this.identity.publicKey;
  }

  get myX25519Pub(): Uint8Array {
    return this.identity.x25519PublicKey;
  }

  toTicket(): string {
    return encodeTicket({
      roomName: this.name,
      rootSecret: this.rootSecret,
      bootstrapPubkeys: this.bootstrap.length > 0 ? this.bootstrap : [this.identity.publicKey],
    });
  }

  memberList(): MemberInfo[] {
    return [...this.members.values()].sort((a, b) => a.joined_at - b.joined_at);
  }

  /** Seed our own roster entry. Called once — at room creation by the creator
   * or at ticket-join time by a joiner. */
  initSelf(nickname: string, client = '', bio = ''): void {
    const me: MemberInfo = {
      pubkey: this.identity.publicKey,
      nickname,
      joined_at: Date.now(),
      x25519_pub: this.identity.x25519PublicKey,
      online: true,
      client,
      bio,
    };
    this.members.set(base32Encode(me.pubkey), me);
    this.persistMember(me);
    this.persistRoom();
  }

  /** Sends a hello to all peers (join handshake). */
  sendHello(nickname: string, client: string, version: string, bio = ''): void {
    const inner: InnerHello = {
      nickname,
      client,
      version,
      x25519_pub: this.identity.x25519PublicKey,
      ...(bio ? { bio } : {}),
    };
    const env = sealEnvelope(
      'hello',
      this.id,
      this.identity.publicKey,
      this.identity.privateKey,
      this.metaKey,
      inner,
    );
    this.broadcast(env);
    if (!this.members.has(base32Encode(this.identity.publicKey))) {
      this.initSelf(nickname, client, bio);
    } else {
      // refresh self-declared fields in case they changed
      const me = this.members.get(base32Encode(this.identity.publicKey))!;
      me.nickname = nickname;
      me.x25519_pub = this.identity.x25519PublicKey;
      me.bio = bio;
      this.persistMember(me);
    }
  }

  /** Gossip full member list (used after hello). */
  sendMembers(): void {
    const inner: InnerMembers = {
      epoch: this.epoch,
      members: this.memberList().map((m) => ({
        pubkey: m.pubkey,
        nickname: m.nickname,
        joined_at: m.joined_at,
        x25519_pub: m.x25519_pub,
      })),
    };
    const env = sealEnvelope(
      'members',
      this.id,
      this.identity.publicKey,
      this.identity.privateKey,
      this.metaKey,
      inner,
    );
    this.broadcast(env);
  }

  sendMessage(text: string, reply_to?: string): { id: string; ts: number } {
    if (this.closedAt) throw new Error('this room has been closed');
    const id = randomUUID();
    const inner: InnerMsg = { id, text, reply_to };
    const env = sealEnvelope(
      'msg',
      this.id,
      this.identity.publicKey,
      this.identity.privateKey,
      this.msgKey,
      inner,
    );
    this.broadcast(env);
    const me = this.members.get(base32Encode(this.identity.publicKey));
    const row = {
      id,
      room_id: this.idHex,
      sender: base32Encode(this.identity.publicKey),
      nickname: me?.nickname || '',
      text,
      ts: new Date(env.ts).toISOString(),
      reply_to: reply_to || null,
      signature: Buffer.from(env.sig).toString('hex'),
    };
    this.repo.insertMessage(row);
    this.emit('message', row);
    return { id, ts: env.ts };
  }

  kick(targetPubkey: Uint8Array, reason?: string): void {
    if (Buffer.compare(this.identity.publicKey, this.creatorPubkey) !== 0) {
      throw new Error('only the room creator can kick members');
    }
    const inner: InnerKick = { target_pubkey: targetPubkey, reason };
    const env = sealEnvelope(
      'kick',
      this.id,
      this.identity.publicKey,
      this.identity.privateKey,
      this.metaKey,
      inner,
    );
    this.broadcast(env);
    this.members.delete(base32Encode(targetPubkey));
    this.repo.removeMember(this.idHex, base32Encode(targetPubkey));
    this.rotateKey();
  }

  /** Creator-only: close the room for everyone. Broadcasts a signed close
   * envelope, persists the tombstone, and emits 'closed' locally. Peers
   * still connected at broadcast time will see the close envelope and
   * mark the room closed on their side. */
  closeRoom(reason?: string): void {
    if (Buffer.compare(this.identity.publicKey, this.creatorPubkey) !== 0) {
      throw new Error('only the room creator can close the room');
    }
    const closed_at = Date.now();
    const inner: InnerClose = { closed_at, reason };
    const env = sealEnvelope(
      'close',
      this.id,
      this.identity.publicKey,
      this.identity.privateKey,
      this.metaKey,
      inner,
    );
    this.broadcast(env);
    this.closedAt = closed_at;
    this.repo.markRoomClosed(this.idHex, closed_at);
    this.emit('closed', { closed_at, reason });
  }

  /** Rotate key. Mints a new sender key and seals it to every remaining member. */
  rotateKey(): void {
    const newSenderKey = randomKey();
    const newEpoch = this.epoch + 1;
    const shares: Record<string, Uint8Array> = {};
    for (const m of this.members.values()) {
      if (Buffer.compare(m.pubkey, this.identity.publicKey) === 0) continue;
      if (m.x25519_pub.length !== 32) continue; // skip members not yet re-handshaken after restart
      shares[base32Encode(m.pubkey)] = sealToX25519(m.x25519_pub, newSenderKey);
    }
    const inner: InnerKeyUpdate = { new_epoch: newEpoch, sender_key_shares: shares };
    const env = sealEnvelope(
      'key_update',
      this.id,
      this.identity.publicKey,
      this.identity.privateKey,
      this.metaKey,
      inner,
    );
    this.broadcast(env);
    this.epoch = newEpoch;
    this.setEpochKey(newEpoch, this.deriveEpochKey(newEpoch, newSenderKey));
    this.persistRoom();
  }

  /** Incoming envelope dispatcher. Returns true if accepted. */
  handleEnvelope(env: Envelope): boolean {
    if (Buffer.compare(env.room, this.id) !== 0) return false;
    if (Buffer.compare(env.from, this.identity.publicKey) === 0) return true;

    const keys = this.candidateKeys();

    switch (env.type) {
      case 'hello': {
        const inner = openEnvelope<InnerHello>(env, keys);
        if (!inner || !validHello(inner)) return false;
        const key = base32Encode(env.from);
        const existing = this.members.get(key);
        const amCreator = Buffer.compare(this.identity.publicKey, this.creatorPubkey) === 0;

        // Approval mode: if we're the creator and the sender is not yet a
        // member, stage them in the pending queue and emit an event for the UI.
        // They will NOT receive a current-epoch key until approved.
        if (amCreator && this.admissionMode === 'approval' && !existing) {
          if (!this.pending.has(key) && this.pending.size >= INBOUND_LIMITS.PENDING_REQUESTS) {
            return false;
          }
          const req: PendingRequest = {
            pubkey: env.from,
            x25519_pub: inner.x25519_pub,
            nickname: inner.nickname,
            client: inner.client,
            ts: env.ts,
          };
          this.pending.set(key, req);
          this.repo.upsertJoinRequest({
            room_id: this.idHex,
            pubkey: key,
            x25519_pub: base32Encode(inner.x25519_pub),
            nickname: inner.nickname,
            client: inner.client,
            ts: env.ts,
          });
          this.repo.touchContact(key, inner.nickname);
          this.emit('join_request', req);
          return true;
        }

        // Bound the roster. An open-admission room would otherwise accept
        // new hellos without limit from unique pubkeys.
        if (!existing && this.members.size >= INBOUND_LIMITS.ROOM_MEMBERS) return false;
        const prevNickname = existing?.nickname;
        const info: MemberInfo = {
          pubkey: env.from,
          nickname: inner.nickname,
          joined_at: existing?.joined_at ?? env.ts,
          x25519_pub: inner.x25519_pub,
          online: true,
          client: inner.client,
          bio: inner.bio || existing?.bio || '',
        };
        this.members.set(key, info);
        this.persistMember(info);
        this.repo.touchContact(key, inner.nickname);
        if (!existing) {
          this.emit('member_joined', info);
        } else if (prevNickname !== inner.nickname) {
          this.emit('nickname_changed', {
            pubkey: env.from,
            old_nickname: prevNickname,
            new_nickname: inner.nickname,
            info,
          });
        }

        // Only the creator replies with the authoritative members list and
        // catches up newcomers to the current epoch. Keeps handshake traffic O(n).
        if (amCreator) {
          this.sendMembers();
          if (this.epoch > 0) this.catchUpNewcomer(env.from, inner.x25519_pub);
        }
        return true;
      }
      case 'members': {
        // Only the creator gossips authoritative membership. Accepting it
        // from any ticket-holder lets a rogue peer flood the roster with
        // forged pubkeys (DoS) or mint UI-visible fake members. Same
        // reasoning as 'kick' and 'close'.
        if (Buffer.compare(env.from, this.creatorPubkey) !== 0) return false;
        const inner = openEnvelope<InnerMembers>(env, keys);
        if (!inner || !validMembers(inner)) return false;
        const myKey = base32Encode(this.identity.publicKey);
        for (const m of inner.members) {
          const key = base32Encode(m.pubkey);
          // Do not overwrite our own entry from gossip — we are authoritative
          // for our own nickname + x25519.
          if (key === myKey) continue;
          const existing = this.members.get(key);
          if (!existing && this.members.size >= INBOUND_LIMITS.ROOM_MEMBERS) continue;
          const info: MemberInfo = {
            pubkey: m.pubkey,
            nickname: m.nickname,
            joined_at: existing ? Math.min(existing.joined_at, m.joined_at) : m.joined_at,
            x25519_pub: m.x25519_pub,
            online: existing?.online ?? false,
            // Gossip doesn't carry client/bio — preserve whatever we already
            // learned from that peer's hello.
            client: existing?.client ?? '',
            bio: existing?.bio ?? '',
          };
          this.members.set(key, info);
          this.persistMember(info);
        }
        this.emit('members_update', this.memberList());
        return true;
      }
      case 'msg': {
        const inner = openEnvelope<InnerMsg>(env, keys);
        if (!inner || !validMsg(inner)) return false;
        const senderKey = base32Encode(env.from);
        const contact = this.repo.getContact(senderKey);
        if (contact?.muted) return true;
        const nickname = this.members.get(senderKey)?.nickname || contact?.nickname || '';
        const row = {
          id: inner.id,
          room_id: this.idHex,
          sender: senderKey,
          nickname,
          text: inner.text,
          ts: new Date(env.ts).toISOString(),
          reply_to: inner.reply_to || null,
          signature: Buffer.from(env.sig).toString('hex'),
        };
        this.repo.insertMessage(row);
        this.emit('message', row);
        return true;
      }
      case 'key_update': {
        const inner = openEnvelope<InnerKeyUpdate>(env, keys);
        if (!inner) return false;
        const share = inner.sender_key_shares[base32Encode(this.identity.publicKey)];
        if (!share) return true; // update not addressed to us
        const sharedKey = openSealedBox(
          this.identity.x25519PrivateKey,
          this.identity.x25519PublicKey,
          share,
        );
        if (!sharedKey) return false;
        this.epoch = inner.new_epoch;
        this.setEpochKey(inner.new_epoch, this.deriveEpochKey(inner.new_epoch, sharedKey));
        this.persistRoom();
        this.emit('key_rotated', this.epoch);
        return true;
      }
      case 'kick': {
        // Only the room creator's kick is authoritative. A signed+encrypted
        // envelope from any other member is a forgery attempt: any peer who
        // holds the current epoch key could otherwise evict anyone else.
        if (Buffer.compare(env.from, this.creatorPubkey) !== 0) return false;
        const inner = openEnvelope<InnerKick>(env, keys);
        if (!inner) return false;
        const key = base32Encode(inner.target_pubkey);
        this.members.delete(key);
        this.repo.removeMember(this.idHex, key);
        this.emit('member_kicked', inner.target_pubkey);
        if (Buffer.compare(inner.target_pubkey, this.identity.publicKey) === 0) {
          this.emit('self_kicked');
        }
        return true;
      }
      case 'close': {
        // Only the creator can close a room. The envelope is sealed with the
        // meta key (epoch 0) so late joiners with only the ticket can still
        // decode the tombstone. Non-creator 'close' envelopes are forgeries.
        if (Buffer.compare(env.from, this.creatorPubkey) !== 0) return false;
        const inner = openEnvelope<InnerClose>(env, [this.metaKey]);
        if (!inner || !validClose(inner)) return false;
        this.closedAt = inner.closed_at;
        this.repo.markRoomClosed(this.idHex, inner.closed_at);
        this.emit('closed', { closed_at: inner.closed_at, reason: inner.reason });
        return true;
      }
      case 'note_put': {
        const inner = openEnvelope<InnerNotePut>(env, keys);
        if (!inner || !validNotePut(inner)) return false;
        const changed = this.repo.applyNotePut({
          room_id: this.idHex,
          id: inner.id,
          author: base32Encode(env.from),
          title: inner.title,
          body: inner.body,
          tags: inner.tags,
          updated_at: inner.updated_at,
        });
        if (changed) this.emit('note_updated', { id: inner.id });
        return true;
      }
      case 'note_delete': {
        const inner = openEnvelope<InnerNoteDelete>(env, keys);
        if (!inner || !validNoteDelete(inner)) return false;
        const changed = this.repo.applyNoteDelete({
          room_id: this.idHex,
          id: inner.id,
          deleted_at: inner.deleted_at,
        });
        if (changed) this.emit('note_deleted', { id: inner.id });
        return true;
      }
      case 'graph_assert': {
        const inner = openEnvelope<InnerGraphAssert>(env, keys);
        if (!inner || !validGraphAssert(inner)) return false;
        const author = base32Encode(env.from);
        this.repo.applyGraphAssertBatch(
          inner.triples.map((t) => ({
            room_id: this.idHex,
            id: t.id,
            src: t.src,
            predicate: t.predicate,
            dst: t.dst,
            src_type: t.src_type || '',
            dst_type: t.dst_type || '',
            src_label: t.src_label || '',
            dst_label: t.dst_label || '',
            props: t.props || {},
            author,
            updated_at: t.updated_at,
          })),
        );
        this.emit('graph_updated', { asserted: inner.triples.map((t) => t.id) });
        return true;
      }
      case 'graph_retract': {
        const inner = openEnvelope<InnerGraphRetract>(env, keys);
        if (!inner || !validGraphRetract(inner)) return false;
        this.repo.applyGraphRetractBatch(this.idHex, inner.ids, inner.retracted_at);
        this.emit('graph_updated', { retracted: inner.ids });
        return true;
      }
      case 'ping':
      case 'pong':
        return true;
      default:
        return false;
    }
  }

  // ---- Notes ---------------------------------------------------------------

  putNote(input: { id?: string; title: string; body: string; tags?: string[] }): {
    id: string;
    updated_at: number;
  } {
    const id = input.id || randomUUID();
    const updated_at = Date.now();
    const tags = input.tags || [];
    const inner: InnerNotePut = { id, title: input.title, body: input.body, tags, updated_at };
    // persist locally first so the caller sees it immediately
    this.repo.applyNotePut({
      room_id: this.idHex,
      id,
      author: base32Encode(this.identity.publicKey),
      title: input.title,
      body: input.body,
      tags,
      updated_at,
    });
    const env = sealEnvelope(
      'note_put',
      this.id,
      this.identity.publicKey,
      this.identity.privateKey,
      this.msgKey,
      inner,
    );
    this.broadcast(env);
    this.emit('note_updated', { id });
    return { id, updated_at };
  }

  deleteNote(id: string): { id: string; deleted_at: number } {
    const deleted_at = Date.now();
    this.repo.applyNoteDelete({ room_id: this.idHex, id, deleted_at });
    const inner: InnerNoteDelete = { id, deleted_at };
    const env = sealEnvelope(
      'note_delete',
      this.id,
      this.identity.publicKey,
      this.identity.privateKey,
      this.msgKey,
      inner,
    );
    this.broadcast(env);
    this.emit('note_deleted', { id });
    return { id, deleted_at };
  }

  // ---- Graph ---------------------------------------------------------------

  assertTriples(
    triples: Array<
      Omit<import('./envelope.js').GraphTriple, 'id' | 'updated_at'> & {
        id?: string;
        updated_at?: number;
      }
    >,
  ): { ids: string[] } {
    const now = Date.now();
    const author = base32Encode(this.identity.publicKey);
    const full: import('./envelope.js').GraphTriple[] = triples.map((t) => ({
      id: t.id || randomUUID(),
      src: t.src,
      predicate: t.predicate,
      dst: t.dst,
      src_type: t.src_type,
      dst_type: t.dst_type,
      src_label: t.src_label,
      dst_label: t.dst_label,
      props: t.props,
      updated_at: t.updated_at ?? now,
    }));
    this.repo.applyGraphAssertBatch(
      full.map((t) => ({
        room_id: this.idHex,
        id: t.id,
        src: t.src,
        predicate: t.predicate,
        dst: t.dst,
        src_type: t.src_type || '',
        dst_type: t.dst_type || '',
        src_label: t.src_label || '',
        dst_label: t.dst_label || '',
        props: t.props || {},
        author,
        updated_at: t.updated_at,
      })),
    );
    const inner: InnerGraphAssert = { triples: full };
    const env = sealEnvelope(
      'graph_assert',
      this.id,
      this.identity.publicKey,
      this.identity.privateKey,
      this.msgKey,
      inner,
    );
    this.broadcast(env);
    this.emit('graph_updated', { asserted: full.map((t) => t.id) });
    return { ids: full.map((t) => t.id) };
  }

  retractTriples(ids: string[]): { ids: string[]; retracted_at: number } {
    const retracted_at = Date.now();
    this.repo.applyGraphRetractBatch(this.idHex, ids, retracted_at);
    const inner: InnerGraphRetract = { ids, retracted_at };
    const env = sealEnvelope(
      'graph_retract',
      this.id,
      this.identity.publicKey,
      this.identity.privateKey,
      this.msgKey,
      inner,
    );
    this.broadcast(env);
    this.emit('graph_updated', { retracted: ids });
    return { ids, retracted_at };
  }

  /** After a newcomer's hello, seal the current sender key to them so they can catch up. */
  private catchUpNewcomer(newcomerPub: Uint8Array, newcomerX25519: Uint8Array): void {
    // We re-mint a new epoch so we don't have to hold onto the raw sender key
    // that generated the current msgKey. Downsides: an epoch bump for every
    // fresh join after a rotation. Accepted.
    const newSenderKey = randomKey();
    const newEpoch = this.epoch + 1;
    const shares: Record<string, Uint8Array> = {};
    for (const m of this.members.values()) {
      if (Buffer.compare(m.pubkey, this.identity.publicKey) === 0) continue;
      const x25519 = Buffer.compare(m.pubkey, newcomerPub) === 0 ? newcomerX25519 : m.x25519_pub;
      if (x25519.length !== 32) continue;
      shares[base32Encode(m.pubkey)] = sealToX25519(x25519, newSenderKey);
    }
    const inner: InnerKeyUpdate = { new_epoch: newEpoch, sender_key_shares: shares };
    const env = sealEnvelope(
      'key_update',
      this.id,
      this.identity.publicKey,
      this.identity.privateKey,
      this.metaKey,
      inner,
    );
    this.broadcast(env);
    this.epoch = newEpoch;
    this.setEpochKey(newEpoch, this.deriveEpochKey(newEpoch, newSenderKey));
    this.persistRoom();
  }

  private persistRoom(): void {
    this.repo.upsertRoom({
      id: this.idHex,
      name: this.name,
      topic: this.topic,
      creator_pubkey: base32Encode(this.creatorPubkey),
      root_secret: base32Encode(this.rootSecret),
      epoch: this.epoch,
      current_key: base32Encode(this.msgKey),
      joined_at: new Date().toISOString(),
      left_at: null,
      admission_mode: this.admissionMode,
      closed_at: this.closedAt,
    });
  }

  setAdmissionMode(mode: AdmissionMode): void {
    this.admissionMode = mode;
    this.persistRoom();
  }

  /** Creator-only: approve a pending join request. */
  approveJoin(targetPubkey: Uint8Array): boolean {
    const key = base32Encode(targetPubkey);
    const req = this.pending.get(key);
    if (!req) return false;
    this.pending.delete(key);
    this.repo.removeJoinRequest(this.idHex, key);

    const info: MemberInfo = {
      pubkey: targetPubkey,
      nickname: req.nickname,
      joined_at: req.ts,
      x25519_pub: req.x25519_pub,
      online: true,
      client: req.client || '',
      bio: '',
    };
    this.members.set(key, info);
    this.persistMember(info);
    // catchUpNewcomer bumps the epoch and seals the new sender key to every
    // member including the newly-approved joiner.
    this.catchUpNewcomer(targetPubkey, req.x25519_pub);
    this.sendMembers();
    this.emit('member_joined', info);
    return true;
  }

  denyJoin(targetPubkey: Uint8Array): boolean {
    const key = base32Encode(targetPubkey);
    const had = this.pending.delete(key);
    this.repo.removeJoinRequest(this.idHex, key);
    if (had) this.emit('join_denied', targetPubkey);
    return had;
  }

  listPending(): PendingRequest[] {
    return [...this.pending.values()];
  }

  private persistMember(m: MemberInfo): void {
    this.repo.upsertMember({
      room_id: this.idHex,
      pubkey: base32Encode(m.pubkey),
      nickname: m.nickname,
      joined_at: new Date(m.joined_at).toISOString(),
      online: m.online ? 1 : 0,
      x25519_pub: base32Encode(m.x25519_pub),
      client: m.client || '',
      bio: m.bio || '',
    });
  }

  setTopic(topic: string): void {
    this.topic = topic;
    this.persistRoom();
  }
}
