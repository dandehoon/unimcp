import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import os from "os";
import { stripJsonComments } from "./utils.js";

const HOME = os.homedir();
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
  inject: (raw: string, binPath: string, clientId: string) => string;
};

const TARGETS: TargetDef[] = [
  {
    id: "claude",
    label: "Claude Code",
    globalConfigPath: path.join(HOME, ".claude.json"),
    localConfigPath: path.join(CWD, ".mcp.json"),
    inject: injectMcpServers,
  },
  {
    id: "cursor",
    label: "Cursor",
    globalConfigPath: path.join(HOME, ".cursor", "mcp.json"),
    localConfigPath: path.join(CWD, ".cursor", "mcp.json"),
    inject: injectMcpServers,
  },
  {
    id: "copilot",
    label: "VS Code / GitHub Copilot",
    globalConfigPath: path.join(HOME, "Library", "Application Support", "Code", "User", "mcp.json"),
    localConfigPath: path.join(CWD, ".vscode", "mcp.json"),
    inject: injectVsCodeServers,
  },
  {
    id: "opencode",
    label: "OpenCode",
    globalConfigPath: path.join(HOME, ".config", "opencode", "opencode.json"),
    localConfigPath: null,
    inject: injectOpenCode,
  },
];

// --- public entry point ---

export async function runSetup(argv: string[]): Promise<void> {
  const binPath = resolveUnimcpBin();
  const isGlobal = argv.includes("--global");
  const targetFilter = parseTargetFlag(argv);
  const forceWrite = targetFilter !== null;

  const targets = TARGETS.filter((t) => targetFilter === null || targetFilter.includes(t.id));

  if (isGlobal) {
    registerGlobal(targets, binPath, forceWrite);
  } else {
    registerLocal(targets, binPath);
  }
}

// --- helpers ---

function registerLocal(targets: TargetDef[], binPath: string): void {
  const localTargets = targets.filter((t) => t.localConfigPath !== null);

  if (localTargets.length === 0) {
    console.error("[setup] no targets support project-level config (try --global)");
    return;
  }

  for (const target of localTargets) {
    registerTarget(target.label, target.localConfigPath!, binPath, target.inject, target.id);
  }
}

function registerGlobal(targets: TargetDef[], binPath: string, force: boolean): void {
  let registered = 0;

  for (const target of targets) {
    const configPath = target.globalConfigPath;

    if (!force && !existsSync(configPath)) {
      console.error(`[setup] ${target.label}: config not found — skipped (use --target to force)`);
      continue;
    }

    registerTarget(target.label, configPath, binPath, target.inject, target.id);
    registered++;
  }

  if (registered === 0) {
    console.error("[setup] no global configs found — run 'unimcp setup' (local) instead");
  }
}

function registerTarget(
  label: string,
  configPath: string,
  binPath: string,
  inject: (raw: string, binPath: string, clientId: string) => string,
  clientId: string,
): void {
  const fileExists = existsSync(configPath);
  mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o755 });

  const existing = fileExists ? readFileSync(configPath, "utf-8") : "";
  const updated = inject(existing, binPath, clientId);

  if (updated === existing) {
    console.error(`[setup] ${label}: already registered — skipped`);
    return;
  }

  writeFileSync(configPath, updated, { encoding: "utf-8", mode: 0o644 });
  console.error(`[setup] ${label}: registered at ${configPath}`);
}

function resolveUnimcpBin(): string {
  if (existsSync(SYSTEM_BIN_PATH)) return SYSTEM_BIN_PATH;
  return process.execPath;
}

function parseTargetFlag(argv: string[]): TargetId[] | null {
  const flag = argv.find((a) => a.startsWith("--target=") || a === "--target");
  if (!flag) return null;

  const raw = flag.includes("=") ? flag.split("=")[1] : argv[argv.indexOf(flag) + 1];
  if (!raw) return null;

  return raw.split(",").map((s) => s.trim()) as TargetId[];
}

export function injectMcpServers(raw: string, binPath: string, clientId: string): string {
  const config = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  const servers = (config["mcpServers"] ?? {}) as Record<string, unknown>;

  if (servers[SERVER_NAME]) return raw;

  servers[SERVER_NAME] = { command: binPath, env: { UNIMCP_CLIENT: clientId } };
  config["mcpServers"] = servers;
  return JSON.stringify(config, null, 2) + "\n";
}

export function injectVsCodeServers(raw: string, binPath: string, clientId: string): string {
  const stripped = stripJsonComments(raw);
  const config = stripped.trim() ? (JSON.parse(stripped) as Record<string, unknown>) : {};
  const servers = (config["servers"] ?? {}) as Record<string, unknown>;

  if (servers[SERVER_NAME]) return raw;

  servers[SERVER_NAME] = { type: "stdio", command: binPath, args: [], env: { UNIMCP_CLIENT: clientId } };
  config["servers"] = servers;
  if (!config["inputs"]) config["inputs"] = [];
  return JSON.stringify(config, null, 2) + "\n";
}

export function injectOpenCode(raw: string, binPath: string, clientId: string): string {
  const config = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  const mcp = (config["mcp"] ?? {}) as Record<string, unknown>;

  if (mcp[SERVER_NAME]) return raw;

  mcp[SERVER_NAME] = { type: "local", command: [binPath], enabled: true, env: { UNIMCP_CLIENT: clientId } };
  config["mcp"] = mcp;
  return JSON.stringify(config, null, 2) + "\n";
}
