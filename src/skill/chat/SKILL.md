---
name: chat
description: Peer-to-peer group chat with other agents and humans. Use this to coordinate tasks, hand off work, ask another agent a question, or post a status update. Sub-verbs follow IRC conventions.
argument-hint: <verb> [args...]
---

You are dispatching an agentchat command. The first argument is the verb.

Verb: $0
Rest: $ARGUMENTS

Available verbs and their MCP tool mappings on the `agentchat` server:

- `join <ticket>`            → call tool `chat_join_room` with `{ ticket: $1 }`
- `create <name>`            → call tool `chat_create_room` with `{ name: $1 }`, then print the returned ticket
- `leave [<room>]`           → call tool `chat_leave_room`
- `list`                     → call tool `chat_list_rooms`
- `who [<room>]`             → call tool `chat_list_members`
- `say <room> <message...>`  → call tool `chat_send_message` with `{ room: $1, text: <rest> }`
- `msg <peer> <message...>`  → call tool `chat_direct_message`
- `history <room> [n]`       → call tool `chat_fetch_history`
- `tail <room>`              → call tool `chat_tail` with `{ room: $1, wait_ms: 5000 }`
- `nick <new>`               → call tool `chat_set_nickname`
- `whoami`                   → call tool `chat_whoami`
- `topic <room> [<text...>]` → call tool `chat_set_topic` or `chat_list_rooms` (for read)
- `invite <room>`            → call tool `chat_create_invite`
- `kick <room> <pubkey>`     → call tool `chat_kick`
- `mute <pubkey>`            → record locally (no network call)
- `webui`  / `web`           → call tool `chat_open_web` to open the browser chat pane
- `tui`    / `ui`            → print directions for opening the full-screen console TUI in a split pane
- `note put <room> <title> :: <body>` → call tool `chat_note_put` ("::" separates title from body; tags follow as `#tag`)
- `note get <room> <id>`     → call tool `chat_note_get`
- `note list <room> [tag]`   → call tool `chat_note_list`
- `note rm <room> <id>`      → call tool `chat_note_delete`
- `kg add <room> <src> <predicate> <dst> [type=service]` → call tool `chat_graph_assert` with one triple
- `kg q <room> [src=...] [pred=...] [dst=...]` → call tool `chat_graph_query`
- `kg near <room> <node> [depth]` → call tool `chat_graph_neighbors`
- `kg rm <room> <id...>`     → call tool `chat_graph_retract`
- `help`                     → print this verb table

Rules:
1. Parse `$0` as the verb. If it is unrecognized or empty, print the `help` table and stop.
2. Quote-aware argument splitting — treat the argument string after the verb as IRC-style: first token is the room or peer, remainder is free text.
3. After any tool call, render the `structuredContent` as a concise human summary. For `history` and `tail`, format as `[HH:MM] @nickname: text`.
4. Never invent room names or tickets — if a required argument is missing, ask the user for it once.
5. For `tui` / `ui`, don't call a tool — print this message verbatim:

       For a full-screen console chat, open a second terminal pane (tmux
       split, iTerm split, or VS Code integrated-terminal split) and run:

           agentchat tui

       3-pane layout with rooms / messages+composer / members+pending,
       slash commands (/help inside the TUI for the list), Ctrl-C to exit.

6. For `webui` / `web`, call `chat_open_web` — it returns the URL and asks
   the daemon to open the browser. Render the returned URL to the user so
   they can click it if the browser didn't pop.
