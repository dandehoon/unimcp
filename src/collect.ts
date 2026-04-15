import path from "path";
import { type ServerConfig, VSCODE_MCP_PATH, CURSOR_GLOBAL_PATH, CLAUDE_GLOBAL_PATH, OPENCODE_PATH } from "./config.js";
import { stripJsonComments, log, readFileSafe, writeFileSafe, parseJsonSafe, toJson, PERMS_PUBLIC, PERMS_PRIVATE } from "./utils.js";

const CWD = process.cwd();

export type CollectOptions = {
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

type MergeResult = { merged: Record<string, ServerConfig>; count: number };

const SOURCES: SourceDef[] = [
  { label: "Claude Code (user)",    read: () => readMcpServersFile(CLAUDE_GLOBAL_PATH) },
  { label: "Claude Code (project)", read: () => readMcpServersFile(path.join(CWD, ".mcp.json")) },
  { label: "Cursor (global)",       read: () => readMcpServersFile(CURSOR_GLOBAL_PATH) },
  { label: "VS Code / Copilot",     read: readVsCodeGlobal },
  { label: "OpenCode",              read: readOpenCode },
];

// --- public entry point ---

export function runCollect(opts: CollectOptions): void {
  const { merged, count } = mergeSources(SOURCES);
  const json = toJson({ mcpServers: merged });

  if (opts.save) {
    writeFileSafe(opts.mcpFilePath, json, PERMS_PRIVATE);
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
    const keys = Object.keys(servers);
    if (keys.length > 0) {
      log(`[collect] ${src.label}: ${keys.length} server(s) — ${keys.join(", ")}`);
      Object.assign(merged, servers);
    }
  }
  return { merged, count: Object.keys(merged).length };
}

type ReadSectionOpts = {
  sectionKey: string;
  mapper: (srv: Record<string, unknown>) => ServerConfig | null;
  preprocess?: (s: string) => string;
};

function readMappedSection(filePath: string, opts: ReadSectionOpts): Record<string, ServerConfig> {
  const config = readJsonFile(filePath, opts.preprocess);
  if (!config) return {};
  const section = (config[opts.sectionKey] ?? {}) as Record<string, Record<string, unknown>>;
  const result: Record<string, ServerConfig> = {};
  for (const [name, srv] of Object.entries(section)) {
    const mapped = opts.mapper(srv);
    if (mapped) result[name] = mapped;
  }
  return result;
}

function readJsonFile(
  filePath: string,
  preprocess: (s: string) => string = (s) => s,
): Record<string, unknown> | null {
  const raw = readFileSafe(filePath);
  if (!raw) return null;
  return parseJsonSafe<Record<string, unknown>>(preprocess(raw), filePath);
}

function readMcpServersFile(filePath: string): Record<string, ServerConfig> {
  const config = readJsonFile(filePath);
  if (!config) return {};
  const raw = config["mcpServers"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, ServerConfig>;
}

function readVsCodeGlobal(): Record<string, ServerConfig> {
  return readMappedSection(VSCODE_MCP_PATH, { sectionKey: "servers", mapper: mapVsCodeServer, preprocess: stripJsonComments });
}

function readOpenCode(): Record<string, ServerConfig> {
  return readMappedSection(OPENCODE_PATH, { sectionKey: "mcp", mapper: mapOpenCodeServer });
}

function mapVsCodeServer(srv: Record<string, unknown>): ServerConfig {
  if (srv["type"] === "http" || srv["url"]) {
    const url = String(srv["url"] ?? "");
    const headers = srv["headers"] as Record<string, string> | undefined;
    return { type: "http", url, headers } as ServerConfig;
  }
  const command = String(srv["command"] ?? "");
  const args = srv["args"] as string[] | undefined;
  const env = srv["env"] as Record<string, string> | undefined;
  return { command, args, env } as ServerConfig;
}

function mapOpenCodeServer(srv: Record<string, unknown>): ServerConfig | null {
  if (!srv["enabled"]) return null;
  const cmd = srv["command"];
  if (!Array.isArray(cmd) || cmd.length === 0) return null;
  return { command: String(cmd[0]), args: cmd.slice(1).map(String) } as ServerConfig;
}
