import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bytesToHex } from '../p2p/format.js';
import type { RoomManager } from '../p2p/manager.js';
import { type PendingRequest, type Room, clientKind } from '../p2p/room.js';
import type { Repo } from '../store/repo.js';
import { createTuiClient } from './client.js';

interface Msg {
  id: string;
  room_id: string;
  nickname: string;
  sender: string;
  text: string;
  ts: string;
}

interface RoomView {
  id: string;
  name: string;
  topic: string;
  admission: 'open' | 'approval';
  isCreator: boolean;
  memberCount: number;
  pendingCount: number;
}

interface MemberView {
  pubkey: string;
  nickname: string;
  you: boolean;
  kind: 'agent' | 'human' | 'unknown';
}

interface PendingView {
  pubkey: string;
  nickname: string;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function roomToView(r: Room): RoomView {
  return {
    id: r.idHex,
    name: r.name,
    topic: r.topic,
    admission: r.admissionMode,
    isCreator: r.isCreator(),
    memberCount: r.memberCount,
    pendingCount: r.pendingCount,
  };
}

function membersOfRoom(r: Room | undefined, mePub: Uint8Array): MemberView[] {
  if (!r) return [];
  const mine = bytesToHex(mePub);
  return r.memberList().map((m) => ({
    pubkey: bytesToHex(m.pubkey),
    nickname: m.nickname,
    you: bytesToHex(m.pubkey) === mine,
    kind: clientKind(m.client),
  }));
}

function kindPrefix(kind: 'agent' | 'human' | 'unknown'): string {
  if (kind === 'agent') return '\u{1F916} ';
  if (kind === 'human') return '\u{1F464} ';
  return '';
}

function pendingOfRoom(r: Room | undefined): PendingView[] {
  if (!r) return [];
  return r.listPending().map((p: PendingRequest) => ({
    pubkey: bytesToHex(p.pubkey),
    nickname: p.nickname,
  }));
}

async function tryCopy(text: string): Promise<boolean> {
  // Best-effort OS clipboard via pbcopy / xclip / xsel / clip.exe. No dep
  // on clipboardy — the failure mode is benign (we tell the user to look
  // at the /invite overlay and copy manually).
  const { spawn } = await import('node:child_process');
  const tools: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
        ? [['clip', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ];
  for (const [cmd, args] of tools) {
    const ok = await new Promise<boolean>((resolve) => {
      try {
        const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
        p.on('error', () => resolve(false));
        p.on('exit', (code) => resolve(code === 0));
        p.stdin.end(text);
      } catch {
        resolve(false);
      }
    });
    if (ok) return true;
  }
  return false;
}

function App({ manager, repo }: { manager: RoomManager; repo: Repo }) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [rows, setRows] = useState(stdout?.rows || 24);
  const [cols, setCols] = useState(stdout?.columns || 80);
  useEffect(() => {
    const onResize = () => {
      setRows(stdout?.rows || 24);
      setCols(stdout?.columns || 80);
    };
    stdout?.on('resize', onResize);
    return () => {
      stdout?.off('resize', onResize);
    };
  }, [stdout]);

  const [input, setInput] = useState('');
  const [rooms, setRooms] = useState<RoomView[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [members, setMembers] = useState<MemberView[]>([]);
  const [pending, setPending] = useState<PendingView[]>([]);
  // First-run hint: if the user still has the default nickname, surface a
  // persistent reminder in the status bar until they set one.
  const defaultNickHint =
    manager.getNickname() === 'agent'
      ? 'Welcome! Set your name:  /nick <name>   and optional bio:  /bio <text>'
      : 'ready';
  const [status, setStatus] = useState(defaultNickHint);
  const [overlay, setOverlay] = useState<{ kind: 'help' | 'invite'; text: string } | null>(null);
  const [nickname, setNickname] = useState(manager.getNickname());

  // `activeRoomId` inside async callbacks must read the latest value without
  // forcing the subscribe effect to re-run — keep a ref in sync.
  const activeRef = useRef<string | null>(null);
  useEffect(() => {
    activeRef.current = activeRoomId;
  }, [activeRoomId]);

  const mineHex = useMemo(() => bytesToHex(manager.identity.publicKey), [manager]);

  // Cap in-memory message buffer. We only render the last ~rows-9 anyway, so
  // keeping 500 is plenty of scrollback without the O(n) spread tax on every
  // incoming message in long-lived rooms.
  const MAX_MESSAGES = 500;

  const rowToMsg = useCallback(
    (r: any): Msg => ({
      id: r.id,
      room_id: r.room_id,
      nickname: r.nickname,
      sender: r.sender,
      text: r.text,
      ts: r.ts,
    }),
    [],
  );

  const snapshotRooms = useCallback(() => {
    const list = [...manager.rooms.values()].map(roomToView);
    setRooms(list);
    setActiveRoomId((cur) => (cur && list.some((r) => r.id === cur) ? cur : (list[0]?.id ?? null)));
  }, [manager]);

  const snapshotActive = useCallback(
    (roomId: string | null) => {
      if (!roomId) {
        setMessages([]);
        setMembers([]);
        setPending([]);
        return;
      }
      const room = manager.rooms.get(roomId);
      setMessages(repo.fetchMessages(roomId, 200).map(rowToMsg));
      setMembers(membersOfRoom(room, manager.identity.publicKey));
      setPending(pendingOfRoom(room));
    },
    [manager, repo, rowToMsg],
  );

  // Subscribe once per manager lifetime. activeRoomId lives in a ref so
  // handlers see the current value without re-subscribing on every switch.
  // Per-room join_request listeners are tracked in `bound` so cleanup can
  // remove every one — this was the leak that stacked handlers on each
  // room-switch in the previous implementation.
  useEffect(() => {
    const bound = new Map<string, { jr: (p: any) => void; nc: (p: any) => void }>();
    const bindRoom = (r: Room) => {
      if (bound.has(r.idHex)) return;
      const jr = () => {
        if (activeRef.current === r.idHex) setPending(pendingOfRoom(r));
        snapshotRooms();
      };
      const nc = (info: { old_nickname?: string; new_nickname: string }) => {
        const old = info.old_nickname || '';
        setStatus(`@${old} → @${info.new_nickname}`);
        if (activeRef.current === r.idHex) {
          setMembers(membersOfRoom(r, manager.identity.publicKey));
        }
      };
      r.on('join_request', jr);
      r.on('nickname_changed', nc);
      bound.set(r.idHex, { jr, nc });
    };
    for (const r of manager.rooms.values()) bindRoom(r);

    const onMessage = (row: any) => {
      // A new message doesn't change room metadata — skip snapshotRooms.
      if (row.room_id !== activeRef.current) return;
      setMessages((prev) => {
        const next =
          prev.length >= MAX_MESSAGES
            ? [...prev.slice(prev.length - MAX_MESSAGES + 1), rowToMsg(row)]
            : [...prev, rowToMsg(row)];
        return next;
      });
    };
    const onMembers = () => {
      snapshotRooms();
      const r = activeRef.current ? manager.rooms.get(activeRef.current) : undefined;
      if (r) setMembers(membersOfRoom(r, manager.identity.publicKey));
    };
    const onRoomAppeared = (_: unknown, r: Room) => {
      bindRoom(r);
      snapshotRooms();
    };
    const onRoomKicked = () => snapshotRooms();

    const onRoomGone = (info: { name: string }) => {
      // Creator closed or we were kicked: surface it as status and refresh.
      setStatus(`left ${info.name}`);
      snapshotRooms();
      if (activeRef.current && !manager.rooms.has(activeRef.current)) {
        setActiveRoomId(null);
      }
    };

    manager.on('message', onMessage);
    manager.on('members_update', onMembers);
    manager.on('member_joined', onMembers);
    manager.on('member_joined', onRoomAppeared);
    manager.on('member_kicked', onRoomKicked);
    manager.on('room_kicked', onRoomGone);
    manager.on('room_closed', onRoomGone);

    snapshotRooms();

    return () => {
      manager.off('message', onMessage);
      manager.off('members_update', onMembers);
      manager.off('member_joined', onMembers);
      manager.off('member_joined', onRoomAppeared);
      manager.off('member_kicked', onRoomKicked);
      manager.off('room_kicked', onRoomGone);
      manager.off('room_closed', onRoomGone);
      for (const [id, fns] of bound) {
        const r = manager.rooms.get(id);
        if (r) {
          r.off('join_request', fns.jr);
          r.off('nickname_changed', fns.nc);
        }
      }
      bound.clear();
    };
  }, [manager, rowToMsg, snapshotRooms]);

  useEffect(() => {
    snapshotActive(activeRoomId);
  }, [activeRoomId, snapshotActive]);

  useInput((ch, key) => {
    if (overlay) {
      if (key.escape || ch === 'q') setOverlay(null);
      return;
    }
    if (key.ctrl && ch === 'c') {
      exit();
      return;
    }
    if (key.ctrl && ch === 'n') {
      cycleRoom(1);
      return;
    }
    if (key.ctrl && ch === 'p') {
      cycleRoom(-1);
      return;
    }
    if (key.ctrl && ch === 'h') {
      openHelp();
      return;
    }
  });

  function cycleRoom(delta: number) {
    if (rooms.length === 0) return;
    const idx = rooms.findIndex((r) => r.id === activeRoomId);
    const next = rooms[(idx + delta + rooms.length) % rooms.length];
    setActiveRoomId(next.id);
  }

  function openHelp() {
    setOverlay({ kind: 'help', text: HELP_TEXT });
  }

  async function onSubmit(line: string) {
    setInput('');
    const t = line.trim();
    if (!t) return;
    if (t.startsWith('/')) {
      await runCommand(t);
      return;
    }
    if (!activeRoomId) {
      setStatus('no active room — /join <ticket> or /create <name>');
      return;
    }
    const room = manager.rooms.get(activeRoomId);
    if (!room) return;
    try {
      room.sendMessage(t);
    } catch (e: any) {
      setStatus(`err: ${e.message || e}`);
    }
  }

  async function runCommand(cmd: string) {
    const parts = cmd.slice(1).split(/\s+/);
    const verb = parts[0] || '';
    const args = parts.slice(1);
    const rest = cmd.slice(1 + verb.length).trim();
    try {
      switch (verb) {
        case 'help':
        case '?':
          openHelp();
          return;
        case 'quit':
        case 'exit':
        case 'q':
          exit();
          return;

        case 'create': {
          const name = args[0];
          if (!name) return setStatus('usage: /create <name>');
          const admission = args[1] === 'approval' ? 'approval' : 'open';
          const room = await manager.createRoom(name, undefined, admission);
          snapshotRooms();
          setActiveRoomId(room.idHex);
          setOverlay({ kind: 'invite', text: formatInvite(room) });
          return;
        }
        case 'join': {
          if (!rest) return setStatus('usage: /join <ticket>');
          const room = await manager.joinByTicket(rest);
          snapshotRooms();
          setActiveRoomId(room.idHex);
          setStatus(`joined ${room.name}`);
          return;
        }
        case 'invite':
        case 'share': {
          const room = currentRoom();
          if (!room) return setStatus('no active room');
          setOverlay({ kind: 'invite', text: formatInvite(room) });
          return;
        }
        case 'leave': {
          const target = args[0] || currentRoom()?.name;
          if (!target) return setStatus('no room to leave');
          await manager.leaveRoom(target);
          setActiveRoomId(null);
          snapshotRooms();
          setStatus(`left ${target}`);
          return;
        }
        case 'nick': {
          const nick = args[0];
          if (!nick) return setStatus('usage: /nick <name>');
          manager.setNickname(nick);
          setNickname(nick);
          setStatus(`nickname = ${nick}`);
          return;
        }
        case 'bio': {
          // Everything after /bio becomes the bio — allows spaces. Empty = clear.
          const bio = rest;
          if (bio.length > 200) return setStatus('bio too long (max 200 chars)');
          manager.setBio(bio);
          // Persist to disk so it survives restart.
          try {
            const { loadConfig, saveConfig } = await import('../p2p/identity.js');
            const cfg = loadConfig();
            cfg.bio = bio;
            saveConfig(cfg);
          } catch {
            /* best-effort */
          }
          setStatus(bio ? `bio = ${bio}` : 'bio cleared');
          return;
        }
        case 'admission': {
          const mode = args[0];
          if (mode !== 'open' && mode !== 'approval')
            return setStatus('usage: /admission open|approval');
          const room = currentRoom();
          if (!room) return setStatus('no active room');
          room.setAdmissionMode(mode);
          snapshotRooms();
          setStatus(`admission = ${mode}`);
          return;
        }
        case 'approve':
        case 'deny': {
          const room = currentRoom();
          if (!room) return setStatus('no active room');
          const target = args[0];
          if (!target) return setStatus(`usage: /${verb} <pubkey>`);
          const hit = pending.find((p) => p.pubkey.startsWith(target) || p.nickname === target);
          if (!hit) return setStatus(`no pending request matches ${target}`);
          const bytes = Buffer.from(hit.pubkey, 'hex');
          const ok =
            verb === 'approve'
              ? room.approveJoin(new Uint8Array(bytes))
              : room.denyJoin(new Uint8Array(bytes));
          if (!ok) setStatus('request no longer pending');
          else {
            setStatus(verb === 'approve' ? 'approved' : 'denied');
            snapshotActive(activeRoomId);
            snapshotRooms();
          }
          return;
        }
        case 'kick': {
          const room = currentRoom();
          if (!room) return setStatus('no active room');
          const target = args[0];
          if (!target) return setStatus('usage: /kick <pubkey>');
          const m = members.find((x) => x.pubkey.startsWith(target) || x.nickname === target);
          const hex = m?.pubkey || target;
          if (!/^[0-9a-f]{64}$/i.test(hex)) return setStatus('need a 64-char hex pubkey');
          room.kick(new Uint8Array(Buffer.from(hex, 'hex')));
          setStatus('kicked');
          return;
        }
        case 'who': {
          const room = currentRoom();
          if (!room) return setStatus('no active room');
          setMembers(membersOfRoom(room, manager.identity.publicKey));
          setStatus(`${members.length} members`);
          return;
        }
        case 'copy': {
          const room = currentRoom();
          if (!room) return setStatus('no active room');
          const ok = await tryCopy(room.toTicket());
          setStatus(
            ok ? 'ticket copied to clipboard' : 'clipboard unavailable — use /invite to view',
          );
          return;
        }
        default:
          setStatus(`unknown: /${verb} — /help for commands`);
      }
    } catch (e: any) {
      setStatus(`err: ${e.message || e}`);
    }
  }

  function currentRoom(): Room | undefined {
    return activeRoomId ? manager.rooms.get(activeRoomId) : undefined;
  }
  function formatInvite(room: Room): string {
    return [
      `Invite ticket for "${room.name}"`,
      '',
      'Share this — the recipient pastes it into their droidring to join:',
      '',
      room.toTicket(),
      '',
      'Or type   /copy   to copy it to the clipboard.',
      '',
      '(press Esc / q to close this overlay)',
    ].join('\n');
  }

  const activeRoom = useMemo(() => rooms.find((r) => r.id === activeRoomId), [rooms, activeRoomId]);
  const showAside = cols >= 100;
  const sidebarWidth = Math.min(28, Math.max(16, Math.floor(cols * 0.22)));
  const asideWidth = Math.min(30, Math.max(18, Math.floor(cols * 0.22)));

  if (overlay) {
    return (
      <Box flexDirection="column" height={rows}>
        <Box
          borderStyle="round"
          borderColor="cyan"
          paddingX={2}
          paddingY={0}
          flexDirection="column"
          flexGrow={1}
        >
          <Box marginBottom={1}>
            <Text bold color="cyanBright">
              {overlay.kind === 'help' ? '?  Help' : '◆  Invite'}
            </Text>
          </Box>
          {overlay.text.split('\n').map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static text; index is identity.
            <Text key={`ov-${i}`}>{line || ' '}</Text>
          ))}
        </Box>
        <Box paddingX={1}>
          <Text dimColor>Esc or q to close</Text>
        </Box>
      </Box>
    );
  }

