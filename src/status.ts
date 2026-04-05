import { readdirSync, readFileSync } from "fs";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CONFIG_DIR } from "./server.js";

const SEP = "__";
const out = (s = "") => process.stdout.write(s + "\n");

export type StatusOptions = {
  envHash: string;
  host: string;
  configPath: string;
};

export async function runStatus(opts: StatusOptions): Promise<void> {
  let entries: string[];
  try {
    entries = readdirSync(CONFIG_DIR);
  } catch {
    out("No daemons running.");
    return;
  }

  const pidFiles = entries.filter(
    (e) => e.startsWith("daemon.") && e.endsWith(".pid")
  );

  if (pidFiles.length === 0) {
    out("No daemons running.");
    return;
  }

  for (let i = 0; i < pidFiles.length; i++) {
    if (i > 0) out();
    const filename = pidFiles[i];
    const envHash = filename.slice("daemon.".length, -".pid".length);
    await checkDaemon(envHash, filename, opts);
  }
}

async function checkDaemon(
  envHash: string,
  filename: string,
  opts: StatusOptions
): Promise<void> {
  const pidFile = path.join(CONFIG_DIR, filename);
  const content = readFileSync(pidFile, "utf-8").trim();
  const [pidStr, portStr] = content.split(":");
  const pid = Number(pidStr);
  const port = Number(portStr);

  if (isNaN(pid) || isNaN(port)) {
    out(`[corrupt pid file: ${pidFile}]`);
    return;
  }

  try {
    process.kill(pid, 0);
  } catch {
    out(`Daemon ${envHash}  PID ${pid}  stale (process not alive)`);
    return;
  }

  const configLabel =
    envHash === opts.envHash ? opts.configPath : "(unknown — different env context)";

  out(`Daemon ${envHash}  PID ${pid}  http://${opts.host}:${port}/mcp`);
  out(`Config ${configLabel}`);

  const client = new Client({ name: "unimcp-status", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://${opts.host}:${port}/mcp`))
    );
  } catch (err) {
    out(`  [unreachable: ${String(err)}]`);
    return;
  }

  let tools: Tool[];
  try {
    const result = await client.listTools();
    tools = result.tools;
  } catch (err) {
    out(`  [listTools failed: ${String(err)}]`);
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

  out(`Tools  ${tools.length} across ${map.size} upstream(s)`);
  for (const [upstream, names] of map) {
    out(`  ${upstream}  (${names.length})`);
    for (const name of names) {
      out(`    ${name}`);
    }
  }
}
