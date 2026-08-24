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
import { loadRawConfig, missingEnvVars, HEADER_TOOLS_INCLUDE, HEADER_TOOLS_EXCLUDE } from "./config.js";
import { SEP } from "./aggregator.js";
import { ensureDaemon } from "./daemon.js";
import { log, MCP_SERVER_IDENTITY } from "./utils.js";

export type BridgeOptions = {
  port: number;
  host: string;
  configPath: string;
  envHash: string;
};

const RECONNECT_COOLDOWN_MS = 5_000;
const TRANSPORT_ERROR_PATTERNS = [
  "econnrefused", "econnreset", "epipe", "timed out", "fetch failed",
  "unable to connect", "socket hang up", "network error",
  "session not found", "no valid session", "session-id header is required", "server not initialized",
];

export async function runBridge(opts: BridgeOptions): Promise<void> {
  let daemonUrl = new URL(`http://${opts.host}:${opts.port}/mcp`);
  const headers = buildFilterHeaders();

  let client = await createClient(daemonUrl, headers);
  let lastReconnectAt = 0;

  const initialTools = await client.listTools();
  logConnectionStatus(initialTools.tools, opts.configPath);

  async function reconnect(): Promise<void> {
    const now = Date.now();
    if (now - lastReconnectAt < RECONNECT_COOLDOWN_MS) {
      throw new Error("[bridge] reconnect cooldown — skipping");
    }
    lastReconnectAt = now;
    log("[bridge] attempting reconnect to daemon...");
    client.close().catch((err) => log("[bridge] old client close error:", String(err)));
    try {
      client = await createClient(daemonUrl, headers);
      log("[bridge] reconnected successfully");
    } catch {
      // Daemon is likely dead — attempt re-spawn
      log("[bridge] daemon unreachable — re-spawning...");
      const newPort = await ensureDaemon({ port: opts.port, host: opts.host, configPath: opts.configPath, envHash: opts.envHash });
      daemonUrl = new URL(`http://${opts.host}:${newPort}/mcp`);
      client = await createClient(daemonUrl, headers);
      log(`[bridge] daemon re-spawned on port ${newPort}`);
    }
  }

  async function withReconnect<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof McpError) throw err;
      if (!isTransportError(err)) throw err;
      await reconnect();
      return await fn();
    }
  }

  const server = new Server(
    MCP_SERVER_IDENTITY,
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const result = await withReconnect(() => client.listTools());
      return { tools: result.tools };
    } catch (err) {
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, `[bridge] listTools failed: ${String(err)}`);
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      return await withReconnect(() => client.callTool({ name, arguments: args ?? {} }));
    } catch (err) {
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
    client.close().catch((err) => log("[bridge] close error:", String(err)));
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

// --- helpers ---

async function createClient(
  daemonUrl: URL,
  headers: Record<string, string> | undefined,
): Promise<Client> {
  const client = new Client({ name: "unimcp-bridge", version: MCP_SERVER_IDENTITY.version });
  const transport = new StreamableHTTPClientTransport(daemonUrl, {
    requestInit: headers ? { headers } : undefined,
  });
  await client.connect(transport);
  return client;
}

function isTransportError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return TRANSPORT_ERROR_PATTERNS.some((p) => msg.includes(p));
}

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
  let configured: { name: string; missing: string[] }[];
  try {
    const config = loadRawConfig(configPath);
    configured = Object.entries(config.mcpServers)
      .filter(([_n, srv]) => srv.enabled !== false)
      .map(([name, srv]) => ({ name, missing: missingEnvVars(srv) }));
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
  const parts = configured.map(({ name, missing }) => {
    if (missing.length > 0) {
      failedCount++;
      return `${name}: missing env ${missing.join(",")}`;
    }
    if (connectedNames.has(name)) return `${name}: ok`;
    failedCount++;
    return `${name}: no tools`;
  });
  const suffix = failedCount > 0 ? ` ⚠ ${failedCount} upstream(s) unavailable` : "";
  log(`[bridge] connected to daemon — ${tools.length} tools (${parts.join(", ")})${suffix}`);
}
