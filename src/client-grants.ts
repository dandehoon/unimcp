import { spawnSync } from "child_process";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import path from "path";
import { CONFIG_DIR } from "./config.js";
import { readFileSafe } from "./utils.js";

// Grants held by one client process, in `grants/<pid>` under the config dir: what
// `unimcp grant` edits, and what the bridge that process spawned reads and watches.

// `ps` reports a start time in whole seconds; a file written in the client's first second
// must still count as its own.
const START_SLACK_MS = 2_000;

export function clientGrantsPath(pid: number, dir = CONFIG_DIR): string {
  return path.join(dir, "grants", String(pid));
}

export function readClientGrants(pid: number, dir = CONFIG_DIR): string[] {
  return parseGrants(readFileSafe(clientGrantsPath(pid, dir)) ?? "");
}

/**
 * Apply `edits` to a client's grants — `+name` or `name` adds, `-name` removes — and return
 * the list held after. Files of clients no longer running are removed on the way.
 */
export function editClientGrants(pid: number, edits: string[], dir = CONFIG_DIR): string[] {
  const held = new Set(readClientGrants(pid, dir));
  for (const edit of edits) {
    if (edit.startsWith("-")) held.delete(edit.slice(1));
    else held.add(edit.replace(/^\+/, ""));
  }
  const file = clientGrantsPath(pid, dir);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Rename into place: a watching bridge must never read half a list.
  writeFileSync(`${file}.${process.pid}`, [...held].map((g) => `${g}\n`).join(""));
  renameSync(`${file}.${process.pid}`, file);
  pruneExitedClients(dir);
  return [...held];
}

export function dropClientGrants(pid: number, dir = CONFIG_DIR): void {
  rmSync(clientGrantsPath(pid, dir), { force: true });
}

/**
 * Whether `file` was written after the client started. A file from before belongs to an
 * earlier process that had the same pid and exited without dropping it.
 */
export function isOwnGrantsFile(file: string, clientStartMs: number): boolean {
  try {
    return statSync(file).mtimeMs >= clientStartMs - START_SLACK_MS;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** When `pid` started, from `ps`'s elapsed time; undefined where `ps` can't tell (Windows). */
export function processStartMs(pid: number, now = Date.now()): number | undefined {
  const ps = spawnSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" });
  const elapsed = ps.status === 0 ? parseElapsed(ps.stdout.trim()) : undefined;
  return elapsed === undefined ? undefined : now - elapsed;
}

/** `ps` etime, `[[dd-]hh:]mm:ss`, in ms. */
export function parseElapsed(etime: string): number | undefined {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!m) return undefined;
  const [days, hours, mins, secs] = m.slice(1).map((v) => Number(v ?? 0));
  return (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000;
}

// --- helpers ---

function parseGrants(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

function pruneExitedClients(dir: string): void {
  const grantsDir = path.join(dir, "grants");
  for (const name of readdirSync(grantsDir)) {
    if (/^\d+$/.test(name) && !isRunning(Number(name))) rmSync(path.join(grantsDir, name), { force: true });
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: running, as another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
