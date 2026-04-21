import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import os from "os";

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

export type ServerConfig = StdioServer | HttpServer;

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
  return (s as HttpServer).type === "http";
}

export function resolveMcpFile(opts: ResolveMcpFileOpts): string {
  if (opts.flagPath) return path.resolve(opts.flagPath);
  if (opts.envConfig) return opts.envConfig;
  if (opts.localFileExists) return opts.localFilePath;
  return DEFAULT_MCP_FILE;
}

export function loadConfig(filePath: string): Config {
  const raw = readRawConfig(filePath);
  const expanded = raw.replace(ENV_VAR_RE, (_match: string, name: string) => process.env[name] ?? "");
  return JSON.parse(expanded) as Config;
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

function readRawConfig(filePath: string): string {
  const buf = readFileSync(filePath);
  if (buf.length > MAX_CONFIG_BYTES) {
    throw new Error(`Config file too large (${buf.length} bytes; max ${MAX_CONFIG_BYTES}): ${filePath}`);
  }
  return buf.toString("utf-8");
}

