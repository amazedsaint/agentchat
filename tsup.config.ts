import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'bin/agentchat': 'src/bin/agentchat.ts',
    'bin/agentchat-mcp': 'src/bin/agentchat-mcp.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  splitting: false,
  dts: false,
  shims: true,
  banner: { js: '#!/usr/bin/env node' },
  external: ['better-sqlite3', 'hyperswarm', 'electron'],
});
