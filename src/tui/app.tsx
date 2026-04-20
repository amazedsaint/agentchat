import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { bytesToHex } from '../p2p/format.js';
import type { RoomManager } from '../p2p/manager.js';
import type { PendingRequest, Room } from '../p2p/room.js';
import type { Repo } from '../store/repo.js';
import { createTuiClient } from './client.js';

// ----- types ------------------------------------------------------------

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
}

interface PendingView {
  pubkey: string;
  nickname: string;
}

// ----- helpers ----------------------------------------------------------

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
  }));
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

// ----- root app ---------------------------------------------------------

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
  const [status, setStatus] = useState('ready');
  const [overlay, setOverlay] = useState<'help' | 'invite' | null>(null);
  const [overlayText, setOverlayText] = useState('');
  const [nickname, setNickname] = useState(manager.getNickname());

  const refreshRooms = useCallback(() => {
    const list = [...manager.rooms.values()].map((r) => roomToView(r));
    setRooms(list);
    setActiveRoomId((cur) => {
      if (cur && list.some((r) => r.id === cur)) return cur;
      return list[0]?.id ?? null;
    });
  }, [manager]);

  const refreshActive = useCallback(
    (roomId: string | null) => {
      if (!roomId) {
        setMessages([]);
        setMembers([]);
        setPending([]);
        return;
      }
      const room = manager.rooms.get(roomId);
      const rows = repo.fetchMessages(roomId, 200);
      setMessages(
        rows.map((r) => ({
          id: r.id,
          room_id: r.room_id,
          nickname: r.nickname,
          sender: r.sender,
          text: r.text,
          ts: r.ts,
        })),
      );
      setMembers(membersOfRoom(room, manager.identity.publicKey));
      setPending(pendingOfRoom(room));
    },
    [manager, repo],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshRooms is stable.
  useEffect(() => {
    refreshRooms();
    const onMessage = (row: any) => {
      if (row.room_id === activeRoomId) {
        setMessages((prev) => [
          ...prev,
          {
            id: row.id,
            room_id: row.room_id,
            nickname: row.nickname,
            sender: row.sender,
            text: row.text,
            ts: row.ts,
          },
        ]);
      }
      refreshRooms();
    };
    const onMembers = () => {
      refreshRooms();
      if (activeRoomId) {
        setMembers(membersOfRoom(manager.rooms.get(activeRoomId), manager.identity.publicKey));
      }
    };
    const onJoinReq = (_p: unknown, room: Room) => {
      refreshRooms();
      if (activeRoomId === room.idHex) setPending(pendingOfRoom(room));
    };
    manager.on('message', onMessage);
    manager.on('members_update', onMembers);
    manager.on('member_joined', onMembers);
    manager.on('member_kicked', onMembers);
    // join_request fires on Room, not Manager. Subscribe per room.
    const bindRoom = (r: Room) => r.on('join_request', () => onJoinReq(null, r));
    for (const r of manager.rooms.values()) bindRoom(r);
    manager.on('member_joined', (_: unknown, r: Room) => bindRoom(r));
    return () => {
      manager.off('message', onMessage);
      manager.off('members_update', onMembers);
      manager.off('member_joined', onMembers);
      manager.off('member_kicked', onMembers);
    };
  }, [manager, activeRoomId]);

  useEffect(() => {
    refreshActive(activeRoomId);
  }, [activeRoomId, refreshActive]);

  // ----- key bindings -----
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
    setOverlayText(HELP_TEXT);
    setOverlay('help');
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
          refreshRooms();
          setActiveRoomId(room.idHex);
          setOverlayText(formatInvite(room));
          setOverlay('invite');
          return;
        }
        case 'join': {
          if (!rest) return setStatus('usage: /join <ticket>');
          const room = await manager.joinByTicket(rest);
          refreshRooms();
          setActiveRoomId(room.idHex);
          setStatus(`joined ${room.name}`);
          return;
        }
        case 'invite':
        case 'share': {
          const room = currentRoom();
          if (!room) return setStatus('no active room');
          setOverlayText(formatInvite(room));
          setOverlay('invite');
          return;
        }
        case 'leave': {
          const target = args[0] || currentRoom()?.name;
          if (!target) return setStatus('no room to leave');
          await manager.leaveRoom(target);
          setActiveRoomId(null);
          refreshRooms();
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
        case 'admission': {
          const mode = args[0];
          if (mode !== 'open' && mode !== 'approval')
            return setStatus('usage: /admission open|approval');
          const room = currentRoom();
          if (!room) return setStatus('no active room');
          room.setAdmissionMode(mode);
          refreshRooms();
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
            refreshActive(activeRoomId);
            refreshRooms();
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
      'Share this — the recipient pastes it into their agentchat to join:',
      '',
      room.toTicket(),
      '',
      'Or type   /copy   to copy it to the clipboard.',
      '',
      '(press Esc / q to close this overlay)',
    ].join('\n');
  }

  // ----- render -----
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
          paddingX={1}
          paddingY={0}
          flexDirection="column"
          flexGrow={1}
        >
          <Text bold color="cyan">
            {overlay === 'help' ? 'Help' : 'Invite'}
          </Text>
          <Box marginTop={1} flexDirection="column">
            {overlayText.split('\n').map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are static text; position is the identity.
              <Text key={`ov-${i}`}>{line || ' '}</Text>
            ))}
          </Box>
        </Box>
        <Box paddingX={1}>
          <Text dimColor>press Esc or q to close</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={rows}>
      <Box flexGrow={1} minHeight={0}>
        {/* Sidebar: rooms */}
        <Box
          flexDirection="column"
          width={sidebarWidth}
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
        >
          <Text bold>Rooms {rooms.length > 0 ? <Text dimColor>· {rooms.length}</Text> : null}</Text>
          <Box marginTop={1} flexDirection="column">
            {rooms.length === 0 ? (
              <Text dimColor>none — /create or /join</Text>
            ) : (
              rooms.map((r) => (
                <Box key={r.id}>
                  <Text color={r.id === activeRoomId ? 'cyan' : undefined} wrap="truncate">
                    {r.id === activeRoomId ? '▶ ' : '  '}
                    {r.name.length > sidebarWidth - 5
                      ? `${r.name.slice(0, sidebarWidth - 5)}…`
                      : r.name}
                  </Text>
                  {r.isCreator && r.pendingCount > 0 ? (
                    <Text color="yellow" bold>
                      {' '}
                      ({r.pendingCount})
                    </Text>
                  ) : null}
                  {r.admission === 'approval' ? <Text color="yellow"> ●</Text> : null}
                </Box>
              ))
            )}
          </Box>
        </Box>

        {/* Main: messages */}
        <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          minWidth={0}
        >
          <Box>
            <Text bold>{activeRoom ? `#${activeRoom.name.replace(/^#/, '')}` : '(no room)'}</Text>
            {activeRoom?.admission === 'approval' ? <Text color="yellow"> [approval]</Text> : null}
            {activeRoom?.topic ? <Text dimColor> · {activeRoom.topic}</Text> : null}
          </Box>
          <Box flexDirection="column" flexGrow={1} marginTop={1}>
            {messages.length === 0 ? (
              <Text dimColor>No messages yet. Say hi 👋</Text>
            ) : (
              messages.slice(-(rows - 8)).map((m, i) => {
                const prev = i > 0 ? messages.slice(-(rows - 8))[i - 1] : null;
                const grouped = prev && prev.sender === m.sender;
                return (
                  <Text key={m.id} wrap="wrap">
                    {!grouped ? (
                      <>
                        <Text dimColor>[{fmtTime(m.ts)}]</Text>{' '}
                        <Text color="green" bold>
                          @{m.nickname || m.sender.slice(0, 8)}
                        </Text>
                        {': '}
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
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
          >
            {pending.length > 0 ? (
              <Box flexDirection="column" marginBottom={1}>
                <Text bold color="yellow">
                  Pending · {pending.length}
                </Text>
                {pending.map((p) => (
                  <Box key={p.pubkey} flexDirection="column" marginTop={1}>
                    <Text>@{p.nickname}</Text>
                    <Text dimColor wrap="truncate">
                      {p.pubkey.slice(0, asideWidth - 4)}…
                    </Text>
                    <Text color="cyan">/approve {p.pubkey.slice(0, 8)}</Text>
                  </Box>
                ))}
              </Box>
            ) : null}
            <Text bold>
              Members {members.length > 0 ? <Text dimColor>· {members.length}</Text> : null}
            </Text>
            <Box marginTop={1} flexDirection="column">
              {members.map((m) => (
                <Text key={m.pubkey} color={m.you ? 'green' : undefined} wrap="truncate">
                  @{m.nickname || m.pubkey.slice(0, 8)}
                  {m.you ? ' (you)' : ''}
                </Text>
              ))}
            </Box>
          </Box>
        ) : null}
      </Box>

      {/* Composer */}
      <Box borderStyle="single" borderColor={activeRoomId ? 'cyan' : 'gray'} paddingX={1}>
        <Text color={activeRoomId ? 'cyan' : 'gray'}>{activeRoomId ? '›' : '…'} </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          placeholder={activeRoomId ? 'message or /help' : '/create <name>   or   /join <ticket>'}
        />
      </Box>

      {/* Status bar */}
      <Box paddingX={1} justifyContent="space-between">
        <Text dimColor>@{nickname} · ^N/^P rooms · ^H help · ^C quit</Text>
        <Text color={status.startsWith('err') ? 'red' : 'gray'}>{status}</Text>
      </Box>
    </Box>
  );
}

const HELP_TEXT = [
  'agentchat TUI commands',
  '',
  'Anything that does not start with / is sent as a message to the active room.',
  '',
  '  /create <name> [admission]  create a room. admission = open | approval',
  '  /join <ticket>              join by pasted ticket',
  '  /leave [name]               leave current or named room',
  '  /invite   /share            show the invite ticket for the current room',
  '  /copy                       copy the current ticket to clipboard',
  '  /nick <name>                change your display nickname',
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
  render(<App manager={manager} repo={repo} />);
}
