import { EventEmitter } from 'node:events';
import type { Envelope } from './envelope.js';
import { FrameParser, decodeFrame, encodeFrame } from './frame.js';

export interface SwarmLike {
  join(topic: Buffer, opts?: { server?: boolean; client?: boolean }): any;
  leave(topic: Buffer): Promise<void>;
  destroy(): Promise<void>;
  on(event: 'connection', cb: (conn: any, info: any) => void): void;
}

// We lazy-load hyperswarm so unit tests don't trigger its DHT bootstrap.
let HyperswarmCtor: any = null;
async function getHyperswarm(): Promise<any> {
  if (HyperswarmCtor) return HyperswarmCtor;
  const mod = await import('hyperswarm');
  HyperswarmCtor = mod.default || mod;
  return HyperswarmCtor;
}

/**
 * Thin wrapper around hyperswarm that:
 *   - joins a 32-byte topic per room
 *   - on each connection, starts a length-prefixed CBOR framer
 *   - emits 'envelope' events addressed to the right room
 */
export interface SwarmOptions {
  /** Optional Hyperswarm bootstrap list for tests against a local DHT. */
  bootstrap?: Array<{ host: string; port: number }>;
}

export class Swarm extends EventEmitter {
  private swarm: SwarmLike | null = null;
  private connections: Set<any> = new Set();
  private parsers: Map<any, FrameParser> = new Map();
  private topics: Set<string> = new Set();
  private readonly opts: SwarmOptions;

  constructor(opts: SwarmOptions = {}) {
    super();
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.swarm) return;
    const Ctor = await getHyperswarm();
    this.swarm = new Ctor(
      this.opts.bootstrap ? { bootstrap: this.opts.bootstrap } : {},
    ) as SwarmLike;
    this.swarm.on('connection', (conn: any, info: any) => this.onConnection(conn, info));
  }

  async joinTopic(topic: Uint8Array): Promise<void> {
    if (!this.swarm) await this.start();
    const key = Buffer.from(topic).toString('hex');
    if (this.topics.has(key)) return;
    this.topics.add(key);
    const disc = this.swarm!.join(Buffer.from(topic), { server: true, client: true });
    if (disc && typeof disc.flushed === 'function') {
      await disc.flushed();
    }
  }

  async leaveTopic(topic: Uint8Array): Promise<void> {
    if (!this.swarm) return;
    const key = Buffer.from(topic).toString('hex');
    if (!this.topics.has(key)) return;
    this.topics.delete(key);
    await this.swarm.leave(Buffer.from(topic));
  }

  broadcast(env: Envelope): void {
    const frame = encodeFrame(env);
    for (const conn of this.connections) {
      try {
        conn.write(frame);
      } catch {
        // ignore broken connections
      }
    }
  }

  private onConnection(conn: any, info: any): void {
    this.connections.add(conn);
    const parser = new FrameParser();
    this.parsers.set(conn, parser);

    conn.on('data', (chunk: Buffer) => {
      try {
        const frames = parser.push(chunk);
        for (const f of frames) {
          const env = decodeFrame<Envelope>(f);
          this.emit('envelope', env, conn);
        }
      } catch (err) {
        this.emit('error', err);
      }
    });
    conn.on('error', () => {
      this.cleanupConnection(conn);
    });
    conn.on('close', () => {
      this.cleanupConnection(conn);
    });

    this.emit('connection', conn, info);
  }

  private cleanupConnection(conn: any): void {
    this.connections.delete(conn);
    this.parsers.delete(conn);
  }

  async destroy(): Promise<void> {
    if (!this.swarm) return;
    for (const conn of this.connections) {
      try {
        conn.destroy();
      } catch {
        /* ignore */
      }
    }
    await this.swarm.destroy();
    this.swarm = null;
  }
}
