import { KeyObject, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { base32Decode, base32Encode } from './base32.js';
import { deriveX25519FromIdentity, edSign, generateIdentity } from './crypto.js';

export interface IdentityFile {
  version: 1;
  publicKey: string; // base32
  privateKey: string; // base32 (raw 32 seed)
  createdAt: string;
}

export interface Config {
  nickname: string;
  /** Short human-readable bio shown next to the nickname in room UIs. */
  bio?: string;
  /** Stable UUID for this install of agentchat, generated on first run.
   * Used by the presence-sync layer to distinguish multiple machines that
   * share the same Ed25519 identity. */
  machine_id?: string;
  http?: { port?: number; host?: string };
}

/** Max chars for a bio — enforced on the wire and in every UI. */
export const BIO_MAX = 200;

export class Identity {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
  readonly x25519PublicKey: Uint8Array;
  readonly x25519PrivateKey: KeyObject;
  readonly x25519PrivateRaw: Uint8Array;

  constructor(publicKey: Uint8Array, privateKey: Uint8Array) {
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    const x = deriveX25519FromIdentity(privateKey, publicKey);
    this.x25519PublicKey = x.publicKey;
    this.x25519PrivateKey = x.privateKey;
    this.x25519PrivateRaw = x.privateRaw;
  }

  get pubkeyBase32(): string {
    return base32Encode(this.publicKey);
  }

  sign(data: Uint8Array): Uint8Array {
    return edSign(this.privateKey, data);
  }
}

export function agentchatDir(): string {
  const dir = process.env.AGENTCHAT_HOME || join(homedir(), '.agentchat');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function identityPath(): string {
  return join(agentchatDir(), 'identity.json');
}

export function configPath(): string {
  return join(agentchatDir(), 'config.json');
}

export function loadOrCreateIdentity(): Identity {
  const path = identityPath();
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as IdentityFile;
    return new Identity(base32Decode(raw.publicKey), base32Decode(raw.privateKey));
  }
  const id = generateIdentity();
  const file: IdentityFile = {
    version: 1,
    publicKey: base32Encode(id.publicKey),
    privateKey: base32Encode(id.privateKey),
    createdAt: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(file, null, 2));
  chmodSync(path, 0o600);
  return new Identity(id.publicKey, id.privateKey);
}

export function loadConfig(): Config {
  const path = configPath();
  let cfg: Config;
  if (!existsSync(path)) {
    cfg = { nickname: 'agent' };
  } else {
    cfg = JSON.parse(readFileSync(path, 'utf8')) as Config;
  }
  // Ensure a stable machine_id on every load. The presence layer needs it
  // to distinguish this install from other machines running the same
  // identity, so we generate-and-persist the first time we see a config
  // file without one.
  if (!cfg.machine_id) {
    cfg.machine_id = randomUUID();
    writeFileSync(path, JSON.stringify(cfg, null, 2));
  }
  return cfg;
}

export function saveConfig(cfg: Config): void {
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

export function shortPubkey(pubkey: Uint8Array | string): string {
  const s = typeof pubkey === 'string' ? pubkey : base32Encode(pubkey);
  return s.slice(0, 8);
}
