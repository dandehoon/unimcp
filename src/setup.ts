import { existsSync } from "fs";
import path from "path";

import { VSCODE_MCP_PATH, CLAUDE_GLOBAL_PATH, CURSOR_GLOBAL_PATH, OPENCODE_PATH } from "./config.js";
import { stripJsonComments, log, readFileSafe, parseJsonSafe, toJson, writeFileSafe, PERMS_PUBLIC } from "./utils.js";

const CWD = process.cwd();
const SERVER_NAME = "unimcp";
const SYSTEM_BIN_PATH = "/usr/local/bin/unimcp";

// --- target definitions ---

type TargetId = "claude" | "cursor" | "copilot" | "opencode";

type TargetDef = {
  id: TargetId;
  label: string;
  globalConfigPath: string;
  localConfigPath: string | null;
  inject: (raw: string, binPath: string) => string;
};

const TARGETS: TargetDef[] = [
  {
    id: "claude",
    label: "Claude Code",
    globalConfigPath: CLAUDE_GLOBAL_PATH,
    localConfigPath: path.join(CWD, ".mcp.json"),
    inject: injectMcpServers,
  },
  {
    id: "cursor",
    label: "Cursor",
    globalConfigPath: CURSOR_GLOBAL_PATH,
    localConfigPath: path.join(CWD, ".cursor", "mcp.json"),
    inject: injectMcpServers,
  },
  {
    id: "copilot",
    label: "VS Code / GitHub Copilot",
    globalConfigPath: VSCODE_MCP_PATH,
    localConfigPath: path.join(CWD, ".vscode", "mcp.json"),
    inject: injectVsCodeServers,
  },
  {
    id: "opencode",
    label: "OpenCode",
    globalConfigPath: OPENCODE_PATH,
    localConfigPath: null,
    inject: injectOpenCode,
  },
];

// --- public entry point ---

export type SetupOpts = {
  isGlobal: boolean;
  targets: string[] | null;
};

export async function runSetup(opts: SetupOpts): Promise<void> {
  const binPath = resolveUnimcpBin();
  const forceWrite = opts.targets !== null;

  const targets = TARGETS.filter((t) => opts.targets === null || opts.targets.includes(t.id));

  if (opts.isGlobal) {
    registerGlobal(targets, binPath, forceWrite);
  } else {
    registerLocal(targets, binPath);
  }
}

// --- helpers ---

function registerLocal(targets: TargetDef[], binPath: string): void {
  const localTargets = targets.filter((t) => t.localConfigPath !== null);

  if (localTargets.length === 0) {
    log("[setup] no targets support project-level config (try --global)");
    return;
  }

  for (const target of localTargets) {
    registerTarget({ label: target.label, configPath: target.localConfigPath!, binPath, inject: target.inject, force: true });
  }
}

function registerGlobal(targets: TargetDef[], binPath: string, force: boolean): void {
  let registered = 0;

  for (const target of targets) {
    const configPath = target.globalConfigPath;
    const did = registerTarget({ label: target.label, configPath, binPath, inject: target.inject, force });
    if (did) registered++;
  }

  if (registered === 0) {
    log("[setup] no global configs found — run 'unimcp setup' (local) instead");
  }
}

type RegisterTargetOpts = {
  label: string;
  configPath: string;
  binPath: string;
  inject: (raw: string, binPath: string) => string;
  force?: boolean;
};

function registerTarget(opts: RegisterTargetOpts): boolean {
  const raw = readFileSafe(opts.configPath);

  if (!opts.force && raw === null) {
    log(`[setup] ${opts.label}: config not found — skipped (use --target to force)`);
    return false;
  }

  const existing = raw ?? "";
  const updated = opts.inject(existing, opts.binPath);

  if (updated === existing) {
    log(`[setup] ${opts.label}: already registered — skipped`);
    return true;
  }

  writeFileSafe(opts.configPath, updated, PERMS_PUBLIC);
  log(`[setup] ${opts.label}: registered at ${opts.configPath}`);
  return true;
}

function resolveUnimcpBin(): string {
  if (existsSync(SYSTEM_BIN_PATH)) return SYSTEM_BIN_PATH;
  return process.execPath;
}

export function injectMcpServers(raw: string, binPath: string): string {
  return injectEntry(raw, { key: "mcpServers", entry: { command: binPath } });
}

export function injectVsCodeServers(raw: string, binPath: string): string {
  const stripped = stripJsonComments(raw);
  const updated = injectEntry(stripped, { key: "servers", entry: { type: "stdio", command: binPath, args: [] }, mutate: ensureVsCodeInputs });
  return updated === stripped ? raw : updated;
}

export function injectOpenCode(raw: string, binPath: string): string {
  return injectEntry(raw, { key: "mcp", entry: { type: "local", command: [binPath], enabled: true } });
}

// --- helpers ---

function ensureVsCodeInputs(config: Record<string, unknown>): void {
  if (!config["inputs"]) config["inputs"] = [];
}

type ConfigMutator = (config: Record<string, unknown>) => void;
type InjectEntryOpts = { key: string; entry: unknown; mutate?: ConfigMutator };

function injectEntry(raw: string, opts: InjectEntryOpts): string {
  const config = raw.trim() ? (parseJsonSafe<Record<string, unknown>>(raw, "editor config") ?? {}) : {};
  const section = (config[opts.key] ?? {}) as Record<string, unknown>;

  if (section[SERVER_NAME]) return raw;

  section[SERVER_NAME] = opts.entry;
  config[opts.key] = section;
  opts.mutate?.(config);
  return toJson(config);
}
