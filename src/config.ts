import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import os from "os";
import { PROFILE_RE } from "./profiles.js";
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

/** Fields every server takes, whatever its transport. */
type CommonFields = {
  enabled?: boolean;
  include?: string[];
  exclude?: string[];
  /** Arguments fixed for every call: dropped from the tool schemas and filled in on each call. */
  pinArgs?: Record<string, unknown>;
};

export type StdioServer = CommonFields & {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

/** OAuth client settings; omit `clientId` to use dynamic client registration. */
export type OAuthConfig = {
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  callbackPort?: number;
};

type RemoteServerFields = CommonFields & {
  url: string;
  headers?: Record<string, string>;
  /** `"oauth"` (or an `oauth` block) authorizes via `unimcp auth <name>`. */
  auth?: "oauth";
  oauth?: OAuthConfig;
};

/** `type` may be omitted: a `url` without one is HTTP. */
export type HttpServer = RemoteServerFields & { type?: "http" };

export type SseServer = RemoteServerFields & { type: "sse" };

export type ServerConfig = StdioServer | HttpServer | SseServer;

/**
 * A glob hides matching tools from a client without the grant; `{ tool, args }` leaves them
 * listed but refuses a call whose arguments equal every one of `args`.
 */
export type GrantRule = string | { tool: string; args: Record<string, string> };

/** Values for a server's `{var}` placeholders, one set per profile. */
export type ProfileVars = Record<string, string>;

/** One copy of a server: its `{var}` values, and what it is — shown to clients picking it. */
export type Profile = { vars: ProfileVars; description?: string };

/** A grant that is also a profile of `server`: the grant's name is the profile's. */
type ProfileGrant = { server: string; vars?: ProfileVars; description?: string };

export type Config = {
  mcpServers: Record<string, ServerConfig>;
  /** Grant name → rules locking `server__tool` names for every client that doesn't hold that grant. */
  grants?: Record<string, GrantRule[]>;
  /** Server → profile → vars, from the profile grants; such a server is listed once with a `profile` argument. */
  profiles?: Record<string, Record<string, Profile>>;
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
  const grants = parseGrants(parsed?.grants as unknown, filePath);
  const servers = parsed?.mcpServers;
  if (servers === undefined) return { mcpServers: {}, ...grants };
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new Error(`Config "mcpServers" must be an object: ${filePath}`);
  }
  return { mcpServers: servers, ...grants };
}

/** Splits `grants` into lock rules and profiles; the aggregator locks a profile's calls itself. */
function parseGrants(raw: unknown, filePath: string): Pick<Config, "grants" | "profiles"> {
  if (raw === undefined) return {};
  const invalid = () => new Error(
    `Config "grants" must map grant names to non-empty arrays of tool globs or { tool, args } rules, or to a { server, vars } profile: ${filePath}`);
  if (!isPlainObject(raw)) throw invalid();
  const grants: Record<string, GrantRule[]> = {};
  const profiles: Record<string, Record<string, Profile>> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (isProfileGrant(value)) {
      if (!PROFILE_RE.test(name)) throw new Error(`Config grant '${name}' is a profile, so its name must be letters, digits, '-' or single '_': ${filePath}`);
      (profiles[value.server] ??= {})[name] = { vars: value.vars ?? {}, description: value.description };
    } else if (Array.isArray(value) && value.length > 0 && value.every(isGrantRule)) {
      grants[name] = value;
    } else {
      throw invalid();
    }
  }
  return { grants, profiles: Object.keys(profiles).length ? profiles : undefined };
}

function isProfileGrant(v: unknown): v is ProfileGrant {
  if (!isPlainObject(v) || typeof v.server !== "string" || v.server.trim() === "") return false;
  if (v.description !== undefined && typeof v.description !== "string") return false;
  return v.vars === undefined || (isPlainObject(v.vars) && Object.values(v.vars).every((s) => typeof s === "string"));
}

// An empty list, pattern or args map would lock nothing while looking like a lock.
function isGrantRule(rule: unknown): boolean {
  const isGlob = (v: unknown) => typeof v === "string" && v.trim() !== "";
  if (isGlob(rule)) return true;
  if (!isPlainObject(rule) || !isGlob(rule.tool) || !isPlainObject(rule.args)) return false;
  const values = Object.values(rule.args);
  return values.length > 0 && values.every((v) => typeof v === "string");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
  return { mcpServers, grants: raw.grants, profiles: resolveProfiles(raw.profiles) };
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

/** Profiles with `${VAR}` expanded in their vars; a profile referencing an unset var is dropped. */
function resolveProfiles(profiles: Config["profiles"]): Config["profiles"] {
  if (!profiles) return profiles;
  return Object.fromEntries(Object.entries(profiles).map(([server, byName]) => [server, Object.fromEntries(
    Object.entries(byName).flatMap(([name, profile]) => {
      const { resolved, missing } = resolveEnvRefs(profile.vars);
      if (missing.length === 0) return [[name, { ...profile, vars: resolved }]];
      log(`[config] skipping profile '${name}' of '${server}' — unset env var(s): ${missing.join(", ")}`);
      return [];
    }),
  )]));
}

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

