/**
 * Tests for detectClient(), which labels a running process in the
 * "My sessions" panel. The preferred signal is MCP_CLIENT_NAME, but we
 * fall back to well-known fingerprints so Claude Code / Codex CLI /
 * cursor don't show up as "unknown" when the host doesn't cooperate
 * with the env-var protocol.
 */
import { describe, expect, it } from 'vitest';
import { detectClient } from '../src/bin/mcp-runner.js';

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  // Snapshot every var we're about to mutate, run fn, restore on exit.
  const keys = [
    'MCP_CLIENT_NAME',
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CODEX_CLI',
    'CODEX_HOME',
    'CURSOR_AGENT',
    'CURSOR_TRACE_ID',
    'TERM_PROGRAM',
    'VSCODE_PID',
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  // Clear so the starting state is deterministic regardless of the host.
  // Reflect.deleteProperty avoids Node's stringify-undefined gotcha where
  // `process.env[k] = undefined` sets the var to the literal string "undefined".
  for (const k of keys) Reflect.deleteProperty(process.env, k);
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  }
}

describe('detectClient', () => {
  it('prefers MCP_CLIENT_NAME when set', () => {
    withEnv({ MCP_CLIENT_NAME: 'bespoke-client', CLAUDECODE: '1' }, () => {
      expect(detectClient()).toBe('bespoke-client');
    });
  });

  it('recognises Claude Code via CLAUDECODE=1', () => {
    withEnv({ CLAUDECODE: '1' }, () => {
      expect(detectClient()).toBe('claude-code');
    });
  });

  it('recognises Claude Code via CLAUDE_CODE_ENTRYPOINT', () => {
    withEnv({ CLAUDE_CODE_ENTRYPOINT: 'cli' }, () => {
      expect(detectClient()).toBe('claude-code');
    });
  });

  it('recognises Codex CLI', () => {
    withEnv({ CODEX_CLI: '1' }, () => {
      expect(detectClient()).toBe('codex-cli');
    });
  });

  it('recognises Cursor', () => {
    withEnv({ CURSOR_AGENT: '1' }, () => {
      expect(detectClient()).toBe('cursor');
    });
  });

  it('recognises VSCode terminal', () => {
    withEnv({ TERM_PROGRAM: 'vscode', VSCODE_PID: '12345' }, () => {
      expect(detectClient()).toBe('vscode');
    });
  });

  it('falls back to unknown when nothing matches', () => {
    withEnv({}, () => {
      expect(detectClient()).toBe('unknown');
    });
  });
});
