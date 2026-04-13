import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import path from "path";

/** Writes to stderr (stdout is reserved for MCP JSON-RPC messages). */
export function log(...args: unknown[]): void {
  process.stderr.write(args.map(String).join(" ") + "\n");
}

export const MCP_SERVER_IDENTITY = { name: "unimcp", version: "1.0.0" } as const;

export function splitCommaSeparated(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function collectRepeatable(val: string, prev: string[]): string[] {
  prev.push(val);
  return prev;
}

export function parseKvPairs(pairs: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    result[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return result;
}

export function tryUnlink(filePath: string): void {
  try { unlinkSync(filePath); } catch { /* already gone */ }
}

export function readFileSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export type WriteFileOpts = { dirMode?: number; fileMode?: number };

export const PERMS_PUBLIC: WriteFileOpts = { dirMode: 0o755, fileMode: 0o644 };
export const PERMS_PRIVATE: WriteFileOpts = { dirMode: 0o700, fileMode: 0o600 };

export function writeFileSafe(filePath: string, content: string, opts: WriteFileOpts = {}): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: opts.dirMode });
  writeFileSync(filePath, content, { encoding: "utf-8", mode: opts.fileMode });
}

export function parseJsonSafe<T>(raw: string, context: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    log(`warning: could not parse ${context}`);
    return null;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

export function stripJsonComments(raw: string): string {
  const parts: string[] = [];
  let i = 0;
  let start = 0;

  const flush = (end: number): void => { if (end > start) parts.push(raw.slice(start, end)); };

  while (i < raw.length) {
    if (raw[i] === '"') {
      i++;
      while (i < raw.length) {
        if (raw[i] === "\\") { i += 2; continue; }
        if (raw[i++] === '"') break;
      }
      continue;
    }
    if (raw[i] === "/" && raw[i + 1] === "/") {
      flush(i);
      while (i < raw.length && raw[i] !== "\n") i++;
      start = i;
      continue;
    }
    if (raw[i] === "/" && raw[i + 1] === "*") {
      flush(i);
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      if (i < raw.length) i += 2;
      start = i;
      continue;
    }
    i++;
  }
  flush(i);
  return parts.join("");
}
