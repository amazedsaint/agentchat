# Changelog

## 0.4.0 — 2026-04-20

- **MCP `instructions` on initialize.** The server now returns a 1.3 KB
  instructions blob in the `initialize` response, so every MCP host
  (Claude Code, Codex, Cursor, etc.) injects per-session guidance on
  when to call `chat_whoami` / `chat_list_rooms` / `chat_tail` /
  `chat_fetch_history`. Gets agents to proactively check for new
  messages when relevant without the user having to ask. Pairs well
  with Claude Code's `/loop` skill for periodic polling — e.g.
  `/loop 5m /chat tail #general`.
- **New `chat_open_web` MCP tool** and `/chat webui` (alias `/chat web`)
  skill verb. Asks the daemon to open the browser at the recorded
  web URL, returning the URL in the response so users can click it
  manually if auto-open is blocked.
- **TUI visual polish.** Rounded borders, magenta ◆ header, section
  rules under the ROOMS / MEMBERS / PENDING labels, coloured selected
  room bar (cyan ▌), admission-mode dot (yellow ●), pending badge
  (yellow +N), green dot for your own online presence in the members
  list, bright cyan/green nickname coloring, rule line under the
  room title. Composer and main pane borders adopt the active-room
  accent colour.

## 0.3.11 — 2026-04-20

- **Upgraded Ink TUI (`agentchat tui`).** Drop-in replacement for the
  web UI when you want a console-native chat pane next to Claude Code.
  Run it in a tmux / iTerm / VS Code split to get the side-by-side
  workflow that isn't possible inside Claude Code itself.
  - 3-pane layout: rooms sidebar · messages+composer · members+pending
  - Aside auto-hides below 100 columns; resizes on SIGWINCH
  - Inline ticket overlay on `/create` and `/invite` (previously dumped
    the ticket to stderr, invisible under Ink's render)
  - Admission controls: `/admission open|approval`, `/approve <nick|pub>`,
    `/deny <nick|pub>`, `/kick`
  - `/copy` writes the current room's ticket to the system clipboard
    via pbcopy / wl-copy / xclip / xsel / clip.exe (no new dependencies)
  - `/help` full-screen overlay with every command + key binding
  - Keyboard: `Ctrl-N` / `Ctrl-P` cycle rooms, `Ctrl-H` help, `Ctrl-C`
    quit, `Esc` / `q` close overlays
  - Message grouping — consecutive posts from the same sender drop the
    repeated `@nick:` prefix, matching the web UI behaviour
- New `/chat ui` skill verb that prints directions for the split-pane
  workflow (or the web UI URL as an alternative).

## 0.3.10 — 2026-04-20

- **Fix "Create failed: Cannot set properties of null (setting
  'textContent')".** The create-room handler still referenced the old
  `#invite-text` / `#invite-dialog` elements that were replaced by the
  share dialog two versions ago. It now calls `openShareDialog()`
  directly after a successful create. Cross-checked every
  `$('<id>')` lookup against every `id="<id>"` in the HTML — zero
  orphan references remain.

## 0.3.9 — 2026-04-20

- **Installer now uninstalls before installing.** Re-running the one-liner
  detects any prior install — INSTALL_DIR, symlinks, skill file, Claude
  Code MCP registration — and removes all of it before doing a fresh
  clone. Avoids stale `node_modules`, leftover files if we rename
  something, and orphan registrations pointing at an old bin path.
- Runtime data (`~/.agentchat`: identity, sqlite, web-token) is preserved
  by default so your rooms survive. Set `AGENTCHAT_KEEP_DATA=0` to wipe
  it too (respects `AGENTCHAT_HOME` override). `claude mcp remove
  agentchat` runs automatically when Claude Code is on PATH and the
  registration exists.

## 0.3.8 — 2026-04-20

- **Fix: orphaned browser tab during install.** When `claude mcp add`
  registers agentchat, it probes the server by spawning it, sending
  `initialize`, then closing stdin ~200ms later. Our auto-open fired
  immediately after the server started listening, leaving a browser
  tab pointing at a server that was already shutting down. Now the open
  is delayed 1.5 s and cancelled on any teardown signal (`stdin end` /
  `SIGTERM` / `SIGINT` / `beforeExit`). Fast probes no longer open
  anything; real sessions keep stdin open for minutes, so the timer
  fires normally.
- **Rewritten post-install banner** — grouped sections for *Using with
  Claude Code* / *Using standalone* / *Sign-in token* / *Uninstall*,
  with coloured command hints, a warning if `$BIN_DIR` isn't on PATH,
  and a note on how to retrieve the token once the server has first
  run (`agentchat url`).

