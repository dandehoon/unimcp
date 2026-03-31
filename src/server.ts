/**
 * Managed HTTP MCP server.
 * - Tries preferred port; falls back to OS-assigned port if in use.
 * - Writes "<pid>:<port>" to PID_FILE once bound so the bridge can find us.
 * - Tracks active sessions; auto-terminates after 30 s of idle.
 * - Watches mcp.json with chokidar; hot-reloads aggregator on change.
 */
import http from "http";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import { watch } from "chokidar";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type Config, type ToolFilter } from "./config.js";
import { Aggregator } from "./aggregator.js";

const IDLE_TIMEOUT_MS = 30_000;
export const CONFIG_DIR = path.join(os.homedir(), ".config", "unimcp");
export const PID_FILE = path.join(CONFIG_DIR, "daemon.pid");

export type ManagedServerOptions = {
  port: number;
  host: string;
  configPath: string;
};

function buildMcpServer(aggregator: Aggregator, clientFilter?: ToolFilter): Server {
  const server = new Server(
    { name: "unimcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: aggregator.listTools(clientFilter).map(({ upstreamName: _u, originalName: _o, ...tool }) => tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      return await aggregator.callTool(name, args ?? {});
    } catch (err) {
      throw new McpError(ErrorCode.InternalError, String(err));
    }
  });

  return server;
}

export async function startManagedServer(opts: ManagedServerOptions): Promise<void> {
  let { aggregator, config } = await buildAggregator(opts.configPath);
  let activeSessions = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleShutdown() {
    if (idleTimer) return;
    idleTimer = setTimeout(() => {
      console.error("[server] no active sessions for 30 s — shutting down");
      process.exit(0);
    }, IDLE_TIMEOUT_MS);
  }

  function cancelShutdown() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  const httpServer = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200).end("ok");
      return;
    }

    if (req.url !== "/mcp") {
      res.writeHead(404).end("Not found");
      return;
    }

    activeSessions++;
    cancelShutdown();

    const clientName = req.headers["x-client-name"] as string | undefined;
    const clientFilter = clientName ? config.clients?.[clientName]?.tools : undefined;
    const mcpServer = buildMcpServer(aggregator, clientFilter);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => {
      activeSessions--;
      if (activeSessions === 0) scheduleShutdown();
      transport.close();
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  });

  // Try preferred port; fall back to OS-assigned if in use.
  const boundPort = await listenWithFallback(httpServer, opts.port, opts.host);

  // Announce actual port so bridge and daemon can discover it.
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(PID_FILE, `${process.pid}:${boundPort}`, "utf-8");
  console.error(`[server] listening on http://${opts.host}:${boundPort}/mcp`);

  // Start idle timer; cancelled when first client connects.
  scheduleShutdown();

  // Hot-reload on config change
  let isReloading = false;
  watch(opts.configPath, { ignoreInitial: true }).on("change", async () => {
    if (isReloading) return;
    isReloading = true;
    console.error("[server] config changed — reloading");
    try {
      const next = await buildAggregator(opts.configPath);
      await aggregator.disconnect();
      aggregator = next.aggregator;
      config = next.config;
      console.error(`[server] reloaded — ${aggregator.listTools().length} tools`);
    } catch (err) {
      console.error("[server] reload failed:", err);
    } finally {
      isReloading = false;
    }
  });

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  async function shutdown(signal: string) {
    console.error(`[server] ${signal} — shutting down`);
    await aggregator.disconnect();
    httpServer.close();
    process.exit(0);
  }
}

// --- helpers ---

async function buildAggregator(configPath: string): Promise<{ aggregator: Aggregator; config: Config }> {
  const config = loadConfig(configPath);
  const aggregator = new Aggregator();
  await aggregator.connect(config);
  console.error(`[server] ${aggregator.listTools().length} tools ready`);
  return { aggregator, config };
}

/** Tries to listen on preferredPort; if EADDRINUSE, falls back to port 0 (OS-assigned). */
function listenWithFallback(
  server: http.Server,
  preferredPort: number,
  host: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(preferredPort, host, () => {
      resolve((server.address() as { port: number }).port);
    });

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EADDRINUSE") {
        reject(err);
        return;
      }
      console.error(`[server] port ${preferredPort} in use — using OS-assigned port`);
      server.listen(0, host, () => {
        resolve((server.address() as { port: number }).port);
      });
    });
  });
}
