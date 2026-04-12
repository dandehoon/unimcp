import { readFileSync, unlinkSync } from "fs";
import { spawn } from "child_process";
import path from "path";
import { CONFIG_DIR } from "./server.js";
import { log } from "./utils.js";

const HEALTH_CHECK_TIMEOUT_MS = 3_000;
const SPAWN_WAIT_MS = 15_000;
const SPAWN_WAIT_S = SPAWN_WAIT_MS / 1_000;
const POLL_INTERVAL_MS = 300;

export type DaemonOptions = {
  port: number;
  host: string;
  configPath: string;
  envHash: string;
};

type DaemonInfo = {
  pid: number;
  port: number;
};

export async function ensureDaemon(opts: DaemonOptions): Promise<number> {
  const running = await runningDaemon(opts.envHash, opts.host);
  if (running) {
    log(`[daemon] already running on port ${running.port}`);
    return running.port;
  }
  return startDaemon(opts);
}

// --- helpers ---

async function runningDaemon(envHash: string, host: string): Promise<DaemonInfo | null> {
  const pidFile = pidFilePath(envHash);
  const info = parsePidFile(pidFile);
  if (!info) return null;

  if (!isAlive(info.pid)) {
    unlinkSync(pidFile);
    return null;
  }

  const healthy = await checkHealth(host, info.port);
  if (!healthy) {
    try { unlinkSync(pidFile); } catch { /* already gone */ }
    return null;
  }

  return info;
}

async function startDaemon(opts: DaemonOptions): Promise<number> {
  const execPath = process.execPath;
  const scriptArg = process.argv[1] ?? "";
  const isCompiled = execPath === scriptArg || scriptArg.includes("$bunfs");

  const [cmd, cmdArgs] = isCompiled
    ? [execPath, ["--http", "--mcp-file", opts.configPath, "--env-hash", opts.envHash]]
    : [execPath, [scriptArg, "--http", "--mcp-file", opts.configPath, "--env-hash", opts.envHash]];

  const child = spawn(cmd, cmdArgs, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });

  child.unref();

  const pid = child.pid;
  if (!pid) throw new Error("Failed to spawn daemon — no pid");

  log(`[daemon] spawned PID ${pid} — waiting for health check…`);

  const port = await waitForDaemon(opts.envHash, opts.host);
  log(`[daemon] ready on http://${opts.host}:${port}/mcp`);
  return port;
}

async function waitForDaemon(envHash: string, host: string): Promise<number> {
  const pidFile = pidFilePath(envHash);
  const deadline = Date.now() + SPAWN_WAIT_MS;
  while (Date.now() < deadline) {
    const info = parsePidFile(pidFile);
    if (info && isAlive(info.pid) && (await checkHealth(host, info.port))) {
      return info.port;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Daemon did not become healthy within ${SPAWN_WAIT_S} s`);
}

function parsePidFile(pidFile: string): DaemonInfo | null {
  let content: string;
  try {
    content = readFileSync(pidFile, "utf-8").trim();
  } catch {
    return null;
  }
  const [pidStr, portStr] = content.split(":");
  const pid = Number(pidStr);
  const port = Number(portStr);
  if (!pid || !port) return null;
  return { pid, port };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function checkHealth(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`http://${host}:${port}/health`, HEALTH_CHECK_TIMEOUT_MS);
    return res.ok;
  } catch {
    return false;
  }
}

function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidFilePath(envHash: string): string {
  return path.join(CONFIG_DIR, `daemon.${envHash}.pid`);
}
