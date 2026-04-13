import http from "http";
import { watch } from "chokidar";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type ToolFilter, HEADER_TOOLS_INCLUDE, HEADER_TOOLS_EXCLUDE, CONFIG_DIR, pidFilePath } from "./config.js";
import { Aggregator } from "./aggregator.js";
import { log, tryUnlink, splitCommaSeparated, writeFileSafe, PERMS_PRIVATE, MCP_SERVER_IDENTITY } from "./utils.js";

const IDLE_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 60_000;
const FORCE_EXIT_TIMEOUT_MS = 5_000;

export type ManagedServerOptions = {
  port: number;
  host: string;
  configPath: string;
  envHash: string;
};

function buildMcpServer(aggregator: Aggregator, clientFilter?: ToolFilter): Server {
  const server = new Server(
    MCP_SERVER_IDENTITY,
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
  const pidFile = pidFilePath(opts.envHash);
  let watcher: ReturnType<typeof watch> | null = null;
  let aggregator: Aggregator | null = null;
  let activeSessions = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveReady: () => void = () => {};
  const readyPromise = new Promise<void>((r) => { resolveReady = r; });
  let isShuttingDown = false;

  function scheduleShutdown() {
    if (idleTimer) return;
    idleTimer = setTimeout(() => {
      log(`[server] no active sessions for ${IDLE_TIMEOUT_MS / 1_000} s — shutting down`);
      tryUnlink(pidFile);
      aggregator?.disconnect().catch(() => {}).finally(() => process.exit(0));
      setTimeout(() => process.exit(0), FORCE_EXIT_TIMEOUT_MS).unref();
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

    // Only SSE GET streams indicate a connected client; POST requests are individual tool calls.
    // Bun fires req.on("close") at request-body-end (not TCP close), so for POSTs it fires
    // immediately — before the response is written. Counting POSTs would decrement activeSessions
    // to 0 after every tool call and arm the shutdown timer mid-flight, AND calling
    // transport?.close() on a POST tears down the transport while the response is still being sent.
    const isSession = req.method === "GET";
    if (isSession) {
      activeSessions++;
      cancelShutdown();
    }

    let transport: StreamableHTTPServerTransport | null = null;
    // Use req.on("close") instead of res.on("close") — Bun does not fire res close events.
    req.on("close", () => {
      if (isSession) {
        activeSessions--;
        if (activeSessions === 0) scheduleShutdown();
        try { transport?.close(); } catch { /* not yet connected */ }
      }
    });

    let readyTimer!: ReturnType<typeof setTimeout>;
    const ready = await Promise.race([
      readyPromise.then(() => true),
      new Promise<false>((r) => { readyTimer = setTimeout(() => r(false), READY_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(readyTimer));

    if (!ready) {
      res.writeHead(503).end("Service Unavailable — upstream connections still initializing");
      return;
    }

    if (!aggregator) {
      res.writeHead(503).end("Service Unavailable — upstream connections failed");
      return;
    }

    const clientFilter = parseToolFilterHeaders(req);
    const mcpServer = buildMcpServer(aggregator, clientFilter);
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  });

  const boundPort = await listenWithFallback(httpServer, opts.port, opts.host);

  writeFileSafe(pidFile, `${process.pid}:${boundPort}`, PERMS_PRIVATE);
  log(`[server] listening on http://${opts.host}:${boundPort}/mcp`);

  let initializing = true;
  try {
    const initial = await buildAggregator(opts.configPath);
    aggregator = initial.aggregator;
  } catch (err) {
    log("[server] initial aggregator build failed:", String(err));
    log("[server] running with 0 tools — fix config and it will hot-reload");
    aggregator = new Aggregator();
  } finally {
    initializing = false;
    resolveReady();
    if (activeSessions === 0) scheduleShutdown();
  }

  let isReloading = false;
  const handleReload = async () => {
    if (isReloading || initializing) return;
    isReloading = true;
    log("[server] config changed — reloading");
    try {
      const next = await buildAggregator(opts.configPath);
      // Swap reference first so new requests hit the fresh aggregator immediately,
      // then tear down the old one (eliminates race window and simultaneous live connections).
      const old = aggregator;
      aggregator = next.aggregator;
      log(`[server] reloaded — ${next.toolCount} tools`);
      await old?.disconnect();
    } catch (err) {
      log("[server] reload failed:", String(err));
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
    log(`[server] ${signal} — shutting down`);
    tryUnlink(pidFile);
    await aggregator?.disconnect();
    await watcher?.close();
    httpServer.close();
    process.exit(0);
  }
}

// --- helpers ---

async function buildAggregator(configPath: string): Promise<{ aggregator: Aggregator; toolCount: number }> {
  const config = loadConfig(configPath);
  const aggregator = new Aggregator();
  await aggregator.connect(config);
  const toolCount = aggregator.listTools().length;
  log(`[server] ${toolCount} tools ready`);
  return { aggregator, toolCount };
}

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
      log(`[server] port ${preferredPort} in use — using OS-assigned port`);
      server.listen(0, host, () => {
        resolve((server.address() as { port: number }).port);
      });
    });
  });
}

function parseToolFilterHeaders(req: http.IncomingMessage): ToolFilter | undefined {
  const include = req.headers[HEADER_TOOLS_INCLUDE] as string | undefined;
  const exclude = req.headers[HEADER_TOOLS_EXCLUDE] as string | undefined;
  if (!include && !exclude) return undefined;
  const filter: ToolFilter = {};
  if (include) filter.include = splitCommaSeparated(include);
  if (exclude) filter.exclude = splitCommaSeparated(exclude);
  return filter;
}
