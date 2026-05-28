import { readdirSync } from "fs";
import path from "path";
import { CONFIG_DIR, pidFilePath } from "./config.js";
import { parsePidFile, isAlive } from "./daemon.js";
import { log, tryUnlink } from "./utils.js";

export type StopOptions = {
  envHash: string;
  id?: string;
  all?: boolean;
};

export function runStop(opts: StopOptions): number {
  const targets = opts.all
    ? discoverAllPidFiles()
    : opts.id
      ? findByPrefix(opts.id)
      : [pidFilePath(opts.envHash)];

  let stopped = 0;
  for (const pidFile of targets) {
    const info = parsePidFile(pidFile);
    if (!info) { tryUnlink(pidFile); continue; }
    if (info.pid === process.pid) { continue; }
    if (!isAlive(info.pid)) {
      tryUnlink(pidFile);
      log(`[stop] removed stale pid file (PID ${info.pid})`);
      continue;
    }
    try {
      process.kill(info.pid, "SIGTERM");
      tryUnlink(pidFile);
      stopped++;
      log(`[stop] stopped daemon PID ${info.pid} (port ${info.port})`);
    } catch (err) {
      log(`[stop] failed to kill PID ${info.pid}:`, err);
    }
  }

  if (targets.length === 0) log("[stop] no daemons found");
  return stopped;
}

// --- helpers ---

function discoverAllPidFiles(): string[] {
  try {
    return readdirSync(CONFIG_DIR)
      .filter((e) => e.startsWith("daemon.") && e.endsWith(".pid"))
      .map((e) => path.join(CONFIG_DIR, e));
  } catch { return []; }
}

function findByPrefix(prefix: string): string[] {
  return discoverAllPidFiles().filter((f) => {
    const name = path.basename(f);
    const hash = name.slice("daemon.".length, -".pid".length);
    return hash.startsWith(prefix);
  });
}
