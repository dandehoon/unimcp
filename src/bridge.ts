import { Client, ProtocolError, ProtocolErrorCode, StreamableHTTPClientTransport, type Tool } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadRawConfig, missingEnvVars, HEADER_TOOLS_INCLUDE, HEADER_TOOLS_EXCLUDE, HEADER_TOOLS_GRANTS } from "./config.js";
import { SEP } from "./aggregator.js";
import { CONTENT_CAPABILITIES, forwardContent } from "./content.js";
import { ensureDaemon } from "./daemon.js";
import { heldGrants, watchGrantsFiles } from "./grants.js";
import { REFRESH_TOOL } from "./refresh.js";
import { clientGrantsPath, isOwnGrantsFile, processStartMs } from "./client-grants.js";
import { isTimeout } from "./transport.js";
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
  let headers = buildFilterHeaders();

  const server = new Server(
    MCP_SERVER_IDENTITY,
    { capabilities: { tools: { listChanged: true }, ...CONTENT_CAPABILITIES } }
  );
  // The daemon says when an upstream's tools or resources appear or change, e.g. a server back after an outage.
  const onToolsChanged = () => {
    server.sendToolListChanged().catch((err) => log("[bridge] tools/list_changed failed:", String(err)));
  };
  const onResourcesChanged = () => {
    server.sendResourceListChanged().catch((err) => log("[bridge] resources/list_changed failed:", String(err)));
  };
  const notices = { onToolsChanged, onResourcesChanged };

  let client = await createClient({ url: daemonUrl, headers, notices });
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
    try {
      await switchClient(daemonUrl);
      log("[bridge] reconnected successfully");
    } catch {
      // Daemon is likely dead — attempt re-spawn
      log("[bridge] daemon unreachable — re-spawning...");
      const newPort = await ensureDaemon({ port: opts.port, host: opts.host, configPath: opts.configPath, envHash: opts.envHash });
      await switchClient(new URL(`http://${opts.host}:${newPort}/mcp`));
      log(`[bridge] daemon re-spawned on port ${newPort}`);
      // A fresh daemon connected its upstreams anew: which are up may differ from what the client listed.
      onToolsChanged();
      onResourcesChanged();
    }
  }

  /** Connects with the grants held right now, so no reconnect can resurrect a revoked one. */
  async function switchClient(url: URL): Promise<void> {
    const next = buildFilterHeaders();
    const fresh = await createClient({ url, headers: next, notices });
    const old = client;
    client = fresh;
    daemonUrl = url;
    old.close().catch((err) => log("[bridge] old client close error:", String(err)));
    if (JSON.stringify(next) === JSON.stringify(headers)) return;
    headers = next;
    await Promise.all([server.sendToolListChanged(), server.sendResourceListChanged()]);
    log("[bridge] grants changed — tool and resource lists refreshed");
  }

  // A grant added or revoked mid-session changes which tools this client may see. Every request
  // re-checks the grants before it runs, so a missed or failed file event can't leave a revoked
  // grant in use; the watcher only makes the client re-list promptly.
  async function syncGrants(): Promise<void> {
    if (JSON.stringify(buildFilterHeaders()) !== JSON.stringify(headers)) await switchClient(daemonUrl);
  }

  // Client switches run one at a time, so a burst of events can't land an older client last.
  let queue = Promise.resolve();
  function serialized(fn: () => Promise<void>): Promise<void> {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  async function withReconnect<T>(fn: () => Promise<T>): Promise<T> {
    try {
      await serialized(syncGrants);
      return await fn();
    } catch (err) {
      // The daemon's own answer, or a request that timed out and may still be running: neither is safe to send again.
      if (err instanceof ProtocolError || isTimeout(err) || !isTransportError(err)) throw err;
      await serialized(reconnect);
      return await fn();
    }
  }

  /** Sends a request on to the daemon; any failure but the daemon's own protocol error is wrapped, naming the request. */
  async function forward<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await withReconnect(fn);
    } catch (err) {
      if (err instanceof ProtocolError) throw err;
      throw new ProtocolError(ProtocolErrorCode.InternalError, `[bridge] ${what} failed: ${String(err)}`);
    }
  }

  server.setRequestHandler("tools/list", async () => ({ tools: (await forward("listTools", () => client.listTools())).tools }));
  server.setRequestHandler("tools/call", (req) => {
    const { name, arguments: args } = req.params;
    return forward("callTool", () => client.callTool({ name, arguments: args ?? {} }));
  });
  forwardContent(server, (run) => forward("request", () => run(client)));

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);

  const closeWatcher = watchGrantsFiles(grantsFiles(true), () => {
    serialized(syncGrants).catch((err) => log("[bridge] grant refresh failed:", String(err)));
  });

  let exiting = false;

  function shutdown(): void {
    if (exiting) return;
    exiting = true;
    void closeWatcher();
    client.close().catch((err) => log("[bridge] close error:", String(err)));
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

// --- helpers ---

type DaemonClientOptions = {
  url: URL;
  headers: Record<string, string> | undefined;
  notices: { onToolsChanged: () => void; onResourcesChanged: () => void };
};

async function createClient({ url, headers, notices }: DaemonClientOptions): Promise<Client> {
  const client = new Client({ name: "unimcp-bridge", version: MCP_SERVER_IDENTITY.version });
  client.setNotificationHandler("notifications/tools/list_changed", notices.onToolsChanged);
  client.setNotificationHandler("notifications/resources/list_changed", notices.onResourcesChanged);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: headers ? { headers } : undefined,
  });
  await client.connect(transport);
  return client;
}

function isTransportError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return TRANSPORT_ERROR_PATTERNS.some((p) => msg.includes(p));
}

let clientStartMs: number | undefined | null = null;

/** The client's start time, looked up once per bridge. */
function clientStart(): number | undefined {
  if (clientStartMs !== null) return clientStartMs;
  clientStartMs = processStartMs(process.ppid);
  if (clientStartMs === undefined) log("[bridge] client start time unknown — trusting its grants file as is");
  return clientStartMs;
}

/**
 * `UNIMCP_GRANTS_FILE`, plus the file `unimcp grant` keeps for the client (this bridge's
 * parent) — to watch, or to read, which skips a client file left by an earlier holder of the pid.
 */
function grantsFiles(toWatch = false): string[] {
  const file = process.env["UNIMCP_GRANTS_FILE"];
  const client = clientGrantsPath(process.ppid);
  const start = toWatch ? undefined : clientStart();
  const own = start === undefined || isOwnGrantsFile(client, start);
  return [...(file ? [file] : []), ...(own ? [client] : [])];
}

function buildFilterHeaders(): Record<string, string> | undefined {
  const include = process.env["UNIMCP_INCLUDE"];
  const exclude = process.env["UNIMCP_EXCLUDE"];
  const grants = [...heldGrants(process.env["UNIMCP_GRANTS"], grantsFiles())].join(",");
  if (!include && !exclude && !grants) return undefined;
  const headers: Record<string, string> = {};
  if (include) headers[HEADER_TOOLS_INCLUDE] = include;
  if (exclude) headers[HEADER_TOOLS_EXCLUDE] = exclude;
  if (grants) headers[HEADER_TOOLS_GRANTS] = grants;
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
  const upstreamTools = tools.filter((t) => t.name !== REFRESH_TOOL.name);
  for (const t of upstreamTools) {
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
  log(`[bridge] connected to daemon — ${upstreamTools.length} tools (${parts.join(", ")})${suffix}`);
}
