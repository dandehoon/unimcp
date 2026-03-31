import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { minimatch } from "minimatch";
import { type Config, type ToolFilter, isHttpServer } from "./config.js";

const SEP = "__";

type UpstreamEntry = {
  name: string;
  client: Client;
  tools: Tool[];
  filter?: ToolFilter;
};

export type AggregatedTool = Tool & { upstreamName: string; originalName: string };

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

  private async connectOne(name: string, srv: Config["mcpServers"][string]): Promise<void> {
    const client = new Client({ name: "unimcp", version: "1.0.0" });

    const transport = isHttpServer(srv)
      ? new StreamableHTTPClientTransport(new URL(srv.url), {
          requestInit: { headers: srv.headers },
        })
      : new StdioClientTransport({
          command: (srv as { command: string }).command,
          args: (srv as { args?: string[] }).args ?? [],
          env: { ...process.env, ...(srv as { env?: Record<string, string> }).env } as Record<string, string>,
        });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      this.upstreams.push({ name, client, tools, filter: srv.tools });
      console.error(`[${name}] connected (${tools.length} tools)`);
    } catch (err) {
      console.error(`[${name}] failed to connect:`, err);
    }
  }

  listTools(): AggregatedTool[] {
    return this.upstreams.flatMap(({ name, tools, filter }) =>
      tools
        .filter((t) => matchesFilter(t.name, filter))
        .map((t) => ({
          ...t,
          name: `${name}${SEP}${t.name}`,
          upstreamName: name,
          originalName: t.name,
        }))
    );
  }

  async callTool(prefixedName: string, args: Record<string, unknown>) {
    const sep = prefixedName.indexOf(SEP);
    const upstreamName = prefixedName.slice(0, sep);
    const toolName = prefixedName.slice(sep + SEP.length);

    const upstream = this.upstreams.find((u) => u.name === upstreamName);
    if (!upstream) throw new Error(`Unknown upstream: ${upstreamName}`);

    return upstream.client.callTool({ name: toolName, arguments: args });
  }

  async disconnect(): Promise<void> {
    await Promise.all(this.upstreams.map(({ client }) => client.close()));
  }
}
