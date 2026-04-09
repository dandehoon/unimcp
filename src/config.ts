import { createHash } from "crypto";
import { readFileSync, statSync } from "fs";
import path from "path";
import os from "os";

const MAX_CONFIG_BYTES = 1_048_576; // 1 MB

export const DEFAULT_MCP_FILE = path.join(os.homedir(), ".config", "unimcp", "mcp.json");

const ENV_VAR_RE = /\$\{(\w+)\}/g;

export type ToolFilter = {
  include?: string[]; // glob patterns — defaults to ["*"] (all)
  exclude?: string[]; // glob patterns — defaults to [] (none)
};

export type ClientConfig = {
  tools?: ToolFilter;
};

export type StdioServer = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  tools?: ToolFilter;
};

export type HttpServer = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  tools?: ToolFilter;
};

export type ServerConfig = StdioServer | HttpServer;

export type Config = {
  mcpServers: Record<string, ServerConfig>;
  clients?: Record<string, ClientConfig>;
};

export function isHttpServer(s: ServerConfig): s is HttpServer {
  return (s as HttpServer).type === "http";
}

export function loadConfig(filePath: string): Config {
  guardFileSize(filePath);
  const raw = readFileSync(filePath, "utf-8");
  const expanded = raw.replace(ENV_VAR_RE, (_match: string, name: string) => process.env[name] ?? "");
  return JSON.parse(expanded) as Config;
}

export function computeEnvHash(filePath: string): string {
  let content = "";
  try {
    guardFileSize(filePath);
    content = readFileSync(filePath, "utf-8");
  } catch {
  }
  const varNames = new Set<string>();
  for (const match of content.matchAll(ENV_VAR_RE)) {
    varNames.add(match[1]);
  }
  const record = Object.fromEntries(
    [...varNames].sort().map((name) => [name, process.env[name] ?? ""]),
  );
  return createHash("sha256").update(JSON.stringify(record)).digest("hex").slice(0, 8);
}

// --- helpers ---

function guardFileSize(filePath: string): void {
  const stat = statSync(filePath);
  if (stat.size > MAX_CONFIG_BYTES) {
    throw new Error(`Config file too large (${stat.size} bytes; max ${MAX_CONFIG_BYTES}): ${filePath}`);
  }
}