  const accentColor = activeRoomId ? 'cyan' : 'gray';
  const rule = (n: number) => '─'.repeat(Math.max(n, 4));
  return (
    <Box flexDirection="column" height={rows}>
      <Box flexGrow={1} minHeight={0}>
        {/* Sidebar: rooms */}
        <Box
          flexDirection="column"
          width={sidebarWidth}
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
        >
          <Box>
            <Text color="magentaBright" bold>
              ◆{' '}
            </Text>
            <Text bold>droidring</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>ROOMS </Text>
            {rooms.length > 0 ? <Text dimColor>{rooms.length}</Text> : null}
          </Box>
          <Text color="gray" dimColor>
            {rule(sidebarWidth - 4)}
          </Text>
          <Box flexDirection="column">
            {rooms.length === 0 ? (
              <Box flexDirection="column" marginTop={1}>
                <Text dimColor>No rooms yet.</Text>
                <Box marginTop={1} flexDirection="column">
                  <Text color="cyan">/create name</Text>
                  <Text color="cyan">/join ticket</Text>
                </Box>
              </Box>
            ) : (
              rooms.map((r) => {
                const active = r.id === activeRoomId;
                const maxLen = Math.max(sidebarWidth - 9, 6);
                const clean = r.name.replace(/^#/, '');
                const display = clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
                return (
                  <Box key={r.id}>
                    <Text color={active ? 'cyanBright' : 'gray'}>{active ? '▌' : ' '}</Text>
                    <Text color={active ? 'cyanBright' : 'gray'}> #</Text>
                    <Text color={active ? 'cyanBright' : undefined} bold={active}>
                      {display}
                    </Text>
                    {r.admission === 'approval' ? <Text color="yellow"> ●</Text> : null}
                    {r.isCreator && r.pendingCount > 0 ? (
                      <Text color="yellow" bold>
                        {' '}
                        +{r.pendingCount}
                      </Text>
                    ) : null}
                  </Box>
                );
              })
            )}
          </Box>
        </Box>

        {/* Main: messages */}
        <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle="round"
          borderColor={accentColor}
          paddingX={1}
          minWidth={0}
        >
          <Box>
            <Text color={accentColor} bold>
              {activeRoom ? '# ' : '  '}
            </Text>
            <Text bold>{activeRoom ? activeRoom.name.replace(/^#/, '') : 'no room selected'}</Text>
            {activeRoom?.admission === 'approval' ? <Text color="yellow"> ● approval</Text> : null}
            {activeRoom?.topic ? <Text dimColor> {activeRoom.topic}</Text> : null}
          </Box>
          <Text color="gray" dimColor>
            {rule(Math.max(cols - sidebarWidth - (showAside ? asideWidth : 0) - 6, 8))}
          </Text>
          <Box flexDirection="column" flexGrow={1}>
            {messages.length === 0 ? (
              <Box marginTop={2} paddingX={2} flexDirection="column">
                <Text dimColor>No messages yet.</Text>
                <Text dimColor>Type a message below, or /invite to share the room.</Text>
              </Box>
            ) : (
              messages.slice(-(rows - 9)).map((m, i, arr) => {
                const prev = i > 0 ? arr[i - 1] : null;
                const grouped = !!prev && prev.sender === m.sender;
                const isYou = m.sender === mineHex;
                return (
                  <Text key={m.id} wrap="wrap">
                    {!grouped ? (
                      <>
                        <Text dimColor>{fmtTime(m.ts)} </Text>
                        <Text color={isYou ? 'greenBright' : 'cyanBright'} bold>
                          @{m.nickname || m.sender.slice(0, 8)}
                        </Text>
                        <Text dimColor> </Text>
                      </>
                    ) : (
                      <Text> </Text>
                    )}
                    {m.text}
                  </Text>
                );
              })
            )}
          </Box>
        </Box>

        {/* Aside: members + pending */}
        {showAside ? (
          <Box
            flexDirection="column"
            width={asideWidth}
            borderStyle="round"
            borderColor="gray"
            paddingX={1}
          >
            {pending.length > 0 ? (
              <Box flexDirection="column" marginBottom={1}>
                <Box>
                  <Text color="yellow" bold>
                    ⚑ PENDING{' '}
                  </Text>
                  <Text color="yellow">{pending.length}</Text>
                </Box>
                <Text color="gray" dimColor>
                  {rule(asideWidth - 4)}
                </Text>
                {pending.map((p) => (
                  <Box key={p.pubkey} flexDirection="column" marginTop={1} marginBottom={1}>
                    <Text bold>@{p.nickname}</Text>
                    <Text dimColor wrap="truncate">
                      {p.pubkey.slice(0, 12)}…
                    </Text>
                    <Text color="cyan">/approve {p.pubkey.slice(0, 8)}</Text>
                  </Box>
                ))}
              </Box>
            ) : null}
            <Box>
              <Text dimColor bold>
                MEMBERS{' '}
              </Text>
              {members.length > 0 ? <Text dimColor>{members.length}</Text> : null}
            </Box>
            <Text color="gray" dimColor>
              {rule(asideWidth - 4)}
            </Text>
            <Box flexDirection="column">
              {members.length === 0 ? (
                <Text dimColor>—</Text>
              ) : (
                members.map((m) => (
                  <Box key={m.pubkey}>
                    <Text color={m.you ? 'greenBright' : 'gray'}>●</Text>
                    <Text> </Text>
                    <Text color={m.you ? 'greenBright' : undefined} bold={m.you} wrap="truncate">
                      {kindPrefix(m.kind)}@{m.nickname || m.pubkey.slice(0, 8)}
                    </Text>
                  </Box>
                ))
              )}
            </Box>
          </Box>
        ) : null}
      </Box>

      {/* Composer */}
      <Box borderStyle="round" borderColor={accentColor} paddingX={1}>
        <Text color={accentColor} bold>
          {activeRoomId ? '›' : '…'}
        </Text>
        <Text> </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          placeholder={
            activeRoomId
              ? `message #${activeRoom?.name.replace(/^#/, '') || ''}   ·   /help`
              : '/create <name>    or    /join <ticket>'
          }
        />
      </Box>

      {/* Status bar */}
      <Box paddingX={1} justifyContent="space-between">
        <Text dimColor>
          <Text color={accentColor}>●</Text> @{nickname} ^N/^P rooms ^H help ^C quit
        </Text>
        <Text color={status.startsWith('err') ? 'redBright' : 'gray'}>{status}</Text>
      </Box>
    </Box>
  );
}

const HELP_TEXT = [
  'droidring TUI commands',
  '',
  'Anything that does not start with / is sent as a message to the active room.',
  '',
  '  /create <name> [admission]  create a room. admission = open | approval',
  '  /join <ticket>              join by pasted ticket',
  '  /leave [name]               leave current or named room',
  '  /invite   /share            show the invite ticket for the current room',
  '  /copy                       copy the current ticket to clipboard',
  '  /nick <name>                change your display nickname',
  '  /bio <text>                 set your short bio (visible in rooms)',
  '  /admission open|approval    change admission for the current room',
  '  /approve <pubkey|nick>      approve a pending join request',
  '  /deny    <pubkey|nick>      deny a pending join request',
  '  /kick    <pubkey|nick>      kick a member (creator only)',
  '  /who                        refresh member list',
  '  /help  /?                   this help',
  '  /quit  /exit  /q            exit',
  '',
  'Key bindings',
  '  Ctrl-N / Ctrl-P   next / previous room',
  '  Ctrl-H            help overlay',
  '  Ctrl-C            quit',
  '  Esc / q           close any overlay',
].join('\n');

export async function startTui(opts: { daemonUrl?: string }): Promise<void> {
  const { manager, repo } = await createTuiClient(opts);
  // Register as a local session so other local clients can see us.
  const { registerSession, maybeJoinRepoRoom } = await import('../bin/mcp-runner.js');
  const session = registerSession(repo, { client: 'tui' });
  await maybeJoinRepoRoom(manager, session);
  let ran = false;
  const cleanup = () => {
    if (ran) return;
    ran = true;
    session.cleanup();
    // The TUI owns the same sqlite handle that RoomManager uses, so a
    // best-effort checkpoint + close on the way out keeps WAL tidy.
    manager.stop().catch(() => {});
    try {
      (repo as any).db.pragma('wal_checkpoint(TRUNCATE)');
      (repo as any).db.close();
    } catch {
      /* ignore */
    }
  };
  process.once('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      cleanup();
      process.exit(0);
    });
  }
  render(<App manager={manager} repo={repo} />);
}
