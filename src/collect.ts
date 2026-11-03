import path from "path";
import {
  type ServerConfig,
  VSCODE_MCP_PATH,
  CURSOR_GLOBAL_PATH,
  CLAUDE_GLOBAL_PATH,
  ANTIGRAVITY_GLOBAL_PATH,
  openCodeGlobalPath,
} from "./config.js";
import { SERVER_NAME } from "./setup-inject.js";
import { isPlainObject, log, readFileSafe, writeFileSafe, parseJsonc, toJson, PERMS_PUBLIC, PERMS_PRIVATE } from "./utils.js";

const CWD = process.cwd();

export type CollectOptions = {
  outputPath: string | null;
  save: boolean;
  mcpFilePath: string;
};

// --- source definitions ---

type Entry = Record<string, unknown>;
type Mapper = (srv: Entry) => ServerConfig | null;

type SourceDef = {
  label: string;
  read: () => Record<string, ServerConfig>;
};

type MergeResult = { merged: Record<string, ServerConfig>; count: number };

const SOURCES: SourceDef[] = [
  { label: "Claude Code (user)",    read: () => readSection(CLAUDE_GLOBAL_PATH, ["mcpServers"], asIs) },
  { label: "Claude Code (project)", read: () => readSection(path.join(CWD, ".mcp.json"), ["mcpServers"], asIs) },
  { label: "Cursor (global)",       read: () => readSection(CURSOR_GLOBAL_PATH, ["mcpServers"], asIs) },
  { label: "VS Code / Copilot",     read: () => readSection(VSCODE_MCP_PATH, ["servers"], mapVsCodeServer) },
  { label: "OpenCode",              read: readOpenCode },
  { label: "Antigravity",           read: () => readSection(ANTIGRAVITY_GLOBAL_PATH, ["mcpServers"], mapAntigravityServer) },
];

// --- public entry point ---

export function runCollect(opts: CollectOptions): void {
  const { merged, count } = mergeSources(SOURCES);
  const json = toJson({ mcpServers: merged });

  if (opts.save) {
    // Only the servers are collected; everything else in the file (grants) is the user's own.
    const existing = readOwnConfig(opts.mcpFilePath);
    writeFileSafe(opts.mcpFilePath, toJson({ ...existing, mcpServers: merged }), PERMS_PRIVATE);
    log(`[collect] saved ${count} server(s) to ${opts.mcpFilePath}`);
    return;
  }

  if (opts.outputPath) {
    writeFileSafe(opts.outputPath, json, PERMS_PUBLIC);
    log(`[collect] wrote ${count} server(s) to ${opts.outputPath}`);
    return;
  }

  process.stdout.write(json);
}

// --- helpers ---

function mergeSources(sources: SourceDef[]): MergeResult {
  const merged: Record<string, ServerConfig> = {};
  for (const src of sources) {
    const servers = src.read();
    // A client's own unimcp entry would make the daemon spawn itself.
    delete servers[SERVER_NAME];
    const keys = Object.keys(servers);
    if (keys.length > 0) {
      log(`[collect] ${src.label}: ${keys.length} server(s) — ${keys.join(", ")}`);
      Object.assign(merged, servers);
    }
  }
  return { merged, count: Object.keys(merged).length };
}

function readSection(filePath: string, keyPath: string[], mapper: Mapper): Record<string, ServerConfig> {
  let node: unknown = readJsonFile(filePath);
  for (const key of keyPath) node = isPlainObject(node) ? node[key] : undefined;
  return mapEntries(node, mapper);
}

/** OpenCode v2 nests servers under `mcp.servers`; the older `mcp.<name>` shape still loads. */
function readOpenCode(): Record<string, ServerConfig> {
  const mcp = readJsonFile(openCodeGlobalPath())?.["mcp"];
  if (!isPlainObject(mcp)) return {};
  const { servers, ...legacy } = mcp;
  return { ...mapEntries(legacy, mapOpenCodeServer), ...mapEntries(servers, mapOpenCodeServer) };
}

function mapEntries(section: unknown, mapper: Mapper): Record<string, ServerConfig> {
  if (!isPlainObject(section)) return {};
  const result: Record<string, ServerConfig> = {};
  for (const [name, srv] of Object.entries(section)) {
    const mapped = isPlainObject(srv) ? mapper(srv) : null;
    if (mapped) result[name] = mapped;
  }
  return result;
}

function readJsonFile(filePath: string): Entry | null {
  const raw = readFileSafe(filePath);
  if (!raw) return null;
  try {
    const parsed = parseJsonc(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    log(`warning: could not parse ${filePath}`);
    return null;
  }
}

/** Unlike a client's file, ours must parse: falling back to `{}` would drop the grants on save. */
function readOwnConfig(filePath: string): Entry {
  const raw = readFileSafe(filePath);
  if (raw === null || raw.trim() === "") return {};
  const parsed = parseJsonc(raw);
  if (!isPlainObject(parsed)) throw new Error(`${filePath} is not a JSON object`);
  return parsed;
}

function asIs(srv: Entry): ServerConfig {
  return srv as ServerConfig;
}

function mapVsCodeServer(srv: Entry): ServerConfig {
  if (srv["type"] === "http" || srv["type"] === "sse" || srv["url"]) {
    const type = srv["type"] === "sse" ? "sse" : "http";
    return { type, url: String(srv["url"] ?? ""), headers: srv["headers"] } as ServerConfig;
  }
  return { command: String(srv["command"] ?? ""), args: srv["args"], env: srv["env"] } as ServerConfig;
}

function mapOpenCodeServer(srv: Entry): ServerConfig | null {
  if (srv["disabled"] === true || srv["enabled"] === false) return null;
  if (srv["type"] === "remote") {
    return { type: "http", url: String(srv["url"] ?? ""), headers: srv["headers"] } as ServerConfig;
  }
  const cmd = srv["command"];
  if (!Array.isArray(cmd) || cmd.length === 0) return null;
  return { command: String(cmd[0]), args: cmd.slice(1).map(String), env: srv["environment"] } as ServerConfig;
}

function mapAntigravityServer(srv: Entry): ServerConfig | null {
  if (srv["disabled"] === true) return null;
  const url = srv["serverUrl"] ?? srv["url"];
  if (url) return { type: "http", url: String(url), headers: srv["headers"] } as ServerConfig;
  return { command: String(srv["command"] ?? ""), args: srv["args"], env: srv["env"] } as ServerConfig;
}
