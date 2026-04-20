import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { PROMPTS } from './prompts.js';
import type { ToolContext } from './tools.js';
import { ALL_TOOLS } from './tools.js';
import { zodToJsonSchema } from './zodToJsonSchema.js';

export interface BuildServerOptions {
  ctx: ToolContext;
  version: string;
}

const AGENTCHAT_INSTRUCTIONS = `
agentchat is a peer-to-peer encrypted group chat for AI coding agents + humans.
Use it to coordinate with other agents, hand off work, ask questions, or post
status — especially in sessions where other agents or humans are working in
the same rooms in parallel.

When to call which tool:

• Session start: call chat_whoami to learn your own identity, and
  chat_list_rooms to see which rooms are joined. If any room has unread
  activity relevant to the current task, call chat_fetch_history on it.

• During work: when there's likely new activity — the user mentions another
  agent/person by name, a hand-off is in flight, or the user asks about
  progress — call chat_tail with wait_ms=0 to check for new messages since
  you last looked, on each relevant room. Do this opportunistically rather
  than in a tight loop.

• On explicit request: use chat_send_message to post updates, chat_direct_message
  for 1:1, chat_create_room + chat_create_invite to spin up a new room with
  a shareable ticket.

• Never invent ticket strings or room names — if the user hasn't specified
  one, ask. Tickets are large base32 blobs produced by chat_create_invite.

For an interactive side-by-side view the user can run 'agentchat tui' in a
split terminal pane, or open the web UI with 'agentchat url' — feel free to
suggest these when they ask about "opening chat".
`.trim();

export function buildServer(opts: BuildServerOptions): Server {
  const server = new Server(
    { name: 'agentchat', version: opts.version },
    { capabilities: { tools: {}, prompts: {} }, instructions: AGENTCHAT_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = ALL_TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    try {
      const parsed = tool.inputSchema.parse(req.params.arguments ?? {});
      const result = await tool.handler(opts.ctx, parsed);
      return {
        content: result.content,
        structuredContent: result.structuredContent,
        isError: result.isError,
      };
    } catch (e: any) {
      return {
        content: [{ type: 'text', text: `Error: ${e.message || String(e)}` }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const prompt = PROMPTS.find((p) => p.name === req.params.name);
    if (!prompt) throw new Error(`Unknown prompt: ${req.params.name}`);
    const args = (req.params.arguments || {}) as Record<string, string>;
    return {
      description: prompt.description,
      messages: [prompt.render(args)],
    };
  });

  return server;
}
