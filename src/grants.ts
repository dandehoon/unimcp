import { mkdirSync } from "fs";
import path from "path";
import { watch } from "chokidar";
import { Minimatch } from "minimatch";
import type { GrantRule } from "./config.js";
import { readFileSafe, splitCommaSeparated } from "./utils.js";

// Patterns are literal globs: no `!` negation (which would invert a grant lock) and no `#` comments.
export const GLOB_OPTS = { nonegate: true, nocomment: true, dot: true };

/**
 * Grants a bridge holds: the comma list in `envList` (fixed at launch) plus one per line
 * of each file (changeable mid-session). A missing file holds nothing.
 */
export function heldGrants(envList: string | undefined, files: string[]): Set<string> {
  const held = new Set(envList ? splitCommaSeparated(envList) : []);
  for (const file of files) {
    for (const line of (readFileSafe(file) ?? "").split("\n")) {
      if (line.trim()) held.add(line.trim());
    }
  }
  return held;
}

/** `server__tool` globs of every grant not held — hidden until granted. Argument rules hide nothing. */
export function lockedPatterns(grants: Record<string, GrantRule[]> | undefined, held: Set<string>): string[] {
  return Object.entries(grants ?? {}).flatMap(([name, rules]) =>
    held.has(name) ? [] : rules.filter((r): r is string => typeof r === "string"));
}

type GrantedCall ={ name: string; args: Record<string, unknown> };

/** The first grant not held whose argument rule matches this call, or undefined when none locks it. */
export function lockingGrant(grants: Record<string, GrantRule[]> | undefined, held: Set<string>, call: GrantedCall): string | undefined {
  for (const [grant, rules] of Object.entries(grants ?? {})) {
    if (held.has(grant)) continue;
    if (rules.some((r) => typeof r !== "string" && matchesArgRule(r, call))) return grant;
  }
  return undefined;
}

function matchesArgRule(rule: Exclude<GrantRule, string>, call: GrantedCall): boolean {
  return new Minimatch(rule.tool, GLOB_OPTS).match(call.name) &&
    Object.entries(rule.args).every(([k, v]) => call.args[k] === v);
}

/** Calls `onChange` whenever a grants file is written or removed. Returns the closer. */
export function watchGrantsFiles(files: string[], onChange: () => void): () => Promise<void> {
  // chokidar reports nothing for a file whose directory doesn't exist yet, so the first
  // grant ever written would go unseen by bridges already running.
  for (const file of files) mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const watcher = watch(files, { ignoreInitial: true });
  watcher.on("add", onChange).on("change", onChange).on("unlink", onChange);
  return () => watcher.close();
}
