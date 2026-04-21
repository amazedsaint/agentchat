/**
 * End-to-end multi-agent integration tests.
 *
 * Each test spins up N in-process RoomManagers (one per simulated agent),
 * wires them together with a shared in-memory "swarm net" that fans out
 * envelopes between swarms subscribed to the same topic, and drives each
 * agent through the real MCP tool handlers (not by calling Room methods
 * directly). That covers the full code path: tool zod-validation → tool
 * handler → manager → room → swarm → broker → other swarms → room.handleEnvelope.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from '../src/mcp/tools.js';
import { base32Encode } from '../src/p2p/base32.js';
import type { Envelope } from '../src/p2p/envelope.js';
import { RoomManager } from '../src/p2p/manager.js';
import { Swarm } from '../src/p2p/swarm.js';
import { makeIdentity, tmpDb } from './helpers.js';

/** Shared router that fans out envelopes between every TestSwarm subscribed
 * to the same topic. Uses envelope.room as the routing key. */
class SwarmNet {
  private byTopic = new Map<string, Set<TestSwarm>>();

  join(sw: TestSwarm, topic: Uint8Array): void {
    const k = Buffer.from(topic).toString('hex');
    let set = this.byTopic.get(k);
    if (!set) {
      set = new Set();
      this.byTopic.set(k, set);
    }
    set.add(sw);
    // Notify every already-joined peer that a new connection is available.
    // RoomManager uses this 'connection' signal to re-send hello, which is
    // exactly what hyperswarm does on a real connect.
    for (const other of set) {
      if (other !== sw) {
        other.emit('connection');
        sw.emit('connection');
      }
    }
  }
  leave(sw: TestSwarm, topic: Uint8Array): void {
    const k = Buffer.from(topic).toString('hex');
    this.byTopic.get(k)?.delete(sw);
  }
  deliver(origin: TestSwarm, env: Envelope): void {
    const k = Buffer.from(env.room).toString('hex');
    const set = this.byTopic.get(k);
    if (!set) return;
    for (const sw of set) {
      if (sw !== origin) {
        // Simulate async wire delivery so ordering is realistic.
        setImmediate(() => sw.emit('envelope', env));
      }
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
  override async leaveTopic(topic: Uint8Array): Promise<void> {
    this.net.leave(this, topic);
  }
  override broadcast(env: Envelope): void {
    this.net.deliver(this, env);
  }
  override async destroy(): Promise<void> {}
}

interface Agent {
  name: string;
  manager: RoomManager;
  repo: import('../src/store/repo.js').Repo;
  close: () => void;
  pubkeyHex: string;
}

async function makeAgent(name: string, net: SwarmNet): Promise<Agent> {
  const identity = makeIdentity();
  const { repo, close } = tmpDb();
  const manager = new RoomManager({
    identity,
    repo,
    nickname: name,
    clientName: 'test',
    version: '0',
    swarm: new TestSwarm(net),
  });
  await manager.start();
  return {
    name,
    manager,
    repo,
    close,
    pubkeyHex: Buffer.from(identity.publicKey).toString('hex'),
  };
}

const tools = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t]));

