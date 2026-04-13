import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, HEADER_TOOLS_INCLUDE, HEADER_TOOLS_EXCLUDE } from "./config.js";
import { SEP } from "./aggregator.js";
import { log, MCP_SERVER_IDENTITY } from "./utils.js";

export type BridgeOptions = {
  port: number;
  host: string;
  configPath: string;
};

export async function runBridge(opts: BridgeOptions): Promise<void> {
  const daemonUrl = new URL(`http://${opts.host}:${opts.port}/mcp`);
  const headers = buildFilterHeaders();

  const client = new Client({ name: "unimcp-bridge", version: MCP_SERVER_IDENTITY.version });
  const clientTransport = new StreamableHTTPClientTransport(daemonUrl, {
    requestInit: headers ? { headers } : undefined,
  });
  await client.connect(clientTransport);

  const initialTools = await client.listTools();
  logConnectionStatus(initialTools.tools, opts.configPath);

  const server = new Server(
    MCP_SERVER_IDENTITY,
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const result = await client.listTools();
      return { tools: result.tools };
    } catch (err) {
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, `[bridge] listTools failed: ${String(err)}`);
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      return await client.callTool({ name, arguments: args ?? {} });
    } catch (err) {
      // Preserve upstream error codes (e.g. InvalidParams) rather than flattening to InternalError.
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, `[bridge] callTool failed: ${String(err)}`);
    }
  });

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);

  let exiting = false;

  function shutdown(): void {
    if (exiting) return;
    exiting = true;
    client.close().catch(() => {});
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

// --- helpers ---

function buildFilterHeaders(): Record<string, string> | undefined {
  const include = process.env["UNIMCP_INCLUDE"];
  const exclude = process.env["UNIMCP_EXCLUDE"];
  if (!include && !exclude) return undefined;
  const headers: Record<string, string> = {};
  if (include) headers[HEADER_TOOLS_INCLUDE] = include;
  if (exclude) headers[HEADER_TOOLS_EXCLUDE] = exclude;
  return headers;
}

function logConnectionStatus(tools: Tool[], configPath: string): void {
  let configuredNames: string[];
  try {
    const config = loadConfig(configPath);
    configuredNames = Object.entries(config.mcpServers)
      .filter(([_n, srv]) => srv.enabled !== false)
      .map(([name]) => name);
  } catch {
    log(`[bridge] connected to daemon — ${tools.length} tools available`);
    return;
  }

  const connectedNames = new Set<string>();
  for (const t of tools) {
    const idx = t.name.indexOf(SEP);
    if (idx > 0) connectedNames.add(t.name.slice(0, idx));
  }

  let failedCount = 0;
  const parts = configuredNames.map((n) => {
    if (connectedNames.has(n)) return `${n}: ok`;
    failedCount++;
    return `${n}: no tools`;
  });
  const suffix = failedCount > 0 ? ` ⚠ ${failedCount} upstream(s) unavailable` : "";
  log(`[bridge] connected to daemon — ${tools.length} tools (${parts.join(", ")})${suffix}`);
}
