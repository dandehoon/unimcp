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

type UpstreamEntry = {
  name: string;
  client: Client;
  tools: Tool[];
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

/** Checks whether a bare tool name passes a filter. Patterns match bare (unprefixed) names. */
export function matchesFilter(toolName: string, filter?: ToolFilter): boolean {
  const include = filter?.include ? compilePatterns(filter.include) : MATCH_ALL;
  const exclude = filter?.exclude ? compilePatterns(filter.exclude) : MATCH_NONE;
  return include.some((m) => m.match(toolName)) && !exclude.some((m) => m.match(toolName));
}

export class Aggregator {
  private upstreams: Map<string, UpstreamEntry> = new Map();
  private toolCache: AggregatedTool[] | null = null;
  private clientFilterCache = new Map<string, AggregatedTool[]>();

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
      const filter = serverFilter(srv);
      const filtered = tools.filter((t) => matchesFilter(t.name, filter));
      this.upstreams.set(name, { name, client, tools: filtered });
      log(`[${name}] connected (${filtered.length} tools)`);
    } catch (err) {
      log(`[${name}] failed to connect:`, err);
      try { await client.close(); } catch { }
    }
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

    return withTimeout(
      upstream.client.callTool({ name: toolName, arguments: args }),
      CALL_TIMEOUT_MS,
      `[${upstreamName}] callTool timed out`,
    );
  }

  async disconnect(): Promise<void> {
    this.toolCache = null;
    this.clientFilterCache.clear();
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
