import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import os from "os";
import { log, stripJsonComments } from "./utils.js";

const MAX_CONFIG_BYTES = 1_048_576; // 1 MB

export const CONFIG_DIR = path.join(os.homedir(), ".config", "unimcp");
export const DEFAULT_MCP_FILE = path.join(CONFIG_DIR, "unimcp.json");

export function pidFilePath(envHash: string): string {
  return path.join(CONFIG_DIR, `daemon.${envHash}.pid`);
}

const HOME = os.homedir();
export const VSCODE_MCP_PATH = path.join(HOME, "Library", "Application Support", "Code", "User", "mcp.json");
export const CURSOR_GLOBAL_PATH = path.join(HOME, ".cursor", "mcp.json");
export const CLAUDE_GLOBAL_PATH = path.join(HOME, ".claude.json");
export const OPENCODE_PATH = path.join(HOME, ".config", "opencode", "opencode.json");

const ENV_VAR_RE = /\$\{(\w+)\}/g;

export type ToolFilter = {
  include?: string[];
  exclude?: string[];
};

export const HEADER_TOOLS_INCLUDE = "x-tools-include";
export const HEADER_TOOLS_EXCLUDE = "x-tools-exclude";

export type StdioServer = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  include?: string[];
  exclude?: string[];
};

export type HttpServer = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  include?: string[];
  exclude?: string[];
};

export type SseServer = {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  include?: string[];
  exclude?: string[];
};

export type ServerConfig = StdioServer | HttpServer | SseServer;

export type Config = {
  mcpServers: Record<string, ServerConfig>;
};

export type ResolveMcpFileOpts = {
  flagPath?: string;
  envConfig?: string;
  localFileExists: boolean;
  localFilePath: string;
};

export function isHttpServer(s: ServerConfig): s is HttpServer {
  return "type" in s && s.type === "http";
}

export function isSseServer(s: ServerConfig): s is SseServer {
  return "type" in s && s.type === "sse";
}

export function resolveMcpFile(opts: ResolveMcpFileOpts): string {
  if (opts.flagPath) return path.resolve(opts.flagPath);
  if (opts.envConfig) return opts.envConfig;
  if (opts.localFileExists) return opts.localFilePath;
  return DEFAULT_MCP_FILE;
}

/** Parses the config as written, leaving `${VAR}` references intact. */
export function loadRawConfig(filePath: string): Config {
  const parsed = JSON.parse(stripJsonComments(readRawConfig(filePath))) as Partial<Config>;
  const servers = parsed?.mcpServers;
  if (servers === undefined) return { mcpServers: {} };
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new Error(`Config "mcpServers" must be an object: ${filePath}`);
  }
  return { mcpServers: servers };
}

/** Loads the config with `${VAR}` expanded, dropping servers whose references are unset. */
export function loadConfig(filePath: string): Config {
  const mcpServers: Record<string, ServerConfig> = {};
  for (const [rawName, rawSrv] of Object.entries(loadRawConfig(filePath).mcpServers)) {
    const { resolved, missing } = resolveEnvRefs({ name: rawName, srv: rawSrv });
    if (missing.length > 0) {
      if (rawSrv.enabled !== false) log(`[config] skipping '${rawName}' — unset env var(s): ${missing.join(", ")}`);
      continue;
    }
    mcpServers[resolved.name] = resolved.srv;
  }
  return { mcpServers };
}

/** Names of `${VAR}` references in a server config that are unset or empty. */
export function missingEnvVars(srv: ServerConfig): string[] {
  return resolveEnvRefs(srv).missing;
}

export function computeEnvHash(filePath: string): string {
  let content = "";
  try {
    content = readRawConfig(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const varNames = new Set<string>();
  for (const match of content.matchAll(ENV_VAR_RE)) {
    varNames.add(match[1]);
  }
  const record: Record<string, string> = { __config: path.resolve(filePath) };
  for (const name of [...varNames].sort()) {
    record[name] = process.env[name] ?? "";
  }
  return createHash("sha256").update(JSON.stringify(record)).digest("hex").slice(0, 8);
}

// --- helpers ---

function resolveEnvRefs<T>(value: T): { resolved: T; missing: string[] } {
  const missing = new Set<string>();
  const resolved = mapStrings(value, (s) =>
    s.replace(ENV_VAR_RE, (_match: string, name: string) => {
      const value = process.env[name];
      if (!value) {
        missing.add(name);
        return "";
      }
      return value;
    })
  );
  return { resolved, missing: [...missing] };
}

function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [fn(k), mapStrings(v, fn)])) as T;
  }
  return value;
}

function readRawConfig(filePath: string): string {
  const buf = readFileSync(filePath);
  if (buf.length > MAX_CONFIG_BYTES) {
    throw new Error(`Config file too large (${buf.length} bytes; max ${MAX_CONFIG_BYTES}): ${filePath}`);
  }
  return buf.toString("utf-8");
}

