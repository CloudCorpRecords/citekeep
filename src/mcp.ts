/**
 * citekeep MCP server. Tools: the 5 kept Koskamo tools
 * (labelled subset; see forward.ts).
 *
 * This file uses the low-level Server API rather than
 * McpServer: the high-level helper rebuilds schemas from
 * zod and rewrites what is served, which would break
 * exact parity with the captured tools/list. Here
 * tools/list is answered locally from the core's literal
 * definitions and every tools/call is forwarded upstream.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createClient,
  isKnownTool,
  TOOL_DEFS,
  VERSION,
  type CitekeepClient,
} from "./forward.js";
import type { ForwardDeps, ToolResult } from "./types.js";

export async function handleCallTool(
  client: CitekeepClient,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  if (!isKnownTool(name)) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
  if (
    args !== undefined &&
    (typeof args !== "object" || args === null || Array.isArray(args))
  ) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Arguments for tool ${name} must be a JSON object`,
    );
  }
  return client.callTool(name, (args ?? {}) as Record<string, unknown>);
}

export function createServer(deps: ForwardDeps = {}): Server {
  const client = createClient(deps);
  const server = new Server(
    { name: "citekeep", version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await handleCallTool(client, name, args);
    return result as never;
  });
  return server;
}

export async function startMcpServer(deps: ForwardDeps = {}): Promise<void> {
  await createServer(deps).connect(new StdioServerTransport());
}
