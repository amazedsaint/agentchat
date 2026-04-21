/**
 * Cross-device presence sync.
 *
 * Each machine running the same agentchat identity derives the same
 * private-key-scoped DHT topic and AEAD key. Machines publish periodic
 * `presence` envelopes carrying their local session inventory; every
 * other machine on that identity receives, decrypts, and merges the
 * inventory into a local in-memory map keyed by `machine_id`.
 *
 * Security properties:
 *   - The topic itself is derivable only from the private key, so other
 *     peers on the DHT can't find it by guessing the public key.
 *   - Envelopes are Ed25519-signed (same wire format as normal messages)
 *     AND AEAD-sealed under a private-key-derived key. Even if the topic
 *     leaks, foreign listeners can't decrypt.
 *   - We never include the private key itself in any broadcast.
 */
import { decode as cborDecode, encode as cborEncode } from 'cbor-x';
import { aeadOpen, aeadSeal, blake3, concatBytes, hkdf, randomNonce } from './crypto.js';

export interface RemoteSession {
  id: string;
  pid: number;
  client: string;
  kind: 'agent' | 'human' | 'unknown' | string;
  cwd: string;
  repo_name: string;
  repo_room_id: string;
  started_at: number;
  last_seen: number;
  machine_id: string;
  /** A short, stable label for the machine. Derived client-side from the
   * machine_id — not a hostname (we don't want to leak hostnames on the
   * wire). */
  machine_label: string;
}

export interface PresencePayload {
  v: 1;
  machine_id: string;
  /** Unix ms of the snapshot. Receivers clamp skew to `now + 5min` the same
   * way LWW merges do. */
  ts: number;
  sessions: Array<{
    id: string;
    pid: number;
    client: string;
    kind: string;
    cwd: string;
    repo_name: string;
    repo_room_id: string;
    started_at: number;
    last_seen: number;
  }>;
}

const PRESENCE_LABEL_TOPIC = new TextEncoder().encode('agentchat v1 presence topic');
const PRESENCE_LABEL_SEED = new TextEncoder().encode('agentchat v1 presence seed');
const PRESENCE_LABEL_KEY_INFO = 'agentchat v1 presence key';

/**
 * Return `{ topic, key }`. Both are 32 bytes and deterministic from the
 * 32-byte Ed25519 seed (the private key we store). Only someone who holds
 * that seed can recover them.
 */
export function derivePresenceParams(privateKeySeed: Uint8Array): {
  topic: Uint8Array;
  key: Uint8Array;
} {
  const seed = hkdf(privateKeySeed, PRESENCE_LABEL_SEED, '', 32);
  const topic = blake3(concatBytes(PRESENCE_LABEL_TOPIC, seed), 32);
  const key = hkdf(seed, new Uint8Array(0), PRESENCE_LABEL_KEY_INFO, 32);
  return { topic, key };
}

/** Seal a payload for broadcast. Output is `nonce || ciphertext`. */
export function sealPresence(key: Uint8Array, payload: PresencePayload): Uint8Array {
  const nonce = randomNonce();
  const plaintext = cborEncode(payload);
  const ct = aeadSeal(key, nonce, plaintext);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

/** Inverse of `sealPresence`. Returns null on auth failure or bad CBOR. */
export function openPresence(key: Uint8Array, sealed: Uint8Array): PresencePayload | null {
  if (sealed.length < 24 + 16) return null; // nonce + poly1305 tag at minimum
  const nonce = sealed.subarray(0, 24);
  const ct = sealed.subarray(24);
  const pt = aeadOpen(key, nonce, ct);
  if (!pt) return null;
  try {
    const parsed = cborDecode(pt) as PresencePayload;
    if (!parsed || parsed.v !== 1 || typeof parsed.machine_id !== 'string') return null;
    if (!Array.isArray(parsed.sessions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Short, stable visual label from a machine_id so the UI can group
 * remote sessions without exposing hostnames. */
export function machineLabel(machineId: string): string {
  return machineId.slice(0, 8);
}
