import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Minimatch } from "minimatch";
import { type Config, type ServerConfig, type ToolFilter, isHttpServer, isSseServer, isOAuthServer } from "./config.js";
import { lockedPatterns } from "./grants.js";
import { AuthRequiredError, FileOAuthProvider } from "./oauth.js";
import { log, VERSION } from "./utils.js";

export const SEP = "__";
const CLIENT_NAME = "unimcp";
const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

export type UpstreamState = "connected" | "failed" | "reconnecting" | "disconnected";

export type UpstreamStatus = {
  name: string;
  state: UpstreamState;
  toolCount: number;
  connectedAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  reconnectAttempts: number;
};

type UpstreamEntry = {
  name: string;
  client: Client;
  tools: Tool[];
  config: ServerConfig;
  state: UpstreamState;
  connectedAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  reconnectAttempts: number;
};

type AggregatedTool = Tool & { upstreamName: string; originalName: string };

const MATCH_ALL = [new Minimatch("*", { dot: true })];
const MATCH_NONE: Minimatch[] = [];
const patternCache = new Map<string, Minimatch[]>();
// Patterns are literal globs: no `!` negation (which would invert a grant lock) and no `#` comments.
const PATTERN_OPTS = { nonegate: true, nocomment: true, dot: true };

function compilePatterns(patterns: string[]): Minimatch[] {
  const key = patterns.join("\0");
  let compiled = patternCache.get(key);
  if (!compiled) {
    compiled = patterns.map((p) => new Minimatch(p, PATTERN_OPTS));
    patternCache.set(key, compiled);
  }
  return compiled;
}

/** Checks whether a bare tool name passes a filter. */
export function matchesFilter(toolName: string, filter?: ToolFilter): boolean {
  const include = filter?.include ? compilePatterns(filter.include) : MATCH_ALL;
  const exclude = filter?.exclude ? compilePatterns(filter.exclude) : MATCH_NONE;
  return include.some((m) => m.match(toolName)) && !exclude.some((m) => m.match(toolName));
}

export class Aggregator {
  private upstreams: Map<string, UpstreamEntry> = new Map();
  private toolCache: AggregatedTool[] | null = null;
  private clientFilterCache = new Map<string, AggregatedTool[]>();
  private grants: Record<string, string[]> = {};
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingReconnects = new Map<string, Promise<void>>();

  async connect(config: Config): Promise<void> {
    this.grants = config.grants ?? {};
    const entries = Object.entries(config.mcpServers).filter(([_, srv]) => srv.enabled !== false);
    await Promise.all(entries.map(([name, srv]) => this.connectOne(name, srv)));
  }

  private async connectOne(name: string, srv: ServerConfig): Promise<void> {
    if (name.includes(SEP)) {
      log(`[${name}] server name must not contain "${SEP}" — skipped`);
      return;
    }

    try {
      const result = await this.connectClient(name, srv);
      const filtered = result.tools.filter((t) => matchesFilter(t.name, serverFilter(srv)));
      this.upstreams.set(name, {
        name, client: result.client, tools: filtered, config: srv,
        state: "connected", connectedAt: Date.now(),
        lastError: null, lastErrorAt: null, reconnectAttempts: 0,
      });
      this.setupErrorHandler(name, result.client);
      log(`[${name}] connected (${filtered.length} tools)`);
    } catch (err) {
      log(`[${name}] failed to connect:`, err);
      this.upstreams.set(name, {
        name, client: new Client({ name: CLIENT_NAME, version: VERSION }), tools: [], config: srv,
        state: "failed", connectedAt: null,
        lastError: String(err), lastErrorAt: Date.now(), reconnectAttempts: 0,
      });
      // Retrying can't help until the user authorizes; retryIfDown picks up their new tokens.
      if (!(err instanceof AuthRequiredError)) this.scheduleReconnect(name);
    }
  }

