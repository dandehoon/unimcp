import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { minimatch } from "minimatch";
import { type Config, type ServerConfig, type ToolFilter, isHttpServer } from "./config.js";

export const SEP = "__";
const CLIENT_NAME = "unimcp";
const CLIENT_VERSION = "1.0.0";
const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 60_000;

type UpstreamEntry = {
  name: string;
  client: Client;
  tools: Tool[];
  filter?: ToolFilter;
};

type AggregatedTool = Tool & { upstreamName: string; originalName: string };

export function matchesFilter(toolName: string, filter?: ToolFilter): boolean {
  const include = filter?.include ?? ["*"];
  const exclude = filter?.exclude ?? [];
  const included = include.some((pat) => minimatch(toolName, pat));
  const excluded = exclude.some((pat) => minimatch(toolName, pat));
  return included && !excluded;
}

export class Aggregator {
  private upstreams: UpstreamEntry[] = [];

  async connect(config: Config): Promise<void> {
    const entries = Object.entries(config.mcpServers);
    await Promise.all(entries.map(([name, srv]) => this.connectOne(name, srv)));
  }

  private async connectOne(name: string, srv: ServerConfig): Promise<void> {
    if (name.includes(SEP)) {
      console.error(`[${name}] server name must not contain "${SEP}" — skipped`);
      return;
    }
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
    const transport = buildTransport(srv);

    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `[${name}] connect timed out`);
      const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `[${name}] listTools timed out`);
      this.upstreams.push({ name, client, tools, filter: srv.tools });
      console.error(`[${name}] connected (${tools.length} tools)`);
    } catch (err) {
      console.error(`[${name}] failed to connect:`, err);
      try { await client.close(); } catch { }
    }
  }

  listTools(clientFilter?: ToolFilter): AggregatedTool[] {
    return this.upstreams.flatMap(({ name, tools, filter }) =>
      tools
        .filter((t) => matchesFilter(t.name, filter) && matchesFilter(t.name, clientFilter))
        .map((t) => ({
          ...t,
          name: `${name}${SEP}${t.name}`,
          upstreamName: name,
          originalName: t.name,
        }))
    );
  }

  async callTool(prefixedName: string, args: Record<string, unknown>): Promise<ReturnType<Client["callTool"]>> {
    const sep = prefixedName.indexOf(SEP);
    if (sep === -1) throw new Error(`Invalid tool name (missing separator): ${prefixedName}`);
    const upstreamName = prefixedName.slice(0, sep);
    const toolName = prefixedName.slice(sep + SEP.length);

    const upstream = this.upstreams.find((u) => u.name === upstreamName);
    if (!upstream) throw new Error(`Unknown upstream: ${upstreamName}`);

    return withTimeout(
      upstream.client.callTool({ name: toolName, arguments: args }),
      CALL_TIMEOUT_MS,
      `[${upstreamName}] callTool timed out`,
    );
  }

  async disconnect(): Promise<void> {
    const results = await Promise.allSettled(this.upstreams.map(({ client }) => client.close()));
    for (const r of results) {
      if (r.status === "rejected") console.error("[aggregator] disconnect error:", r.reason);
    }
  }
}

// --- helpers ---

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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise
      .then((val) => { clearTimeout(timer); resolve(val); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}
