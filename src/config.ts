import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import os from "os";

export const DEFAULT_MCP_FILE = path.join(os.homedir(), ".config", "unimcp", "mcp.json");

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
  const raw = readFileSync(filePath, "utf-8");
  // Expand env vars in the form ${VAR}
  const expanded = raw.replace(/\$\{(\w+)\}/g, (_match: string, name: string) => process.env[name] ?? "");
  return JSON.parse(expanded) as Config;
}

export function computeEnvHash(filePath: string): string {
  let content = "";
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    // file does not exist or cannot be read — use empty string
  }
  const varNames = new Set<string>();
  for (const match of content.matchAll(/\$\{(\w+)\}/g)) {
    varNames.add(match[1]);
  }
  const record = Object.fromEntries(
    [...varNames].sort().map((name) => [name, process.env[name] ?? ""]),
  );
  return createHash("sha256").update(JSON.stringify(record)).digest("hex").slice(0, 8);
}
