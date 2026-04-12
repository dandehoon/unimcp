import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import type { ServerConfig } from "./config.js";
import { DEFAULT_MCP_FILE } from "./config.js";
import { stripJsonComments, parseFlagValue, log } from "./utils.js";

const HOME = os.homedir();
const CWD = process.cwd();

type CollectOptions = {
  outputPath: string | null;
  save: boolean;
  mcpFilePath: string;
};

// --- source definitions ---

type SourceReader = () => Record<string, ServerConfig>;

type SourceDef = {
  label: string;
  read: SourceReader;
};

// --- public entry point ---

export function runCollect(argv: string[]): void {
  const opts = parseCollectArgs(argv);

  const sources: SourceDef[] = [
    { label: "Claude Code (user)",    read: () => readMcpServersFile(path.join(HOME, ".claude.json")) },
    { label: "Claude Code (project)", read: () => readMcpServersFile(path.join(CWD, ".mcp.json")) },
    { label: "Cursor (global)",       read: () => readMcpServersFile(path.join(HOME, ".cursor", "mcp.json")) },
    { label: "VS Code / Copilot",     read: readVsCodeGlobal },
    { label: "OpenCode",              read: readOpenCode },
    { label: ".mcp.json (cwd)",       read: () => readMcpServersFile(path.join(CWD, ".mcp.json")) },
  ];

  const merged: Record<string, ServerConfig> = {};
  for (const src of sources) {
    const servers = src.read();
    const keys = Object.keys(servers);
    if (keys.length > 0) {
      log(`[collect] ${src.label}: ${keys.length} server(s) — ${keys.join(", ")}`);
      Object.assign(merged, servers);
    }
  }

  const output = { mcpServers: merged };
  const json = JSON.stringify(output, null, 2) + "\n";
  const count = Object.keys(merged).length;

  if (opts.save) {
    writeJson(opts.mcpFilePath, json, { dirMode: 0o700, fileMode: 0o600 });
    log(`[collect] saved ${count} server(s) to ${opts.mcpFilePath}`);
    return;
  }

  if (opts.outputPath) {
    writeJson(opts.outputPath, json, { dirMode: 0o755, fileMode: 0o644 });
    log(`[collect] wrote ${count} server(s) to ${opts.outputPath}`);
    return;
  }

  process.stdout.write(json);
}

// --- helpers ---

type WriteJsonOpts = { dirMode: number; fileMode: number };

function writeJson(filePath: string, content: string, modes: WriteJsonOpts): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: modes.dirMode });
  writeFileSync(filePath, content, { encoding: "utf-8", mode: modes.fileMode });
}

function parseCollectArgs(argv: string[]): CollectOptions {
  const save = argv.includes("--save");
  const mcpFilePath = parseFlagValue(argv, "--mcp-file") ?? DEFAULT_MCP_FILE;
  const outputPath = parseFlagValue(argv, "-o") ?? parseFlagValue(argv, "--output");
  return { save, mcpFilePath, outputPath };
}

/** Reads a plain {"mcpServers": {...}} file. Returns {} on missing/invalid. */
function readMcpServersFile(filePath: string): Record<string, ServerConfig> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    return (config["mcpServers"] ?? {}) as Record<string, ServerConfig>;
  } catch {
    log(`[collect] warning: could not parse ${filePath}`);
    return {};
  }
}

function readVsCodeGlobal(): Record<string, ServerConfig> {
  const filePath = path.join(HOME, "Library", "Application Support", "Code", "User", "mcp.json");
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf-8");
    const stripped = stripJsonComments(raw);
    const config = JSON.parse(stripped) as Record<string, unknown>;
    const servers = (config["servers"] ?? {}) as Record<string, Record<string, unknown>>;
    const result: Record<string, ServerConfig> = {};
    for (const [name, srv] of Object.entries(servers)) {
      result[name] = srv["type"] === "http" || srv["url"]
        ? mapVsCodeHttpServer(srv)
        : mapVsCodeStdioServer(srv);
    }
    return result;
  } catch {
    log(`[collect] warning: could not parse VS Code mcp.json`);
    return {};
  }
}

function readOpenCode(): Record<string, ServerConfig> {
  const filePath = path.join(HOME, ".config", "opencode", "opencode.json");
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const mcp = (config["mcp"] ?? {}) as Record<string, Record<string, unknown>>;
    const result: Record<string, ServerConfig> = {};
    for (const [name, srv] of Object.entries(mcp)) {
      if (!srv["enabled"]) continue;
      const cmd = srv["command"];
      if (Array.isArray(cmd) && cmd.length > 0) {
        result[name] = { command: String(cmd[0]), args: cmd.slice(1).map(String) } as ServerConfig;
      }
    }
    return result;
  } catch {
    log(`[collect] warning: could not parse opencode.json`);
    return {};
  }
}

function mapVsCodeHttpServer(srv: Record<string, unknown>): ServerConfig {
  return {
    type: "http",
    url: String(srv["url"] ?? ""),
    headers: srv["headers"] as Record<string, string> | undefined,
  } as ServerConfig;
}

function mapVsCodeStdioServer(srv: Record<string, unknown>): ServerConfig {
  return {
    command: String(srv["command"] ?? ""),
    args: srv["args"] as string[] | undefined,
    env: srv["env"] as Record<string, string> | undefined,
  } as ServerConfig;
}
