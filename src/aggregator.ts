import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Minimatch } from "minimatch";
import { type Config, type ServerConfig, type ToolFilter, isHttpServer } from "./config.js";
import { log } from "./utils.js";

export const SEP = "__";
const CLIENT_NAME = "unimcp";
const CLIENT_VERSION = "1.0.0";
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

const MATCH_ALL = [new Minimatch("*")];
const MATCH_NONE: Minimatch[] = [];
const patternCache = new Map<string, Minimatch[]>();

function compilePatterns(patterns: string[]): Minimatch[] {
  const key = patterns.join("\0");
  let compiled = patternCache.get(key);
  if (!compiled) {
    compiled = patterns.map((p) => new Minimatch(p));
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
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async connect(config: Config): Promise<void> {
    const entries = Object.entries(config.mcpServers).filter(([_, srv]) => srv.enabled !== false);
    await Promise.all(entries.map(([name, srv]) => this.connectOne(name, srv)));
  }

  private async connectOne(name: string, srv: ServerConfig): Promise<void> {
    if (name.includes(SEP)) {
      log(`[${name}] server name must not contain "${SEP}" — skipped`);
      return;
    }
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
    const transport = buildTransport(srv);

    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `[${name}] connect timed out`);
      const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `[${name}] listTools timed out`);
      const filtered = tools.filter((t) => matchesFilter(t.name, serverFilter(srv)));
      this.upstreams.set(name, {
        name, client, tools: filtered, config: srv,
        state: "connected", connectedAt: Date.now(),
        lastError: null, lastErrorAt: null, reconnectAttempts: 0,
      });
      this.setupErrorHandler(name, client);
      log(`[${name}] connected (${filtered.length} tools)`);
    } catch (err) {
      log(`[${name}] failed to connect:`, err);
      this.upstreams.set(name, {
        name, client, tools: [], config: srv,
        state: "failed", connectedAt: null,
        lastError: String(err), lastErrorAt: Date.now(), reconnectAttempts: 0,
      });
      try { await client.close(); } catch { /* ignore */ }
      this.scheduleReconnect(name);
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
    const timer = setTimeout(() => this.attemptReconnect(name), delay);
    this.reconnectTimers.set(name, timer);
  }

  private async attemptReconnect(name: string): Promise<void> {
    this.reconnectTimers.delete(name);
    const entry = this.upstreams.get(name);
    if (!entry || entry.state === "disconnected") return;

    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
    const transport = buildTransport(entry.config);
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `[${name}] reconnect timed out`);
      const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `[${name}] listTools timed out`);
      const filtered = tools.filter((t) => matchesFilter(t.name, serverFilter(entry.config)));
      entry.client = client;
      entry.tools = filtered;
      entry.state = "connected";
      entry.connectedAt = Date.now();
      entry.reconnectAttempts = 0;
      this.invalidateCache();
      this.setupErrorHandler(name, client);
      log(`[${name}] reconnected (${filtered.length} tools)`);
    } catch (err) {
      entry.lastError = String(err);
      entry.lastErrorAt = Date.now();
      try { await client.close(); } catch { /* ignore */ }
      if (entry.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        entry.state = "failed";
        log(`[${name}] reconnect failed permanently:`, err);
      } else {
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
    if (!clientFilter?.include && !clientFilter?.exclude) return this.toolCache;
    const key = `${clientFilter.include?.join("\0") ?? ""}|${clientFilter.exclude?.join("\0") ?? ""}`;
    let cached = this.clientFilterCache.get(key);
    if (!cached) {
      cached = this.toolCache.filter((t) => matchesFilter(t.originalName, clientFilter));
      this.clientFilterCache.set(key, cached);
    }
    return cached;
  }

  async callTool(prefixedName: string, args: Record<string, unknown>): Promise<ReturnType<Client["callTool"]>> {
    const sep = prefixedName.indexOf(SEP);
    if (sep === -1) throw new Error(`Invalid tool name (missing separator): ${prefixedName}`);
    const upstreamName = prefixedName.slice(0, sep);
    const toolName = prefixedName.slice(sep + SEP.length);

    const upstream = this.upstreams.get(upstreamName);
    if (!upstream) throw new Error(`Unknown upstream: ${upstreamName}`);
    if (upstream.state !== "connected") throw new Error(`Upstream ${upstreamName} is ${upstream.state}`);

    try {
      return await withTimeout(
        upstream.client.callTool({ name: toolName, arguments: args }),
        CALL_TIMEOUT_MS,
        `[${upstreamName}] callTool timed out`,
      );
    } catch (err) {
      if (isTransportError(err)) this.scheduleReconnect(upstreamName);
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

function serverFilter(srv: ServerConfig): ToolFilter | undefined {
  if (!srv.include && !srv.exclude) return undefined;
  return { include: srv.include, exclude: srv.exclude };
}

function buildTransport(srv: ServerConfig): Transport {
  if (isHttpServer(srv)) {
    return new StreamableHTTPClientTransport(new URL(srv.url), {
      requestInit: { headers: srv.headers },
    });
  }
  return new StdioClientTransport({
    command: srv.command,
    args: srv.args ?? [],
    env: { ...process.env, ...srv.env } as Record<string, string>,
  });
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
    msg.includes("session not found") || msg.includes("no valid session") ||
    msg.includes("session-id header is required") || msg.includes("server not initialized");
}
