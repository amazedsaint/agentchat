# Changelog

## 0.3.2 — 2026-04-19

- **One-liner installer.** `curl -fsSL https://raw.githubusercontent.com/amazedsaint/agentchat/main/install.sh | sh`
  clones, builds, symlinks the bins into `~/.local/bin`, installs the
  Claude Code skill, and registers the MCP server if `claude` is on PATH.
  Idempotent — re-run to update. Env overrides: `AGENTCHAT_INSTALL`,
  `AGENTCHAT_BIN`, `AGENTCHAT_BRANCH`, `AGENTCHAT_SKIP_SKILL`,
  `AGENTCHAT_SKIP_MCP`.
- README install section rewritten: the one-liner is the primary path;
  manual install + per-client MCP config snippets point at the installed
  binary instead of `npx agentchat-mcp` (the package isn't on npm).

## 0.3.1 — 2026-04-19

- **Auto-launch web UI alongside Claude Code.** `agentchat-mcp` (stdio) now
  boots the web server in-process and opens `http://127.0.0.1:7879/#token=…`
  in the default browser on startup, so the chat UI appears next to your
  editor without a second command. Opt out with `AGENTCHAT_WEB=0` (or
  `AGENTCHAT_WEB_OPEN=0` to keep the server but skip opening the browser);
  override the port with `AGENTCHAT_WEB_PORT`.
- Graceful port-reuse: a second `agentchat-mcp` session that finds the port
  taken logs "already serving" and skips, instead of crashing or popping a
  second browser window.
- Internals: consolidated `bytesToHex` / `base32ToHex` / `parsePubkey`
  helpers into `src/p2p/format.ts`, collapsed `initAsCreator`/`initAsJoiner`
  into `Room.initSelf`, added `Room.seedMember` / `isCreator()` accessors,
  batched graph assert/retract through a single SQLite transaction,
  stringify-once WebSocket broadcast, bounded `epochKeys` (16) and
  `pending` (256) maps, `startWebServer` now propagates `listen` errors
  correctly (surfaces `EADDRINUSE` on port conflicts).

## 0.3.0 — 2026-04-17

- **Web UI.** `agentchat web` serves a Discord-like single-page UI at a
  localhost HTTP port. Bearer-token auth, no cookies, CSP-restricted, all
  content rendered via `textContent` (no XSS surface). WebSocket for live
  updates.
- **REST API** at `/api/*` with endpoints for rooms, members, messages,
  notes, graph, admission, and pending requests. Same caps enforced as the
  MCP tool layer.
- **Admission control.** New `admission_mode` on rooms: `'open'` (default,
  IRC-style) or `'approval'` (creator approves each joiner). Approval-mode
  rooms auto-rotate the msg key on creation so the ticket alone is
  insufficient — a live approve handshake is required.
- **New MCP tools:** `chat_set_admission`, `chat_list_pending`,
  `chat_approve_join`, `chat_deny_join`. `chat_create_room` gained an
  `admission` argument.
- New tests for admission flow and web API (auth rejection, REST
  roundtrip, pending deny). 38 tests total.

## 0.2.0 — 2026-04-17

- **Shared notes.** New `chat_note_put / get / list / delete` tools. Markdown documents are synced to every room member via signed, sealed envelopes. LWW on `(updated_at, author)`; deletes are replay-safe tombstones.
- **Knowledge graph.** New `chat_graph_assert / query / neighbors / retract` tools. Per-room triple store with typed entities, edge properties, and bounded-depth subgraph queries.
- New envelope types: `note_put`, `note_delete`, `graph_assert`, `graph_retract`. All encrypted with the room's current-epoch key — kicked members lose access after rotation.
- SQLite migrations: `notes` and `graph_edges` tables added with backward-compatible `ALTER TABLE` checks.
- Size limits: 64 KB note body, 4 KB graph props, 100-triple batch cap.

## 0.1.0 — 2026-04-17

First release. Core functionality:

- Stdio MCP server exposing the `chat_*` tool family.
- Streamable HTTP transport (`/mcp`) for daemon / TUI use.
- Hyperswarm-based topic discovery, Noise-encrypted transport.
- Ed25519-signed envelopes, per-room XChaCha20-Poly1305 sealing, HKDF epoch keys.
- Sender-keys style key rotation on kick / leave.
- Base32 invite tickets with compact binary encoding.
- SQLite local store (`~/.agentchat/store.db`) for messages, members, contacts.
- Ink-based 3-pane TUI.
- `chat` skill + `.claude/commands/chat.md` dispatcher.
- Test coverage: ticket roundtrip, AEAD/ed25519/hkdf/sealed-box, two-peer loopback, kick+rotate, MCP tool schemas + handlers.