  private setupErrorHandler(name: string, client: Client): void {
    client.onerror = () => this.scheduleReconnect(name);
    client.onclose = () => {
      const entry = this.upstreams.get(name);
      if (entry && entry.state === "connected") this.scheduleReconnect(name);
    };
  }

  private scheduleReconnect(name: string): void {
    const entry = this.upstreams.get(name);
    if (!entry || entry.state === "reconnecting" || entry.state === "disconnected") return;
    if (entry.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      entry.state = "failed";
      return;
    }
    entry.state = "reconnecting";
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** entry.reconnectAttempts, BACKOFF_CAP_MS);
    entry.reconnectAttempts++;
    const timer = setTimeout(() => void this.track(name, () => this.attemptReconnect(name)), delay);
    this.reconnectTimers.set(name, timer);
  }

  private async attemptReconnect(name: string): Promise<void> {
    this.reconnectTimers.delete(name);
    const entry = this.upstreams.get(name);
    if (!entry || entry.state === "disconnected") return;

    try {
      const result = await this.connectClient(name, entry.config);
      const filtered = result.tools.filter((t) => matchesFilter(t.name, serverFilter(entry.config)));
      entry.client = result.client;
      entry.tools = filtered;
      entry.state = "connected";
      entry.connectedAt = Date.now();
      entry.reconnectAttempts = 0;
      this.invalidateCache();
      this.setupErrorHandler(name, result.client);
      log(`[${name}] reconnected (${filtered.length} tools)`);
    } catch (err) {
      entry.lastError = String(err);
      entry.lastErrorAt = Date.now();
      if (entry.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS || err instanceof AuthRequiredError) {
        entry.state = "failed";
        log(`[${name}] reconnect failed permanently:`, err);
      } else {
        entry.state = "failed";
        this.scheduleReconnect(name);
      }
    }
  }

  private invalidateCache(): void {
    this.toolCache = null;
    this.clientFilterCache.clear();
  }

  private buildToolCache(): AggregatedTool[] {
    return [...this.upstreams.values()].flatMap(({ name, tools }) =>
      tools.map((t) => ({
        ...t,
        name: `${name}${SEP}${t.name}`,
        upstreamName: name,
        originalName: t.name,
      }))
    );
  }

  listTools(clientFilter?: ToolFilter): AggregatedTool[] {
    if (!this.toolCache) {
      this.toolCache = this.buildToolCache();
      this.clientFilterCache.clear();
    }
    // Grant locks are the daemon's to apply: a client that sends no grants holds none.
    const locked = lockedPatterns(this.grants, new Set(clientFilter?.grants));
    if (!clientFilter?.include && !clientFilter?.exclude && !locked.length) return this.toolCache;
    const key = JSON.stringify([clientFilter?.include, clientFilter?.exclude, locked]);
    let cached = this.clientFilterCache.get(key);
    if (!cached) {
      cached = this.toolCache.filter((t) => isVisibleToClient({ tool: t, clientFilter, locked }));
      this.clientFilterCache.set(key, cached);
    }
    return cached;
  }

  /** Whether a client may call a tool, judged by name: a server that is down lists no tools, yet calling one must still reach callTool's reconnect. */
  isCallable(prefixedName: string, clientFilter?: ToolFilter): boolean {
    const sep = prefixedName.indexOf(SEP);
    const entry = sep > 0 ? this.upstreams.get(prefixedName.slice(0, sep)) : undefined;
    if (!entry) return false;
    const tool = { name: prefixedName, originalName: prefixedName.slice(sep + SEP.length) };
    const locked = lockedPatterns(this.grants, new Set(clientFilter?.grants));
    return matchesFilter(tool.originalName, serverFilter(entry.config)) && isVisibleToClient({ tool, clientFilter, locked });
  }

  async callTool(prefixedName: string, args: Record<string, unknown>): Promise<ReturnType<Client["callTool"]>> {
    const sep = prefixedName.indexOf(SEP);
    if (sep === -1) throw new Error(`Invalid tool name (missing separator): ${prefixedName}`);
    const upstreamName = prefixedName.slice(0, sep);
    const toolName = prefixedName.slice(sep + SEP.length);

    const upstream = this.upstreams.get(upstreamName);
    if (!upstream) throw new Error(`Unknown upstream: ${upstreamName}`);
    if (upstream.state !== "connected") {
      await this.onDemandReconnect(upstreamName, upstream);
      if ((upstream as UpstreamEntry).state !== "connected") {
        throw new Error(`Upstream ${upstreamName} is ${upstream.state} (reconnect failed)`);
      }
    }

    try {
      return await withTimeout(
        upstream.client.callTool({ name: toolName, arguments: args }),
        CALL_TIMEOUT_MS,
        `[${upstreamName}] callTool timed out`,
      );
    } catch (err) {
      if (isTransportError(err)) {
        upstream.state = "failed";
        upstream.lastError = String(err);
        upstream.lastErrorAt = Date.now();
        this.invalidateCache();
        this.scheduleReconnect(upstreamName);
      }
      throw err;
    }
  }

  getStatus(): UpstreamStatus[] {
    return [...this.upstreams.values()].map(({ name, state, tools, connectedAt, lastError, lastErrorAt, reconnectAttempts }) => ({
      name, state, toolCount: tools.length, connectedAt, lastError, lastErrorAt, reconnectAttempts,
    }));
  }

  isReconnecting(): boolean {
    return [...this.upstreams.values()].some((e) => e.state === "reconnecting");
  }

  /** Reconnects a failed server now, e.g. once its OAuth tokens arrive. */
  async retryIfDown(name: string): Promise<void> {
    // An attempt already in flight may have read the store before the new tokens landed.
    await this.pendingReconnects.get(name);
    const entry = this.upstreams.get(name);
    if (entry?.state === "failed") await this.onDemandReconnect(name, entry);
  }

  private onDemandReconnect(name: string, entry: UpstreamEntry): Promise<void> {
    return this.track(name, () => this.reconnectNow(name, entry));
  }

  /** Concurrent attempts share one, so a server never ends up with two live clients. */
  private track(name: string, run: () => Promise<void>): Promise<void> {
    const inFlight = this.pendingReconnects.get(name);
    if (inFlight) return inFlight;
    const attempt = run().finally(() => this.pendingReconnects.delete(name));
    this.pendingReconnects.set(name, attempt);
    return attempt;
  }

  private async reconnectNow(name: string, entry: UpstreamEntry): Promise<void> {
    const timer = this.reconnectTimers.get(name);
    if (timer) { clearTimeout(timer); this.reconnectTimers.delete(name); }

    entry.reconnectAttempts = 0;
    try {
      const result = await this.connectClient(name, entry.config);
      const filtered = result.tools.filter((t) => matchesFilter(t.name, serverFilter(entry.config)));
      entry.client = result.client;
      entry.tools = filtered;
      entry.state = "connected";
      entry.connectedAt = Date.now();
      entry.reconnectAttempts = 0;
      this.invalidateCache();
      this.setupErrorHandler(name, result.client);
      log(`[${name}] on-demand reconnect succeeded (${filtered.length} tools)`);
    } catch (err) {
      entry.lastError = String(err);
      entry.lastErrorAt = Date.now();
      entry.state = "failed";
      log(`[${name}] on-demand reconnect failed:`, err);
    }
  }

  private async connectClient(name: string, srv: ServerConfig): Promise<{ client: Client; tools: Tool[] }> {
    const client = new Client({ name: CLIENT_NAME, version: VERSION });
    const transport = buildTransport(name, srv);
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `[${name}] connect timed out`);
      const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `[${name}] listTools timed out`);
      return { client, tools };
    } catch (err) {
      try { await client.close(); } catch { /* ignore */ }
      if (isHttpServer(srv) && !isAuthError(err)) {
        return this.connectViaSSE(name, srv);
      }
      throw err;
    }
  }

  private async connectViaSSE(name: string, srv: ServerConfig): Promise<{ client: Client; tools: Tool[] }> {
    log(`[${name}] StreamableHTTP failed, trying SSE fallback…`);
    const client = new Client({ name: CLIENT_NAME, version: VERSION });
    const transport = buildSSETransport(name, srv);
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `[${name}] SSE connect timed out`);
      const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `[${name}] SSE listTools timed out`);
      log(`[${name}] connected via SSE fallback`);
      return { client, tools };
    } catch (err) {
      try { await client.close(); } catch { /* ignore */ }
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const entry of this.upstreams.values()) entry.state = "disconnected";
    this.invalidateCache();
    const results = await Promise.allSettled(Array.from(this.upstreams.values(), ({ client }) => client.close()));
    this.upstreams.clear();
    for (const r of results) {
      if (r.status === "rejected") log("[aggregator] disconnect error:", r.reason);
    }
  }
}

