/**
 * Real-Hyperswarm integration test.
 *
 * Unlike tests/e2e-multi-agent.test.ts which routes envelopes through an
 * in-memory broker, this file stands up a local hyperdht testnet and two
 * real Swarm instances that discover each other via DHT, establish a Noise
 * connection, and exchange CBOR frames. It's the one place in the test
 * suite where the actual wire stack is exercised; bugs in Swarm,
 * FrameParser, or the connection handshake surface here rather than in
 * the mocked-broker tests.
 *
 * Cost: creating a testnet + two swarms + discovering each other takes
 * ~2–5s, so these tests carry a higher timeout than the rest of the suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoomManager } from '../src/p2p/manager.js';
import { Swarm } from '../src/p2p/swarm.js';
import { makeIdentity, tmpDb } from './helpers.js';

// Dynamic import so the suite doesn't pay for hyperdht unless this file runs.
async function bootTestnet(size = 3): Promise<{
  bootstrap: Array<{ host: string; port: number }>;
  destroy: () => Promise<void>;
}> {
  // @ts-expect-error — hyperdht has no types in this repo
  const createTestnet = (await import('hyperdht/testnet.js')).default;
  const testnet = await createTestnet(size);
  return { bootstrap: testnet.bootstrap, destroy: () => testnet.destroy() };
}

async function waitFor<T>(
  predicate: () => T | undefined,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v !== undefined && v !== null && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('E2E real Hyperswarm', () => {
  let testnet: Awaited<ReturnType<typeof bootTestnet>>;

  beforeAll(async () => {
    testnet = await bootTestnet(3);
  }, 20_000);

  afterAll(async () => {
    await testnet.destroy();
  });

  it('two managers discover each other via DHT and exchange messages', async () => {
    const alice = makeIdentity();
    const bob = makeIdentity();
    const a = tmpDb();
    const b = tmpDb();

    const aMgr = new RoomManager({
      identity: alice,
      repo: a.repo,
      nickname: 'alice',
      clientName: 'test-swarm',
      version: '0',
      swarm: new Swarm({ bootstrap: testnet.bootstrap }),
    });
    const bMgr = new RoomManager({
      identity: bob,
      repo: b.repo,
      nickname: 'bob',
      clientName: 'test-swarm',
      version: '0',
      swarm: new Swarm({ bootstrap: testnet.bootstrap }),
    });

    try {
      await aMgr.start();
      await bMgr.start();

      const aliceRoom = await aMgr.createRoom('#swarm-test');
      const ticket = aliceRoom.toTicket();
      const bobRoom = await bMgr.joinByTicket(ticket);

      // Peer discovery + noise handshake happens asynchronously. Both sides
      // call sendHello on every new connection, so membership converges
      // once DHT lookup + dial complete.
      await waitFor(() => aliceRoom.members.size === 2 && bobRoom.members.size === 2, {
        timeoutMs: 15_000,
      });

      // Round-trip a couple of messages both directions.
      aliceRoom.sendMessage('hello from alice');
      bobRoom.sendMessage('hi alice, bob here');

      await waitFor(
        () => {
          const aMsgs = a.repo.fetchMessages(aliceRoom.idHex, 20).map((m) => m.text);
          const bMsgs = b.repo.fetchMessages(bobRoom.idHex, 20).map((m) => m.text);
          return (
            aMsgs.includes('hello from alice') &&
            aMsgs.includes('hi alice, bob here') &&
            bMsgs.includes('hello from alice') &&
            bMsgs.includes('hi alice, bob here')
          );
        },
        { timeoutMs: 10_000 },
      );

      const aMsgs = a.repo
        .fetchMessages(aliceRoom.idHex, 20)
        .map((m) => m.text)
        .sort();
      const bMsgs = b.repo
        .fetchMessages(bobRoom.idHex, 20)
        .map((m) => m.text)
        .sort();
      expect(aMsgs).toEqual(bMsgs);
    } finally {
      await aMgr.stop();
      await bMgr.stop();
      a.close();
      b.close();
    }
  }, 45_000);

  it('late joiner after rotation catches up via creator-issued key_update', async () => {
    // Stresses the trickiest crypto path: Alice creates the room, Bob joins
    // and triggers a rotation by being kicked, then Carol joins with only
    // the ticket (i.e. epoch-0 meta key). Carol must receive the current
    // epoch's msgKey sealed to her x25519 pub, then decrypt a fresh msg.
    const alice = makeIdentity();
    const bob = makeIdentity();
    const carol = makeIdentity();
    const a = tmpDb();
    const b = tmpDb();
    const c = tmpDb();

    const aMgr = new RoomManager({
      identity: alice,
      repo: a.repo,
      nickname: 'alice',
      clientName: 'test-swarm',
      version: '0',
      swarm: new Swarm({ bootstrap: testnet.bootstrap }),
    });
    const bMgr = new RoomManager({
      identity: bob,
      repo: b.repo,
      nickname: 'bob',
      clientName: 'test-swarm',
      version: '0',
      swarm: new Swarm({ bootstrap: testnet.bootstrap }),
    });
    const cMgr = new RoomManager({
      identity: carol,
      repo: c.repo,
      nickname: 'carol',
      clientName: 'test-swarm',
      version: '0',
      swarm: new Swarm({ bootstrap: testnet.bootstrap }),
    });

    try {
      await aMgr.start();
      await bMgr.start();
      const aliceRoom = await aMgr.createRoom('#swarm-late-join');
      const ticket = aliceRoom.toTicket();
      const bobRoom = await bMgr.joinByTicket(ticket);
      await waitFor(() => aliceRoom.members.size === 2 && bobRoom.members.size === 2, {
        timeoutMs: 15_000,
      });

      // Rotate: kick Bob. Epoch advances past 0.
      aliceRoom.kick(bob.publicKey);
      await waitFor(() => aliceRoom.epoch > 0, { timeoutMs: 5_000 });

      // Now Carol joins with only the ticket — she starts at epoch 0.
      await cMgr.start();
      const carolRoom = await cMgr.joinByTicket(ticket);
      await waitFor(() => carolRoom.epoch > 0 && aliceRoom.members.size === 2, {
        timeoutMs: 15_000,
      });

      // Alice sends a post-rotation message; Carol must decrypt it.
      aliceRoom.sendMessage('welcome late-joiner');
      await waitFor(
        () =>
          c.repo.fetchMessages(carolRoom.idHex, 20).some((m) => m.text === 'welcome late-joiner'),
        { timeoutMs: 10_000 },
      );
    } finally {
      await aMgr.stop();
      await bMgr.stop();
      await cMgr.stop();
      a.close();
      b.close();
      c.close();
    }
  }, 60_000);

  it('burst of 100 messages between 2 peers — all arrive in order', async () => {
    const alice = makeIdentity();
    const bob = makeIdentity();
    const a = tmpDb();
    const b = tmpDb();
    const aMgr = new RoomManager({
      identity: alice,
      repo: a.repo,
      nickname: 'alice',
      clientName: 'test-swarm',
      version: '0',
      swarm: new Swarm({ bootstrap: testnet.bootstrap }),
    });
    const bMgr = new RoomManager({
      identity: bob,
      repo: b.repo,
      nickname: 'bob',
      clientName: 'test-swarm',
      version: '0',
      swarm: new Swarm({ bootstrap: testnet.bootstrap }),
    });
    try {
      await aMgr.start();
      await bMgr.start();
      const aRoom = await aMgr.createRoom('#burst');
      const bRoom = await bMgr.joinByTicket(aRoom.toTicket());
      await waitFor(() => aRoom.members.size === 2 && bRoom.members.size === 2, {
        timeoutMs: 15_000,
      });

      const N = 100;
      for (let i = 0; i < N; i++) aRoom.sendMessage(`burst-${i}`);

      await waitFor(() => b.repo.fetchMessages(bRoom.idHex, N + 10).length >= N, {
        timeoutMs: 20_000,
      });

      const bMsgs = b.repo.fetchMessages(bRoom.idHex, N + 10);
      const texts = bMsgs.map((m) => m.text).filter((t) => t.startsWith('burst-'));
      expect(texts.length).toBe(N);
      // Messages are ordered by ts ASC (fetchMessages reverses DESC). On a
      // single sender they should preserve send order.
      for (let i = 0; i < N; i++) expect(texts[i]).toBe(`burst-${i}`);
    } finally {
      await aMgr.stop();
      await bMgr.stop();
      a.close();
      b.close();
    }
  }, 60_000);

  it('kick + key rotation across the real swarm: kicked peer cannot decrypt', async () => {
    const alice = makeIdentity();
    const bob = makeIdentity();
    const carol = makeIdentity();
    const a = tmpDb();
    const b = tmpDb();
    const c = tmpDb();

    const aMgr = new RoomManager({
      identity: alice,
      repo: a.repo,
      nickname: 'alice',
      clientName: 'test-swarm',
      version: '0',
      swarm: new Swarm({ bootstrap: testnet.bootstrap }),
    });
    const bMgr = new RoomManager({
      identity: bob,
      repo: b.repo,
      nickname: 'bob',
      clientName: 'test-swarm',
      version: '0',
      swarm: new Swarm({ bootstrap: testnet.bootstrap }),
    });
    const cMgr = new RoomManager({
      identity: carol,
      repo: c.repo,
      nickname: 'carol',
      clientName: 'test-swarm',
      version: '0',
      swarm: new Swarm({ bootstrap: testnet.bootstrap }),
    });

    try {
      await aMgr.start();
      await bMgr.start();
      await cMgr.start();

      const aliceRoom = await aMgr.createRoom('#swarm-kick');
      const ticket = aliceRoom.toTicket();
      const bobRoom = await bMgr.joinByTicket(ticket);
      const carolRoom = await cMgr.joinByTicket(ticket);

      await waitFor(
        () =>
          aliceRoom.members.size === 3 &&
          bobRoom.members.size === 3 &&
          carolRoom.members.size === 3,
        { timeoutMs: 15_000 },
      );

      // Alice kicks Bob, rotates key to a new epoch that excludes Bob's share.
      aliceRoom.kick(bob.publicKey);
      await waitFor(() => aliceRoom.epoch > 0, { timeoutMs: 5_000 });

      aliceRoom.sendMessage('private-after-kick');

      // Carol (still a member) decodes and stores the post-kick message.
      await waitFor(
        () =>
          c.repo.fetchMessages(carolRoom.idHex, 20).some((m) => m.text === 'private-after-kick'),
        { timeoutMs: 10_000 },
      );

      // Bob (kicked) does NOT have the message. Give the wire a moment to
      // settle so we're not racing an in-flight delivery.
      await new Promise((r) => setTimeout(r, 500));
      const bobMsgs = b.repo.fetchMessages(bobRoom.idHex, 20).map((m) => m.text);
      expect(bobMsgs.includes('private-after-kick')).toBe(false);
    } finally {
      await aMgr.stop();
      await bMgr.stop();
      await cMgr.stop();
      a.close();
      b.close();
      c.close();
    }
  }, 60_000);
});
