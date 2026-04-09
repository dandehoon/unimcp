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
import { loadConfig } from "./config.js";
import { SEP } from "./aggregator.js";

export type BridgeOptions = {
  port: number;
  host: string;
  configPath: string;
};

export async function runBridge(opts: BridgeOptions): Promise<void> {
  const daemonUrl = new URL(`http://${opts.host}:${opts.port}/mcp`);
  const clientName = process.env["UNIMCP_CLIENT"];

  const client = new Client({ name: "unimcp-bridge", version: "1.0.0" });
  const clientTransport = new StreamableHTTPClientTransport(daemonUrl, {
    requestInit: clientName ? { headers: { "x-client-name": clientName } } : undefined,
  });
  await client.connect(clientTransport);

  const initialTools = await client.listTools();
  logConnectionStatus(initialTools.tools, opts.configPath);

  const server = new Server(
    { name: "unimcp", version: "1.0.0" },
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

function logConnectionStatus(tools: Tool[], configPath: string): void {
  let configuredNames: string[] = [];
  try {
    const config = loadConfig(configPath);
    configuredNames = Object.keys(config.mcpServers);
  } catch {
    console.error(`[bridge] connected to daemon — ${tools.length} tools available`);
    return;
  }

  const connectedNames = new Set(
    tools.map((t) => t.name.slice(0, t.name.indexOf(SEP))).filter(Boolean)
  );
  const failed = configuredNames.filter((n) => !connectedNames.has(n));
  const parts = configuredNames.map((n) => (connectedNames.has(n) ? `${n}: ok` : `${n}: no tools`));
  const suffix = failed.length > 0 ? ` ⚠ ${failed.length} upstream(s) unavailable` : "";
  console.error(`[bridge] connected to daemon — ${tools.length} tools (${parts.join(", ")})${suffix}`);
}