// --- helpers ---

type VisibilityCheck = { tool: { name: string; originalName: string }; clientFilter?: ToolFilter; locked: string[] };

function isVisibleToClient({ tool, clientFilter, locked }: VisibilityCheck): boolean {
  return matchesFilter(tool.originalName, clientFilter) && !compilePatterns(locked).some((m) => m.match(tool.name));
}

function serverFilter(srv: ServerConfig): ToolFilter | undefined {
  if (!srv.include && !srv.exclude) return undefined;
  return { include: srv.include, exclude: srv.exclude };
}

function buildTransport(name: string, srv: ServerConfig): Transport {
  if (isSseServer(srv)) {
    return buildSSETransport(name, srv);
  }
  if (isHttpServer(srv)) {
    return new StreamableHTTPClientTransport(new URL(srv.url), {
      requestInit: { headers: srv.headers },
      authProvider: isOAuthServer(srv) ? new FileOAuthProvider({ name, srv }) : undefined,
    });
  }
  return new StdioClientTransport({
    command: srv.command,
    args: srv.args ?? [],
    env: { ...process.env, ...srv.env } as Record<string, string>,
  });
}

function buildSSETransport(name: string, srv: ServerConfig): SSEClientTransport {
  const headers = "headers" in srv ? srv.headers : undefined;
  const url = new URL((srv as { url: string }).url);
  return new SSEClientTransport(url, {
    eventSourceInit: headers ? { fetch: (input, init) => fetch(input, { ...init, headers: withHeaders(init?.headers, headers) }) } : undefined,
    requestInit: headers ? { headers } : undefined,
    authProvider: isOAuthServer(srv) ? new FileOAuthProvider({ name, srv }) : undefined,
  });
}

