import { ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { type Aggregator, REFRESH_WAIT_MS, SEP } from "./aggregator.js";
import type { ToolFilter } from "./config.js";
import { RESERVED_SERVER_NAME } from "./utils.js";

// `unimcp__refresh`: the agent's way to recover servers and tools the daemon hasn't yet.

export const REFRESH_TOOL: Tool = {
  name: `${RESERVED_SERVER_NAME}${SEP}refresh`,
  description: "Reconnects MCP servers that are down and re-reads the tools of those connected. "
    + "Call when an expected tool is missing, a call fails with a connection error, or tools seem out of date. "
    + "Returns each server's state (a profile's as `server.profile`), why it is down, and the tools now available. "
    + `A server still connecting after ${REFRESH_WAIT_MS / 1_000} s is reported as it stands and keeps connecting: call again later.`,
  inputSchema: {
    type: "object",
    properties: {
      servers: {
        type: "array",
        items: { type: "string" },
        description: `Servers to refresh: the part of a tool name before "${SEP}". All when omitted or empty.`,
      },
    },
  },
};

type RefreshCall = { aggregator: Aggregator; args: Record<string, unknown>; clientFilter?: ToolFilter };

export async function callRefresh({ aggregator, args, clientFilter }: RefreshCall): Promise<CallToolResult> {
  const servers = parseServers(args.servers, aggregator.listedServers());
  const statuses = await aggregator.refresh({ servers, clientFilter });
  const report = statuses.map(({ name, state, lastError }) => ({
    name, state, ...(state !== "connected" && lastError ? { error: lastError } : {}),
  }));
  const tools = aggregator.listTools(clientFilter)
    .filter((t) => !servers || servers.includes(t.upstreamName)).map((t) => t.name);
  return { content: [{ type: "text", text: JSON.stringify({ servers: report, tools }) }] };
}

// --- helpers ---

function parseServers(value: unknown, known: string[]): string[] | undefined {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new McpError(ErrorCode.InvalidParams, "'servers' must be a list of server names");
  }
  const unknown = value.filter((v) => !known.includes(v));
  if (unknown.length) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown server(s): ${unknown.join(", ")}. Known: ${known.join(", ")}`);
  }
  return value;
}
