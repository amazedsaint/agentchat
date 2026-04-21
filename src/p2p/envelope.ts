import { aeadOpen, aeadSeal, concatBytes, edSign, edVerify, randomNonce } from './crypto.js';

export type EnvelopeType =
  | 'hello'
  | 'members'
  | 'msg'
  | 'key_update'
  | 'kick'
  | 'close'
  | 'ping'
  | 'pong'
  | 'note_put'
  | 'note_delete'
  | 'graph_assert'
  | 'graph_retract';

export interface Envelope {
  v: 1;
  type: EnvelopeType;
  room: Uint8Array; // 32
  from: Uint8Array; // 32 (Ed25519 pubkey)
  ts: number; // unix ms
  nonce: Uint8Array; // 24
  payload: Uint8Array; // ciphertext
  sig: Uint8Array; // 64
}

export interface InnerHello {
  nickname: string;
  client: string;
  version: string;
  x25519_pub: Uint8Array;
  /** Optional short bio. Additive — older clients ignore unknown fields. */
  bio?: string;
}

export interface InnerMembers {
  members: Array<{
    pubkey: Uint8Array;
    nickname: string;
    joined_at: number;
    x25519_pub: Uint8Array;
  }>;
  epoch: number;
}

export interface InnerMsg {
  id: string;
  text: string;
  reply_to?: string;
}

export interface InnerKeyUpdate {
  new_epoch: number;
  sender_key_shares: Record<string, Uint8Array>; // base32 ed25519 pubkey -> sealed box
}

export interface InnerKick {
  target_pubkey: Uint8Array;
  reason?: string;
}

export interface InnerClose {
  closed_at: number;
  reason?: string;
}

export interface InnerNotePut {
  id: string; // UUID, stable across edits
  title: string;
  body: string;
  tags: string[];
  updated_at: number; // unix ms (LWW key)
}

export interface InnerNoteDelete {
  id: string;
  deleted_at: number;
}

export interface GraphTriple {
  id: string; // stable per-triple id
  src: string; // entity id
  predicate: string;
  dst: string; // entity id
  src_type?: string;
  dst_type?: string;
  src_label?: string;
  dst_label?: string;
  props?: Record<string, unknown>;
  updated_at: number;
}

export interface InnerGraphAssert {
  triples: GraphTriple[];
}

export interface InnerGraphRetract {
  ids: string[];
  retracted_at: number;
}

export type Inner =
  | InnerHello
  | InnerMembers
  | InnerMsg
  | InnerKeyUpdate
  | InnerKick
  | InnerClose
  | InnerNotePut
  | InnerNoteDelete
  | InnerGraphAssert
  | InnerGraphRetract
  | Record<string, never>;

function signPayload(
  v: number,
  type: EnvelopeType,
  room: Uint8Array,
  from: Uint8Array,
  ts: number,
  nonce: Uint8Array,
  payload: Uint8Array,
): Uint8Array {
  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigInt64BE(BigInt(ts), 0);
  return concatBytes(
    new Uint8Array([v]),
    new TextEncoder().encode(type),
    room,
    from,
    new Uint8Array(tsBuf),
    nonce,
    payload,
  );
}

export function sealEnvelope(
  type: EnvelopeType,
  room: Uint8Array,
  fromPubkey: Uint8Array,
  fromPrivkey: Uint8Array,
  roomKey: Uint8Array,
  inner: Inner,
): Envelope {
  const ts = Date.now();
  const nonce = randomNonce();
  const innerBytes = new TextEncoder().encode(
    JSON.stringify(inner, (_k, v) => {
      if (v instanceof Uint8Array) return { __b: Buffer.from(v).toString('base64') };
      return v;
    }),
  );
  const payload = aeadSeal(roomKey, nonce, innerBytes, room);
  const toSign = signPayload(1, type, room, fromPubkey, ts, nonce, payload);
  const sig = edSign(fromPrivkey, toSign);
  return { v: 1, type, room, from: fromPubkey, ts, nonce, payload, sig };
}

export function openEnvelope<T = Inner>(
  env: Envelope,
  roomKeys: Uint8Array | Uint8Array[],
): T | null {
  const toSign = signPayload(env.v, env.type, env.room, env.from, env.ts, env.nonce, env.payload);
  if (!edVerify(env.from, toSign, env.sig)) return null;
  const keys = Array.isArray(roomKeys) ? roomKeys : [roomKeys];
  for (const key of keys) {
    const pt = aeadOpen(key, env.nonce, env.payload, env.room);
    if (!pt) continue;
    try {
      return JSON.parse(new TextDecoder().decode(pt), (_k, v) => {
        if (v && typeof v === 'object' && '__b' in v)
          return new Uint8Array(Buffer.from((v as any).__b, 'base64'));
        return v;
      }) as T;
    } catch {
      return null;
    }
  }
  return null;
}

export function verifyEnvelopeSignature(env: Envelope): boolean {
  const toSign = signPayload(env.v, env.type, env.room, env.from, env.ts, env.nonce, env.payload);
  return edVerify(env.from, toSign, env.sig);
}
