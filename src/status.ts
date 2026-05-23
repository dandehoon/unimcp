import { readdirSync } from "fs";
import path from "path";
import { CONFIG_DIR } from "./config.js";
import type { UpstreamStatus } from "./aggregator.js";
import { parsePidFile, isAlive } from "./daemon.js";
import { log } from "./utils.js";

export type StatusOptions = {
  envHash: string;
  host: string;
  configPath: string;
};

type DaemonStatus = {
  pid: number;
  uptime: number;
  activeSessions: number;
  upstreams: UpstreamStatus[];
};

export async function runStatus(opts: StatusOptions): Promise<void> {
  let entries: string[];
  try {
    entries = readdirSync(CONFIG_DIR);
  } catch {
    log("No daemons running.");
    return;
  }

  const pidFiles = entries.filter(
    (e) => e.startsWith("daemon.") && e.endsWith(".pid")
  );

  if (pidFiles.length === 0) {
    log("No daemons running.");
    return;
  }

  for (const [i, filename] of pidFiles.entries()) {
    if (i > 0) log("");
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
  const info = parsePidFile(pidFile);

  if (!info) {
    log(`[corrupt pid file: ${pidFile}]`);
    return;
  }

  const { pid, port } = info;

  if (!isAlive(pid)) {
    log(`Daemon ${envHash}  PID ${pid}  stale (process not alive)`);
    return;
  }

  const configLabel =
    envHash === opts.envHash ? opts.configPath : "(unknown — different env context)";

  log(`Daemon ${envHash}  PID ${pid}  http://${opts.host}:${port}/mcp`);
  log(`Config ${configLabel}`);

  const status = await fetchStatus(opts.host, port);
  if (!status) return;

  log(`Uptime ${formatDuration(status.uptime)}  Sessions ${status.activeSessions}`);
  printUpstreams(status.upstreams);
}

// --- helpers ---

async function fetchStatus(host: string, port: number): Promise<DaemonStatus | null> {
  try {
    const res = await fetch(`http://${host}:${port}/status`);
    if (!res.ok) {
      log(`  [status endpoint returned ${res.status}]`);
      return null;
    }
    return await res.json() as DaemonStatus;
  } catch (err) {
    log(`  [unreachable: ${String(err)}]`);
    return null;
  }
}

function printUpstreams(upstreams: UpstreamStatus[]): void {
  if (upstreams.length === 0) {
    log("  No upstreams configured");
    return;
  }

  const totalTools = upstreams.reduce((sum, u) => sum + u.toolCount, 0);
  const connected = upstreams.filter((u) => u.state === "connected").length;
  log(`Upstreams  ${connected}/${upstreams.length} connected  ${totalTools} tools`);

  for (const u of upstreams) {
    const stateIcon = stateSymbol(u.state);
    const toolInfo = u.toolCount > 0 ? `${u.toolCount} tools` : "0 tools";
    const connInfo = u.connectedAt ? `since ${formatTimestamp(u.connectedAt)}` : "";
    log(`  ${stateIcon} ${u.name}  ${toolInfo}  ${connInfo}`);

    if (u.state === "failed" || u.state === "reconnecting") {
      const detail = u.lastError ? `${u.lastError}` : "";
      const when = u.lastErrorAt ? ` (${formatTimestamp(u.lastErrorAt)})` : "";
      const retries = u.reconnectAttempts > 0 ? `  retries: ${u.reconnectAttempts}` : "";
      if (detail) log(`    error: ${detail}${when}${retries}`);
    }
  }
}

function stateSymbol(state: UpstreamStatus["state"]): string {
  switch (state) {
    case "connected": return "+";
    case "failed": return "x";
    case "reconnecting": return "~";
    case "disconnected": return "-";
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  return `${h}h ${m}m`;
}

function formatTimestamp(ms: number): string {
  const ago = Math.floor((Date.now() - ms) / 1_000);
  if (ago < 60) return `${ago}s ago`;
  if (ago < 3_600) return `${Math.floor(ago / 60)}m ago`;
  return `${Math.floor(ago / 3_600)}h ago`;
}
