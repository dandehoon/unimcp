/**
 * Managed HTTP MCP server.
 * - Tries preferred port; falls back to OS-assigned port if in use.
 * - Writes "<pid>:<port>" to daemon.<envHash>.pid once bound so the bridge can find us.
 * - Tracks active sessions; auto-terminates after 30 s of idle.
 * - Watches mcp.json with chokidar; hot-reloads aggregator on change.
 */
import http from "http";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
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
const READY_TIMEOUT_MS = 60_000;
export const CONFIG_DIR = path.join(os.homedir(), ".config", "unimcp");
export type ManagedServerOptions = {
  port: number;
  host: string;
  configPath: string;
  envHash: string;
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
  const pidFile = path.join(CONFIG_DIR, `daemon.${opts.envHash}.pid`);
  let watcher: ReturnType<typeof watch> | null = null;
  let aggregator: Aggregator | null = null;
  let config: Config | null = null;
  let activeSessions = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveReady: () => void = () => {};
  const readyPromise = new Promise<void>((r) => { resolveReady = r; });
  let isShuttingDown = false;

  function scheduleShutdown() {
    if (idleTimer) return;
    idleTimer = setTimeout(() => {
      console.error("[server] no active sessions for 30 s — shutting down");
      try { unlinkSync(pidFile); } catch { /* already gone */ }
      aggregator?.disconnect().catch(() => {}).finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 5_000).unref();
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

    let transport: StreamableHTTPServerTransport | null = null;
    res.on("close", () => {
      activeSessions--;
      if (activeSessions === 0) scheduleShutdown();
      try { transport?.close(); } catch { /* not yet connected */ }
    });

    const ready = await Promise.race([
      readyPromise.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), READY_TIMEOUT_MS)),
    ]);

    if (!ready) {
      res.writeHead(503).end("Service Unavailable — upstream connections still initializing");
      return;
    }

    if (!aggregator || !config) {
      res.writeHead(503).end("Service Unavailable — upstream connections failed");
      return;
    }

    const clientName = req.headers["x-client-name"] as string | undefined;
    const clientFilter = clientName ? config.clients?.[clientName]?.tools : undefined;
    const mcpServer = buildMcpServer(aggregator, clientFilter);
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  });

  // Start listening FIRST so /health is reachable before upstream connections.
  const boundPort = await listenWithFallback(httpServer, opts.port, opts.host);

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(pidFile, `${process.pid}:${boundPort}`, "utf-8");
  console.error(`[server] listening on http://${opts.host}:${boundPort}/mcp`);

  // Connect to upstreams AFTER server is listening.
  let initializing = true;
  try {
    const initial = await buildAggregator(opts.configPath);
    aggregator = initial.aggregator;
    config = initial.config;
  } catch (err) {
    console.error("[server] initial aggregator build failed:", err);
    console.error("[server] running with 0 tools — fix config and it will hot-reload");
  } finally {
    initializing = false;
    resolveReady();
    if (activeSessions === 0) scheduleShutdown();
  }

  // Hot-reload on config change or creation
  let isReloading = false;
  const handleReload = async () => {
    if (isReloading || initializing) return;
    isReloading = true;
    console.error("[server] config changed — reloading");
    try {
      const next = await buildAggregator(opts.configPath);
      await aggregator?.disconnect();
      aggregator = next.aggregator;
      config = next.config;
      console.error(`[server] reloaded — ${aggregator.listTools().length} tools`);
    } catch (err) {
      console.error("[server] reload failed:", err);
    } finally {
      isReloading = false;
    }
  };
  watcher = watch(opts.configPath, { ignoreInitial: true });
  watcher.on("change", handleReload).on("add", handleReload);

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  async function shutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.error(`[server] ${signal} — shutting down`);
    try { unlinkSync(pidFile); } catch { /* already gone */ }
    await aggregator?.disconnect();
    await watcher?.close();
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
