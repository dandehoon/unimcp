import { ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { type Aggregator, REFRESH_WAIT_MS, SEP } from "./aggregator.js";
import type { ToolFilter } from "./config.js";
import type { SignIns } from "./sign-in.js";
import { RESERVED_SERVER_NAME } from "./utils.js";

// `unimcp__refresh`: the agent's way to recover servers and tools the daemon hasn't yet.

export const REFRESH_TOOL: Tool = {
  name: `${RESERVED_SERVER_NAME}${SEP}refresh`,
  description: "Reconnects MCP servers that are down and re-reads the tools of those connected. "
    + "Call when an expected tool is missing, a call fails with a connection error, or tools seem out of date. "
    + "Returns each server's state (a profile's as `server.profile`), why it is down, and the tools now available. "
    + `A server still connecting after ${REFRESH_WAIT_MS / 1_000} s is reported as it stands and keeps connecting: call again later. `
    + "A server that needs the user to sign in is marked `needsSignIn`; name it in `servers` to get a `signIn` url: "
    + "give it to the user as a clickable markdown link, and call again once they have approved.",
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

/** `signIns`: starts sign-ins for the servers that need one; without it none are offered. */
type RefreshCall = { aggregator: Aggregator; args: Record<string, unknown>; clientFilter?: ToolFilter; signIns?: SignIns };

export async function callRefresh({ aggregator, args, clientFilter, signIns }: RefreshCall): Promise<CallToolResult> {
  const servers = parseServers(args.servers, aggregator.listedServers());
  const statuses = await aggregator.refresh({ servers, clientFilter });
  // Only for servers named (refresh reports no others then): each sign-in holds a callback port servers may share.
  const named = servers ? statuses.filter((s) => s.needsAuth) : [];
  const links = signIns ? await signIns.links(aggregator, named.map((s) => s.name)) : new Map();
  const report = statuses.map(({ name, state, lastError, needsAuth }) => ({
    name, state, ...(state !== "connected" && lastError ? { error: lastError } : {}),
    ...(needsAuth ? { needsSignIn: true } : {}),
    ...(links.has(name) ? { signIn: links.get(name) } : {}),
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
