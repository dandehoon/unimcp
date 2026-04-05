import { existsSync, readFileSync } from "fs";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CONFIG_DIR } from "./server.js";

const SEP = "__";

export type StatusOptions = {
  envHash: string;
  host: string;
  configPath: string;
};

export async function runStatus(opts: StatusOptions): Promise<void> {
  const pidFile = path.join(CONFIG_DIR, `daemon.${opts.envHash}.pid`);

  if (!existsSync(pidFile)) {
    console.error("[status] no daemon running");
    return;
  }

  const content = readFileSync(pidFile, "utf-8").trim();
  const [pidStr, portStr] = content.split(":");
  const pid = Number(pidStr);
  const port = Number(portStr);

  if (isNaN(pid) || isNaN(port)) {
    console.error("[status] pid file corrupt:", pidFile);
    return;
  }

  try {
    process.kill(pid, 0);
  } catch {
    console.error(`[status] daemon PID ${pid} not alive — stale pid file`);
    return;
  }

  console.error(`[status] daemon PID ${pid} — http://${opts.host}:${port}/mcp`);
  console.error(`[status] config: ${opts.configPath}`);

  const client = new Client({ name: "unimcp-status", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://${opts.host}:${port}/mcp`))
    );
  } catch (err) {
    console.error("[status] daemon unreachable:", err);
    return;
  }

  let tools: Tool[];
  try {
    const result = await client.listTools();
    tools = result.tools;
  } catch (err) {
    console.error("[status] listTools failed:", err);
    await client.close();
    return;
  }

  await client.close();
  printTools(tools);
}

// --- helpers ---

function printTools(tools: Tool[]): void {
  const map = new Map<string, string[]>();

  for (const tool of tools) {
    const sepIdx = tool.name.indexOf(SEP);
    const upstream = sepIdx === -1 ? "(unknown)" : tool.name.slice(0, sepIdx);
    const name = sepIdx === -1 ? tool.name : tool.name.slice(sepIdx + SEP.length);
    const names = map.get(upstream) ?? [];
    names.push(name);
    map.set(upstream, names);
  }

  console.error(`[status] ${tools.length} tool(s) across ${map.size} upstream(s):`);
  for (const [upstream, names] of map) {
    console.error(`  ${upstream} (${names.length})`);
    for (const name of names) {
      console.error(`    - ${name}`);
    }
  }
}