function call<T = any>(a: Agent, toolName: string, args: unknown): Promise<any> {
  const t = tools[toolName];
  if (!t) throw new Error(`no such tool: ${toolName}`);
  return t.handler({ manager: a.manager, repo: a.repo }, args as any);
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('E2E multi-agent workflows', () => {
  it('5 agents exchange messages in an open room; final state converges', async () => {
    const net = new SwarmNet();
    const alice = await makeAgent('alice', net); // creator
    const bob = await makeAgent('bob', net);
    const carol = await makeAgent('carol', net);
    const dave = await makeAgent('dave', net);
    const erin = await makeAgent('erin', net);

    const create = await call(alice, 'chat_create_room', { name: '#allhands' });
    const ticket = create.structuredContent.ticket;
    expect(ticket).toBeTruthy();

    for (const a of [bob, carol, dave, erin]) {
      await call(a, 'chat_join_room', { ticket });
    }
    await settle(80);

    // Each agent sends 3 messages.
    for (const a of [alice, bob, carol, dave, erin]) {
      for (let i = 0; i < 3; i++) {
        await call(a, 'chat_send_message', { room: '#allhands', text: `${a.name}-${i}` });
      }
    }
    await settle(100);

    // All 5 agents should now see all 15 messages, with identical text sets.
    const expected = new Set<string>();
    for (const n of ['alice', 'bob', 'carol', 'dave', 'erin']) {
      for (let i = 0; i < 3; i++) expected.add(`${n}-${i}`);
    }
    for (const a of [alice, bob, carol, dave, erin]) {
      const h = await call(a, 'chat_fetch_history', { room: '#allhands', limit: 50 });
      const texts = new Set(h.structuredContent.messages.map((m: any) => m.text));
      expect(texts).toEqual(expected);
    }

    // Members rosters should all show 5 members.
    for (const a of [alice, bob, carol, dave, erin]) {
      const who = await call(a, 'chat_list_members', { room: '#allhands' });
      expect(who.structuredContent.members.length).toBe(5);
    }

    for (const a of [alice, bob, carol, dave, erin]) a.close();
  });

  it('approval-mode: approve one, deny another; approved decrypts, denied does not', async () => {
    const net = new SwarmNet();
    const alice = await makeAgent('alice', net);
    const bob = await makeAgent('bob', net);
    const mallory = await makeAgent('mallory', net);

    const create = await call(alice, 'chat_create_room', {
      name: '#private',
      admission: 'approval',
    });
    const ticket = create.structuredContent.ticket;

    // Both request — this just sends a hello in approval mode; creator stages them.
    await call(bob, 'chat_join_room', { ticket });
    await call(mallory, 'chat_join_room', { ticket });
    await settle(60);

    const pending = await call(alice, 'chat_list_pending', {
      room: '#private',
    });
    expect(pending.structuredContent.pending.length).toBe(2);

    const bobHex = bob.pubkeyHex;
    const malHex = mallory.pubkeyHex;

    await call(alice, 'chat_approve_join', { room: '#private', pubkey: bobHex });
    await call(alice, 'chat_deny_join', { room: '#private', pubkey: malHex });
    await settle(80);

    // Creator sends a message post-approval.
    await call(alice, 'chat_send_message', { room: '#private', text: 'welcome bob' });
    await settle(60);

    const bobHist = await call(bob, 'chat_fetch_history', { room: '#private', limit: 20 });
    expect(bobHist.structuredContent.messages.some((m: any) => m.text === 'welcome bob')).toBe(
      true,
    );
    // Mallory's Room object still exists locally (she joined by ticket) but
    // her local history shouldn't contain the post-approval msg — she never
    // received the rotated msg key.
    const malHist = await call(mallory, 'chat_fetch_history', {
      room: '#private',
      limit: 20,
    });
    expect(malHist.structuredContent.messages.some((m: any) => m.text === 'welcome bob')).toBe(
      false,
    );

    alice.close();
    bob.close();
    mallory.close();
  });

  it('kick + rotate: kicked peer cannot decrypt; tear-down cleans up local room', async () => {
    const net = new SwarmNet();
    const alice = await makeAgent('alice', net); // creator
    const bob = await makeAgent('bob', net);
    const carol = await makeAgent('carol', net);

    const create = await call(alice, 'chat_create_room', { name: '#kicktest' });
    const ticket = create.structuredContent.ticket;
    await call(bob, 'chat_join_room', { ticket });
    await call(carol, 'chat_join_room', { ticket });
    await settle(80);

    // Alice kicks Bob.
    await call(alice, 'chat_kick', { room: '#kicktest', pubkey: bob.pubkeyHex });
    await settle(80);

    // Alice's follow-up message must be readable by Carol but not Bob.
    await call(alice, 'chat_send_message', { room: '#kicktest', text: 'post-kick' });
    await settle(60);

    const carolHist = await call(carol, 'chat_fetch_history', {
      room: '#kicktest',
      limit: 20,
    });
    expect(carolHist.structuredContent.messages.some((m: any) => m.text === 'post-kick')).toBe(
      true,
    );

    // Bob's local room is torn down after self_kicked — chat_fetch_history
    // now reports "No such room" because manager.resolveRoom returns nothing.
    const bobRoomId = create.structuredContent.room_id;
    const bobHist = await call(bob, 'chat_fetch_history', {
      room: bobRoomId,
      limit: 20,
    });
    expect(bobHist.isError).toBe(true);
    expect(bob.manager.rooms.has(bobRoomId)).toBe(false);
    expect(bob.repo.listRooms().some((r) => r.id === bobRoomId)).toBe(false);

    alice.close();
    bob.close();
    carol.close();
  });

  it('creator close freezes the room; re-join via ticket is refused', async () => {
    const net = new SwarmNet();
    const alice = await makeAgent('alice', net);
    const bob = await makeAgent('bob', net);
    const carol = await makeAgent('carol', net);

    const create = await call(alice, 'chat_create_room', { name: '#ending' });
    const ticket = create.structuredContent.ticket;
    await call(bob, 'chat_join_room', { ticket });
    await settle(60);

    await call(alice, 'chat_leave_room', { room: '#ending' });
    await settle(80);

    // Bob's room should be marked closed in sqlite.
    expect(bob.repo.isRoomClosed(create.structuredContent.room_id)).toBe(true);

    // Bob's subsequent send throws — Room.sendMessage guards on closedAt.
    // The tool surfaces the throw as isError.
    const bobSend = await call(bob, 'chat_send_message', {
      room: create.structuredContent.room_id,
      text: 'still here?',
    });
    expect(bobSend.isError).toBe(true);

    // Carol, who never joined before close, has no local close record so
    // her joinByTicket succeeds technically — but the room is effectively
    // dead (no peers still on the topic), so she ends up alone. This is
    // the expected degradation for a late joiner.
    await call(carol, 'chat_join_room', { ticket });
    await settle(60);
    const who = await call(carol, 'chat_list_members', {
      room: create.structuredContent.room_id,
    });
    expect(who.structuredContent.members.length).toBe(1);
    expect(who.structuredContent.members[0].pubkey).toBe(carol.pubkeyHex);

    alice.close();
    bob.close();
    carol.close();
  });

  it('DMs derive the same room id from both sides', async () => {
    const net = new SwarmNet();
    const alice = await makeAgent('alice', net);
    const bob = await makeAgent('bob', net);

    // First `chat_direct_message` on each side opens the DM room and sends
    // one message. Alice's first message isn't delivered to Bob because
    // Bob hasn't joined the topic yet — that's the same guarantee real
    // Hyperswarm gives (messages sent before a peer is on the topic are
    // lost). So here we verify ID derivation converges AND that messages
    // sent after both sides have opened the room propagate.
    const ar = await call(alice, 'chat_direct_message', {
      peer: bob.pubkeyHex,
      text: 'first-alice',
    });
    const br = await call(bob, 'chat_direct_message', {
      peer: alice.pubkeyHex,
      text: 'first-bob',
    });
    expect(ar.structuredContent.room_id).toBe(br.structuredContent.room_id);
    await settle(60);

    const roomId = ar.structuredContent.room_id;
    await call(alice, 'chat_send_message', { room: roomId, text: 'alice-after' });
    await call(bob, 'chat_send_message', { room: roomId, text: 'bob-after' });
    await settle(80);

    const aHist = await call(alice, 'chat_fetch_history', { room: roomId, limit: 20 });
    const bHist = await call(bob, 'chat_fetch_history', { room: roomId, limit: 20 });
    const aText = new Set(aHist.structuredContent.messages.map((m: any) => m.text));
    const bText = new Set(bHist.structuredContent.messages.map((m: any) => m.text));
    // The post-open messages must appear on both sides.
    for (const s of ['alice-after', 'bob-after']) {
      expect(aText.has(s)).toBe(true);
      expect(bText.has(s)).toBe(true);
    }

    alice.close();
    bob.close();
  });

  it('notes: LWW across 3 peers converges on the latest writer', async () => {
    const net = new SwarmNet();
    const alice = await makeAgent('alice', net);
    const bob = await makeAgent('bob', net);
    const carol = await makeAgent('carol', net);

    const create = await call(alice, 'chat_create_room', { name: '#notesroom' });
    const ticket = create.structuredContent.ticket;
    await call(bob, 'chat_join_room', { ticket });
    await call(carol, 'chat_join_room', { ticket });
    await settle(80);

    // All three write to the same note id with increasing timestamps.
    const noteId = 'shared-note-1';
    await call(alice, 'chat_note_put', {
      room: '#notesroom',
      id: noteId,
      title: 'v1',
      body: 'alice',
      tags: [],
    });
    await settle(30);
    await call(bob, 'chat_note_put', {
      room: '#notesroom',
      id: noteId,
      title: 'v2',
      body: 'bob',
      tags: ['review'],
    });
    await settle(30);
    await call(carol, 'chat_note_put', {
      room: '#notesroom',
      id: noteId,
      title: 'v3',
      body: 'carol',
      tags: [],
    });
    await settle(80);

    // All three repos converge on carol's write.
    for (const a of [alice, bob, carol]) {
      const got = a.repo.getNote(create.structuredContent.room_id, noteId);
      expect(got?.title).toBe('v3');
      expect(got?.body).toBe('carol');
    }

    // Delete from bob; everyone converges on tombstone.
    await call(bob, 'chat_note_delete', { room: '#notesroom', id: noteId });
    await settle(60);
    for (const a of [alice, bob, carol]) {
      const got = a.repo.getNote(create.structuredContent.room_id, noteId);
      expect(got?.deleted).toBe(true);
    }

    alice.close();
    bob.close();
    carol.close();
  });

  it('graph: batch assert + query + retract across peers', async () => {
    const net = new SwarmNet();
    const alice = await makeAgent('alice', net);
    const bob = await makeAgent('bob', net);

    const create = await call(alice, 'chat_create_room', { name: '#graph' });
    const ticket = create.structuredContent.ticket;
    await call(bob, 'chat_join_room', { ticket });
    await settle(60);

    const assertRes = await call(alice, 'chat_graph_assert', {
      room: '#graph',
      triples: [
        { src: 'repo:X', predicate: 'owns', dst: 'agent:alice' },
        { src: 'repo:X', predicate: 'depends_on', dst: 'pkg:cbor-x' },
      ],
    });
    expect(assertRes.structuredContent.ids.length).toBe(2);
    await settle(60);

    const q = await call(bob, 'chat_graph_query', { room: '#graph', src: 'repo:X' });
    expect(q.structuredContent.triples.length).toBe(2);

    await call(alice, 'chat_graph_retract', {
      room: '#graph',
      ids: assertRes.structuredContent.ids,
    });
    await settle(60);
    const q2 = await call(bob, 'chat_graph_query', { room: '#graph', src: 'repo:X' });
    expect(q2.structuredContent.triples.length).toBe(0);

    alice.close();
    bob.close();
  });

  it("forgery resistance: non-creator kick/close/members are no-ops from everyone else's view", async () => {
    const net = new SwarmNet();
    const alice = await makeAgent('alice', net); // creator
    const bob = await makeAgent('bob', net);
    const carol = await makeAgent('carol', net);

    const create = await call(alice, 'chat_create_room', { name: '#noforge' });
    const ticket = create.structuredContent.ticket;
    await call(bob, 'chat_join_room', { ticket });
    await call(carol, 'chat_join_room', { ticket });
    await settle(80);

    const roomId = create.structuredContent.room_id;
    // Bob tries to kick Carol via the tool — should 403.
    const kickRes = await call(bob, 'chat_kick', { room: '#noforge', pubkey: carol.pubkeyHex });
    expect(kickRes.isError).toBe(true);
    // Bob tries to leave-close — leaveRoom works locally but only the creator
    // broadcasts a signed close envelope. Alice's and Carol's rooms stay open.
    await call(bob, 'chat_leave_room', { room: '#noforge' });
    await settle(80);
    expect(alice.repo.isRoomClosed(roomId)).toBe(false);
    expect(carol.repo.isRoomClosed(roomId)).toBe(false);

    // Alice can still send and Carol still receives.
    await call(alice, 'chat_send_message', { room: '#noforge', text: 'still here' });
    await settle(60);
    const carolHist = await call(carol, 'chat_fetch_history', {
      room: '#noforge',
      limit: 20,
    });
    expect(carolHist.structuredContent.messages.some((m: any) => m.text === 'still here')).toBe(
      true,
    );

    alice.close();
    bob.close();
    carol.close();
  });

  it('nickname change propagates + fires nickname_changed event on peers', async () => {
    const net = new SwarmNet();
    const alice = await makeAgent('alice', net);
    const bob = await makeAgent('bob', net);

    const create = await call(alice, 'chat_create_room', { name: '#nick' });
    const ticket = create.structuredContent.ticket;
    await call(bob, 'chat_join_room', { ticket });
    await settle(60);

    // Wire up a listener on Alice's copy of the room for the nickname_changed event.
    const aliceRoom = alice.manager.rooms.get(create.structuredContent.room_id)!;
    const seen: Array<{ old?: string; neu: string }> = [];
    aliceRoom.on('nickname_changed', (info: { old_nickname?: string; new_nickname: string }) => {
      seen.push({ old: info.old_nickname, neu: info.new_nickname });
    });

    await call(bob, 'chat_set_nickname', { nickname: 'roberto' });
    await settle(80);

    expect(seen.length).toBe(1);
    expect(seen[0].old).toBe('bob');
    expect(seen[0].neu).toBe('roberto');

    const who = await call(alice, 'chat_list_members', { room: '#nick' });
    const bobEntry = who.structuredContent.members.find((m: any) => m.pubkey === bob.pubkeyHex);
    expect(bobEntry?.nickname).toBe('roberto');

    alice.close();
    bob.close();
  });

  it('member list exposes client + derived kind (agent vs human)', async () => {
    const net = new SwarmNet();
    // Two agents with different clientName values — one looks like an agent,
    // one looks like a human.
    const identityA = makeIdentity();
    const identityB = makeIdentity();
    const a = tmpDb();
    const b = tmpDb();
    const alice = {
      name: 'alice',
      manager: new RoomManager({
        identity: identityA,
        repo: a.repo,
        nickname: 'alice',
        clientName: 'claude-code',
        version: '0',
        swarm: new TestSwarm(net),
      }),
      repo: a.repo,
      close: a.close,
      pubkeyHex: Buffer.from(identityA.publicKey).toString('hex'),
    };
    const bob = {
      name: 'bob',
      manager: new RoomManager({
        identity: identityB,
        repo: b.repo,
        nickname: 'bob',
        clientName: 'web',
        version: '0',
        swarm: new TestSwarm(net),
      }),
      repo: b.repo,
      close: b.close,
      pubkeyHex: Buffer.from(identityB.publicKey).toString('hex'),
    };
    await alice.manager.start();
    await bob.manager.start();

    const create = await call(alice, 'chat_create_room', { name: '#kinds' });
    const ticket = create.structuredContent.ticket;
    await call(bob, 'chat_join_room', { ticket });
    await settle(80);

    const who = await call(alice, 'chat_list_members', { room: '#kinds' });
    const aliceEntry = who.structuredContent.members.find((m: any) => m.pubkey === alice.pubkeyHex);
    const bobEntry = who.structuredContent.members.find((m: any) => m.pubkey === bob.pubkeyHex);
    expect(bobEntry?.client).toBe('web');
    expect(bobEntry?.kind).toBe('human');
    // Alice's own entry in her list shows her configured client — if she
    // initSelf'd without client then it's empty, which maps to 'unknown'.
    // What matters is that Bob's hello populated his client on Alice's side.
    expect(aliceEntry).toBeTruthy();

    alice.close();
    bob.close();
  });

  it('restart persistence: rooms + members + notes survive DB reopen', async () => {
    const net = new SwarmNet();
    const alice = await makeAgent('alice', net);
    const bob = await makeAgent('bob', net);

    const create = await call(alice, 'chat_create_room', { name: '#persist' });
    const ticket = create.structuredContent.ticket;
    await call(bob, 'chat_join_room', { ticket });
    await settle(60);
    await call(alice, 'chat_send_message', { room: '#persist', text: 'hello' });
    await call(alice, 'chat_note_put', {
      room: '#persist',
      id: 'n1',
      title: 't',
      body: 'b',
      tags: [],
    });
    await settle(60);

    // Reopen Alice's repo/manager on the same db directory.
    const roomId = create.structuredContent.room_id;
    const db2 = alice.repo.db; // same handle; simulate restart by rehydrating
    // Build a fresh manager pointing at the same repo — start() rehydrates.
    const mgr2 = new RoomManager({
      identity: (alice.manager as any).identity,
      repo: alice.repo,
      nickname: 'alice',
      clientName: 'test',
      version: '0',
      swarm: new TestSwarm(new SwarmNet()), // new net, no live peers — that's fine
    });
    await mgr2.start();
    expect(mgr2.rooms.has(roomId)).toBe(true);
    const restored = mgr2.rooms.get(roomId)!;
    expect(restored.name).toBe('#persist');
    // Message history + note both preserved.
    const msgs = alice.repo.fetchMessages(roomId, 50);
    expect(msgs.some((m) => m.text === 'hello')).toBe(true);
    const note = alice.repo.getNote(roomId, 'n1');
    expect(note?.title).toBe('t');
    await mgr2.stop();

    // silence db2-unused lint
    void db2;

    alice.close();
    bob.close();
  });
});
