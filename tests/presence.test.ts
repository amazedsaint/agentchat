/**
 * Tests for the presence-sync layer — the mechanism that surfaces sessions
 * from another machine running the same agentchat identity in the local
 * "My sessions" panel.
 *
 * Covered:
 *   - Topic + key derivation is deterministic from the private key.
 *   - Different private keys produce different topics/keys.
 *   - seal/open round-trips; tampered ciphertexts fail to open.
 *   - Two in-process managers on the same identity but different
 *     `machine_id`s converge: each side's `getRemoteSessions()` contains
 *     the OTHER machine's sessions, not its own.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Envelope } from '../src/p2p/envelope.js';
import { RoomManager } from '../src/p2p/manager.js';
import { derivePresenceParams, openPresence, sealPresence } from '../src/p2p/presence.js';
import { Swarm } from '../src/p2p/swarm.js';
import { makeIdentity, tmpDb } from './helpers.js';

describe('derivePresenceParams', () => {
  it('is deterministic from the private key', () => {
    const id = makeIdentity();
    const a = derivePresenceParams(id.privateKey);
    const b = derivePresenceParams(id.privateKey);
    expect(Buffer.from(a.topic).equals(Buffer.from(b.topic))).toBe(true);
    expect(Buffer.from(a.key).equals(Buffer.from(b.key))).toBe(true);
    expect(a.topic.length).toBe(32);
    expect(a.key.length).toBe(32);
  });

  it('different private keys produce different topics and keys', () => {
    const alice = makeIdentity();
    const bob = makeIdentity();
    const a = derivePresenceParams(alice.privateKey);
    const b = derivePresenceParams(bob.privateKey);
    expect(Buffer.from(a.topic).equals(Buffer.from(b.topic))).toBe(false);
    expect(Buffer.from(a.key).equals(Buffer.from(b.key))).toBe(false);
  });
});

describe('sealPresence / openPresence', () => {
  it('round-trips a payload', () => {
    const id = makeIdentity();
    const { key } = derivePresenceParams(id.privateKey);
    const payload = {
      v: 1 as const,
      machine_id: 'machine-A',
      ts: Date.now(),
      sessions: [
        {
          id: 's1',
          pid: 111,
          client: 'claude-code',
          kind: 'agent',
          cwd: '/tmp/demo',
          repo_name: '#acme/foo',
          repo_room_id: 'deadbeef',
          started_at: Date.now() - 1000,
          last_seen: Date.now(),
        },
      ],
    };
    const sealed = sealPresence(key, payload);
    const opened = openPresence(key, sealed);
    expect(opened).toEqual(payload);
  });

  it('fails to open with the wrong key', () => {
    const id1 = makeIdentity();
    const id2 = makeIdentity();
    const k1 = derivePresenceParams(id1.privateKey).key;
    const k2 = derivePresenceParams(id2.privateKey).key;
    const sealed = sealPresence(k1, {
      v: 1,
      machine_id: 'x',
      ts: 0,
      sessions: [],
    });
    expect(openPresence(k2, sealed)).toBeNull();
  });

  it('fails to open a truncated ciphertext', () => {
    const id = makeIdentity();
    const { key } = derivePresenceParams(id.privateKey);
    const sealed = sealPresence(key, { v: 1, machine_id: 'x', ts: 0, sessions: [] });
    expect(openPresence(key, sealed.subarray(0, 10))).toBeNull();
  });
});

/** In-memory swarm router copied from other integration tests — fans out
 * envelopes to every peer subscribed to the same topic. */
class SwarmNet extends EventEmitter {
  private byTopic = new Map<string, Set<TestSwarm>>();
  join(sw: TestSwarm, topic: Uint8Array): void {
    const k = Buffer.from(topic).toString('hex');
    let set = this.byTopic.get(k);
    if (!set) {
      set = new Set();
      this.byTopic.set(k, set);
    }
    set.add(sw);
    for (const other of set) {
      if (other !== sw) {
        other.emit('connection');
        sw.emit('connection');
      }
    }
  }
  deliver(origin: TestSwarm, env: Envelope): void {
    const k = Buffer.from(env.room).toString('hex');
    const set = this.byTopic.get(k);
    if (!set) return;
    for (const sw of set) {
      if (sw !== origin) setImmediate(() => sw.emit('envelope', env));
    }
  }
}
class TestSwarm extends Swarm {
  constructor(private readonly net: SwarmNet) {
    super();
  }
  override async start(): Promise<void> {}
  override async joinTopic(topic: Uint8Array): Promise<void> {
    this.net.join(this, topic);
  }
  override async leaveTopic(): Promise<void> {}
  override broadcast(env: Envelope): void {
    this.net.deliver(this, env);
  }
  override async destroy(): Promise<void> {}
}

describe('Cross-machine presence sync', () => {
  it('two machines on the same identity see each other\u2019s sessions', async () => {
    const net = new SwarmNet();
    const identity = makeIdentity(); // SAME identity on both "machines"
    const a = tmpDb();
    const b = tmpDb();

    // Seed each local sqlite with a session row so the broadcast has
    // something to announce.
    const now = Date.now();
    a.repo.upsertSession({
      id: 'sA-1',
      pid: 1001,
      client: 'claude-code',
      kind: 'agent',
      started_at: now,
      last_seen: now,
      cwd: '/home/me/foo',
      repo_name: '#acme/foo',
      repo_room_id: 'deadbeef',
    });
    b.repo.upsertSession({
      id: 'sB-1',
      pid: 2001,
      client: 'codex-cli',
      kind: 'agent',
      started_at: now,
      last_seen: now,
      cwd: '/home/me/bar',
      repo_name: '#acme/bar',
      repo_room_id: 'cafebabe',
    });

    const mgrA = new RoomManager({
      identity,
      repo: a.repo,
      nickname: 'me',
      clientName: 'test',
      version: '0',
      machineId: 'machine-A',
      swarm: new TestSwarm(net),
    });
    const mgrB = new RoomManager({
      identity,
      repo: b.repo,
      nickname: 'me',
      clientName: 'test',
      version: '0',
      machineId: 'machine-B',
      swarm: new TestSwarm(net),
    });

    try {
      await mgrA.start();
      await mgrB.start();
      // Let the initial broadcasts settle — each manager broadcasts once
      // synchronously at startup, then its peer receives asynchronously
      // via setImmediate in the SwarmNet.
      await new Promise((r) => setTimeout(r, 60));

      const aRemote = mgrA.getRemoteSessions();
      const bRemote = mgrB.getRemoteSessions();

      // A should see B's session (not its own) and vice versa.
      expect(aRemote.length).toBe(1);
      expect(aRemote[0].id).toBe('sB-1');
      expect(aRemote[0].machine_id).toBe('machine-B');
      expect(aRemote[0].repo_name).toBe('#acme/bar');

      expect(bRemote.length).toBe(1);
      expect(bRemote[0].id).toBe('sA-1');
      expect(bRemote[0].machine_id).toBe('machine-A');
    } finally {
      await mgrA.stop();
      await mgrB.stop();
      a.close();
      b.close();
    }
  });

  it('presence disabled when machineId is omitted', async () => {
    const net = new SwarmNet();
    const id = makeIdentity();
    const { repo, close } = tmpDb();
    const mgr = new RoomManager({
      identity: id,
      repo,
      nickname: 'me',
      clientName: 'test',
      version: '0',
      // no machineId → presence sync off
      swarm: new TestSwarm(net),
    });
    try {
      await mgr.start();
      expect(mgr.getRemoteSessions()).toEqual([]);
    } finally {
      await mgr.stop();
      close();
    }
  });
});
