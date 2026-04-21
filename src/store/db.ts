import { join } from 'node:path';
import Database from 'better-sqlite3';
import { agentchatDir } from '../p2p/identity.js';

export type DB = Database.Database;

export function openDatabase(path?: string): DB {
  const dbPath = path || join(agentchatDir(), 'store.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,            -- hex room_id
      name TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT '',
      creator_pubkey TEXT NOT NULL,
      root_secret TEXT NOT NULL,      -- base32 of 32B secret
      epoch INTEGER NOT NULL DEFAULT 0,
      current_key TEXT NOT NULL,      -- base32 of current 32B key
      joined_at TEXT NOT NULL,
      left_at TEXT
    );

    CREATE TABLE IF NOT EXISTS members (
      room_id TEXT NOT NULL,
      pubkey TEXT NOT NULL,
      nickname TEXT NOT NULL DEFAULT '',
      joined_at TEXT NOT NULL,
      online INTEGER NOT NULL DEFAULT 0,
      x25519_pub TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (room_id, pubkey)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      nickname TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      ts TEXT NOT NULL,
      reply_to TEXT,
      signature TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages(room_id, ts);

    CREATE TABLE IF NOT EXISTS contacts (
      pubkey TEXT PRIMARY KEY,
      nickname TEXT NOT NULL DEFAULT '',
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      muted INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );

    -- Active local sessions — one row per running agentchat process
    -- (stdio MCP, HTTP MCP, web sidecar, TUI). All share the same identity
    -- (rows represent the same human, just different frontends/agents).
    -- Rows are removed on graceful shutdown and GC'd when last_seen is
    -- older than 5 × heartbeat_interval.
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,            -- random UUID, generated per process
      pid INTEGER NOT NULL,
      client TEXT NOT NULL,           -- e.g. "claude-code", "codex-cli", "web", "tui"
      kind TEXT NOT NULL DEFAULT '',  -- "agent" | "human" | "unknown"
      started_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen);

    -- Shared notes (markdown). LWW on (updated_at, author) — ties broken by
    -- lexicographic author pubkey so every peer resolves identically.
    -- deleted=1 with deleted_at acts as a tombstone; replays with older
    -- updated_at are rejected after a tombstone lands.
    CREATE TABLE IF NOT EXISTS notes (
      room_id TEXT NOT NULL,
      id TEXT NOT NULL,
      author TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER,
      PRIMARY KEY (room_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_notes_room_updated ON notes(room_id, updated_at);

    -- Knowledge graph: nodes are derived on-demand from edges (we store label
    -- + type hints on edges). Edges are the authoritative unit.
    CREATE TABLE IF NOT EXISTS graph_edges (
      room_id TEXT NOT NULL,
      id TEXT NOT NULL,
      src TEXT NOT NULL,
      predicate TEXT NOT NULL,
      dst TEXT NOT NULL,
      src_type TEXT NOT NULL DEFAULT '',
      dst_type TEXT NOT NULL DEFAULT '',
      src_label TEXT NOT NULL DEFAULT '',
      dst_label TEXT NOT NULL DEFAULT '',
      props TEXT NOT NULL DEFAULT '{}',
      author TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      retracted INTEGER NOT NULL DEFAULT 0,
      retracted_at INTEGER,
      PRIMARY KEY (room_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_edges_src ON graph_edges(room_id, src);
    CREATE INDEX IF NOT EXISTS idx_edges_dst ON graph_edges(room_id, dst);
    CREATE INDEX IF NOT EXISTS idx_edges_predicate ON graph_edges(room_id, predicate);
  `);

  // Additive migrations. Each protected by a PRAGMA table_info check because
  // sqlite's ADD COLUMN is irreversible and we can't wrap it in "IF NOT EXISTS".
  const memberCols = db.prepare('PRAGMA table_info(members)').all() as Array<{ name: string }>;
  if (!memberCols.some((c) => c.name === 'x25519_pub')) {
    db.exec("ALTER TABLE members ADD COLUMN x25519_pub TEXT NOT NULL DEFAULT ''");
  }
  if (!memberCols.some((c) => c.name === 'client')) {
    db.exec("ALTER TABLE members ADD COLUMN client TEXT NOT NULL DEFAULT ''");
  }
  if (!memberCols.some((c) => c.name === 'bio')) {
    db.exec("ALTER TABLE members ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
  }
  const roomCols = db.prepare('PRAGMA table_info(rooms)').all() as Array<{ name: string }>;
  if (!roomCols.some((c) => c.name === 'admission_mode')) {
    db.exec("ALTER TABLE rooms ADD COLUMN admission_mode TEXT NOT NULL DEFAULT 'open'");
  }
  if (!roomCols.some((c) => c.name === 'closed_at')) {
    db.exec('ALTER TABLE rooms ADD COLUMN closed_at INTEGER');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS join_requests (
      room_id TEXT NOT NULL,
      pubkey TEXT NOT NULL,
      x25519_pub TEXT NOT NULL,
      nickname TEXT NOT NULL DEFAULT '',
      client TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL,
      PRIMARY KEY (room_id, pubkey)
    );
  `);
}
