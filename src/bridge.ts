/**
 * Stdio ↔ HTTP bridge.
 * Connects to the background daemon via StreamableHTTPClientTransport and
 * pipes the MCP stdio transport through it, so that Claude Desktop or opencode
 * can talk to the aggregator without launching upstream processes themselves.
 */
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

export type BridgeOptions = {
  port: number;
  host: string;
};

export async function runBridge(opts: BridgeOptions): Promise<void> {
  const daemonUrl = new URL(`http://${opts.host}:${opts.port}/mcp`);

  const client = new Client({ name: "unimcp-bridge", version: "1.0.0" });
  const clientTransport = new StreamableHTTPClientTransport(daemonUrl);
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  console.error(`[bridge] connected to daemon — ${tools.length} tools available`);

  const server = new Server(
    { name: "unimcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await client.listTools();
    return { tools: result.tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      return await client.callTool({ name, arguments: args ?? {} });
    } catch (err) {
      throw new McpError(ErrorCode.InternalError, String(err));
    }
  });

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);

  process.on("SIGINT", async () => {
    await client.close();
    await server.close();
    process.exit(0);
  });
}