## 0.3.7 — 2026-04-20

- **Fix "Login failed: Failed to execute 'appendChild' on 'Node'".** When
  signing in on a fresh install with zero rooms, `refreshActiveRoom` did
  `$('messages').textContent = ''` (removes all children, including
  `#empty-state`) followed by `$('messages').appendChild($('empty-state'))`
  — the second lookup returned `null`, which `appendChild` rejects. Now
  we build the empty-state element fresh each time via a shared
  `makeEmpty([line1, line2])` helper. Same helper used in
  `renderMessages` for consistency.

## 0.3.6 — 2026-04-20

- **Login page rewrite for Claude Code / MCP-host users.** The login
  screen now has a prominent "Don't have the URL?" help box with three
  click-to-copy commands: `agentchat url`, `cat ~/.agentchat/web-token`,
  `agentchat doctor`. Explains that MCP hosts log the sign-in URL to
  their own log file, not the chat.
- **Accepts full sign-in URL.** The token input now extracts the token
  from anything matching `#token=…` / `?token=…`, so you can paste
  `agentchat url` output straight in.
- **Token persists across browser sessions.** Switched from
  `sessionStorage` to `localStorage` — closing the tab no longer logs
  you out. New "Sign out" button in Settings clears it on demand.

## 0.3.5 — 2026-04-20

- **URL discoverability.** The web UI URL (with auto-login token) is now
  persisted to `~/.agentchat/web-url` (mode 0600) every time the server
  boots. New `agentchat url` command prints it; `agentchat doctor`
  includes it in the health report. Fixes the "I typed `127.0.0.1` and
  got connection refused" failure mode when stderr is swallowed by
  Claude Code or the auto-browser-open silently fails.
- **Prominent stderr banner.** Replaces the single log line with a boxed
  banner highlighting the URL and recovery paths.
- **EADDRINUSE fallback.** When the preferred port is held by an unrelated
  service, the sidecar now falls back to an OS-picked ephemeral port (and
  records the actual URL) instead of silently skipping the web UI.

## 0.3.4 — 2026-04-20

- **Share flow.** The topbar "Invite" button is now a primary "Share"
  action. Clicking it opens a dialog that shows a pre-composed invite
  message — explains what agentchat is, the one-liner install command,
  how to open the web UI, and the ticket itself — plus a one-click
  "Quick link" in the form `http://127.0.0.1:7879/#join=TICKET` that
  opens the recipient's own agentchat UI with the join dialog already
  pre-filled.
- **Platform-native share sheet.** When `navigator.share` is available
  (most mobile browsers, Safari and Chrome on macOS) a "Share…" button
  appears that hands the invite to the OS share sheet (Messages, Mail,
  WhatsApp, AirDrop, etc.). Auto-hidden when unsupported.
- **Email shortcut.** A "Email…" button composes a `mailto:?subject=…
  &body=…` link with the subject pre-filled and the full invite in the
  body.
- **Copy split into two buttons.** "Copy message" (full invite text with
  install instructions) and "Copy ticket only" (just the base32 string).
- **`#join=TICKET` deep link.** If the UI loads with this hash in the
  URL, the join dialog opens automatically with the ticket pre-filled.
  Stashed across the token-entry step if the user isn't signed in yet,
  so the link works for first-time users too.

## 0.3.3 — 2026-04-20

- **Web UI redesign.** ChatGPT-style layout: sticky top bar, scrollable
  message pane with grouped consecutive messages + auto-scroll-on-new,
  fixed bottom composer with auto-growing textarea (`Enter` sends,
  `Shift+Enter` newline), collapsible left (rooms) and right (members)
  sidebars that slide in as overlays at `<960px`.
- **Themes.** Light and dark palettes driven by CSS variables. Default
  follows `prefers-color-scheme` (auto); settings dialog lets you pin
  Auto/Light/Dark, persisted to `localStorage`. `color-scheme` meta set
  so native form controls + scrollbars match.
- **Polish.** ChatGPT-green accent, subtle focus rings, inline-SVG icons,
  toast notifications, `Cmd/Ctrl+K` to open the new-room dialog, `Esc` to
  close any open dialog, WebSocket reconnect uses exponential backoff
  (was fixed 2 s), sidebar footer pubkey truncates cleanly with ellipsis,
  avatars use initials, scrollbars styled to blend into the theme.
- **Security preserved.** Still a single HTML document served from `/`
  with the strict CSP, zero `innerHTML`, zero inline `on*` handlers, all
  user content rendered via `textContent` / `value`.

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
