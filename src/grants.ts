import { mkdirSync } from "fs";
import path from "path";
import { watch } from "chokidar";
import { readFileSafe, splitCommaSeparated } from "./utils.js";

/**
 * Grants a bridge holds: the comma list in `envList` (fixed at launch) plus one per line
 * of `file` (changeable mid-session). A missing file holds nothing.
 */
export function heldGrants(envList: string | undefined, file: string | undefined): Set<string> {
  const held = new Set(envList ? splitCommaSeparated(envList) : []);
  for (const line of (file ? readFileSafe(file) ?? "" : "").split("\n")) {
    if (line.trim()) held.add(line.trim());
  }
  return held;
}

/** `server__tool` globs of every grant not held — hidden until granted. */
export function lockedPatterns(grants: Record<string, string[]> | undefined, held: Set<string>): string[] {
  return Object.entries(grants ?? {}).flatMap(([name, globs]) => (held.has(name) ? [] : globs));
}

/** Calls `onChange` whenever the grants file is written or removed. Returns the closer. */
export function watchGrantsFile(file: string | undefined, onChange: () => void): () => Promise<void> {
  if (!file) return async () => {};
  // chokidar reports nothing for a file whose directory doesn't exist yet, so the first
  // grant ever written would go unseen by bridges already running.
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const watcher = watch(file, { ignoreInitial: true });
  watcher.on("add", onChange).on("change", onChange).on("unlink", onChange);
  return () => watcher.close();
}
