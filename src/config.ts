import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import os from "os";
import { log, stripJsonComments, VERSION } from "./utils.js";

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
  /** Grants the client holds; tools under any other grant in the config stay hidden. */
  grants?: string[];
};

export const HEADER_TOOLS_INCLUDE = "x-tools-include";
export const HEADER_TOOLS_EXCLUDE = "x-tools-exclude";
export const HEADER_TOOLS_GRANTS = "x-tools-grants";

export type StdioServer = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  include?: string[];
  exclude?: string[];
};

/** OAuth client settings; omit `clientId` to use dynamic client registration. */
export type OAuthConfig = {
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  callbackPort?: number;
};

type RemoteServerFields = {
  url: string;
  headers?: Record<string, string>;
  /** `"oauth"` (or an `oauth` block) authorizes via `unimcp auth <name>`. */
  auth?: "oauth";
  oauth?: OAuthConfig;
  enabled?: boolean;
  include?: string[];
  exclude?: string[];
};

/** `type` may be omitted: a `url` without one is HTTP. */
export type HttpServer = RemoteServerFields & { type?: "http" };

export type SseServer = RemoteServerFields & { type: "sse" };

export type ServerConfig = StdioServer | HttpServer | SseServer;

export type Config = {
  mcpServers: Record<string, ServerConfig>;
  /** Grant name → `server__tool` globs hidden from every client that doesn't hold that grant. */
  grants?: Record<string, string[]>;
};

export type ResolveMcpFileOpts = {
  flagPath?: string;
  envConfig?: string;
  localFileExists: boolean;
  localFilePath: string;
};

export function isHttpServer(s: ServerConfig): s is HttpServer {
  return "url" in s && (s.type === undefined || s.type === "http");
}

export function isSseServer(s: ServerConfig): s is SseServer {
  return "type" in s && s.type === "sse";
}

export function isOAuthServer(s: ServerConfig): s is HttpServer | SseServer {
  return "url" in s && (s.auth === "oauth" || s.oauth !== undefined);
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
  const grants = parseGrants(parsed?.grants, filePath);
  const servers = parsed?.mcpServers;
  if (servers === undefined) return { mcpServers: {}, grants };
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new Error(`Config "mcpServers" must be an object: ${filePath}`);
  }
  return { mcpServers: servers, grants };
}

function parseGrants(raw: unknown, filePath: string): Record<string, string[]> | undefined {
  if (raw === undefined) return undefined;
  // An empty list or pattern would lock nothing while looking like a lock.
  const isGlobList = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === "string" && p.trim() !== "");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !Object.values(raw).every(isGlobList)) {
    throw new Error(`Config "grants" must map grant names to non-empty arrays of tool globs: ${filePath}`);
  }
  return raw as Record<string, string[]>;
}

/** Loads the config with `${VAR}` expanded, dropping servers whose references are unset. */
export function loadConfig(filePath: string): Config {
  const raw = loadRawConfig(filePath);
  const mcpServers: Record<string, ServerConfig> = {};
  for (const [rawName, rawSrv] of Object.entries(raw.mcpServers)) {
    const { resolved, missing } = resolveEnvRefs({ name: rawName, srv: rawSrv });
    if (missing.length > 0) {
      if (rawSrv.enabled !== false) log(`[config] skipping '${rawName}' — unset env var(s): ${missing.join(", ")}`);
      continue;
    }
    mcpServers[resolved.name] = resolved.srv;
  }
  return { mcpServers, grants: raw.grants };
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
  // The version keeps an upgraded bridge off a daemon still running the old code.
  const record: Record<string, string> = { __config: path.resolve(filePath), __version: VERSION };
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