/** The SDK passes a `Headers` instance, which object spread would empty — dropping its bearer token. */
function withHeaders(base: HeadersInit | undefined, extra: Record<string, string>): Headers {
  const merged = new Headers(base);
  for (const [k, v] of Object.entries(extra)) merged.set(k, v);
  return merged;
}

function isAuthError(err: unknown): boolean {
  if (err instanceof AuthRequiredError) return true;
  const msg = String(err).toLowerCase();
  return msg.includes("unauthorized") || msg.includes("forbidden") ||
    msg.includes("401") || msg.includes("403");
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isTransportError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return msg.includes("econnrefused") || msg.includes("econnreset") ||
    msg.includes("epipe") || msg.includes("timed out") || msg.includes("fetch failed") ||
    msg.includes("unable to connect") || msg.includes("socket hang up") || msg.includes("network error") ||
    msg.includes("session not found") || msg.includes("no valid session") ||
    msg.includes("session-id header is required") || msg.includes("server not initialized") ||
    msg.includes("streamable http error") || msg.includes("posting to endpoint") ||
    msg.includes("http error") || msg.includes("unauthorized") || msg.includes("forbidden") ||
    msg.includes("401") || msg.includes("403") || msg.includes("500") ||
    msg.includes("502") || msg.includes("503") || msg.includes("504");
}
