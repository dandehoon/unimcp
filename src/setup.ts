import { existsSync } from "fs";
import path from "path";

import {
  VSCODE_MCP_PATH,
  CLAUDE_GLOBAL_PATH,
  CURSOR_GLOBAL_PATH,
  CODEX_GLOBAL_PATH,
  ANTIGRAVITY_GLOBAL_PATH,
  openCodeGlobalPath,
} from "./config.js";
import {
  type Injector,
  type Launch,
  injectMcpServers,
  injectAntigravity,
  injectVsCodeServers,
  injectOpenCode,
  injectCodex,
} from "./setup-inject.js";
import { log, readFileSafe, writeFileSafe, PERMS_PUBLIC } from "./utils.js";

const CWD = process.cwd();
const SYSTEM_BIN_PATH = "/usr/local/bin/unimcp";
const SCRIPT_RUNTIMES = new Set(["node", "bun", "node.exe", "bun.exe"]);

// --- target definitions ---

type TargetDef = {
  id: string;
  label: string;
  globalConfigPath: () => string;
  localConfigPath: string | null;
  inject: Injector;
};

export const TARGETS: TargetDef[] = [
  {
    id: "claude",
    label: "Claude Code",
    globalConfigPath: () => CLAUDE_GLOBAL_PATH,
    localConfigPath: path.join(CWD, ".mcp.json"),
    inject: injectMcpServers,
  },
  {
    id: "cursor",
    label: "Cursor",
    globalConfigPath: () => CURSOR_GLOBAL_PATH,
    localConfigPath: path.join(CWD, ".cursor", "mcp.json"),
    inject: injectMcpServers,
  },
  {
    id: "copilot",
    label: "VS Code / GitHub Copilot",
    globalConfigPath: () => VSCODE_MCP_PATH,
    localConfigPath: path.join(CWD, ".vscode", "mcp.json"),
    inject: injectVsCodeServers,
  },
  {
    id: "opencode",
    label: "OpenCode",
    globalConfigPath: openCodeGlobalPath,
    localConfigPath: null,
    inject: injectOpenCode,
  },
  {
    id: "codex",
    label: "Codex",
    globalConfigPath: () => CODEX_GLOBAL_PATH,
    localConfigPath: path.join(CWD, ".codex", "config.toml"),
    inject: injectCodex,
  },
  {
    id: "antigravity",
    label: "Antigravity",
    globalConfigPath: () => ANTIGRAVITY_GLOBAL_PATH,
    localConfigPath: path.join(CWD, ".agents", "mcp_config.json"),
    inject: injectAntigravity,
  },
];

// --- public entry point ---

export type SetupOpts = {
  isGlobal: boolean;
  targets: string[] | null;
};

export async function runSetup(opts: SetupOpts): Promise<void> {
  const launch = resolveLaunch();
  const forceWrite = opts.targets !== null;

  const targets = TARGETS.filter((t) => opts.targets === null || opts.targets.includes(t.id));

  if (opts.isGlobal) {
    registerGlobal(targets, launch, forceWrite);
  } else {
    registerLocal(targets, launch);
  }
}

// --- helpers ---

function registerLocal(targets: TargetDef[], launch: Launch): void {
  const localTargets = targets.filter((t) => t.localConfigPath !== null);

  if (localTargets.length === 0) {
    log("[setup] no targets support project-level config (try --global)");
    return;
  }

  for (const target of localTargets) {
    registerTarget({ label: target.label, configPath: target.localConfigPath!, launch, inject: target.inject, force: true });
  }
}

function registerGlobal(targets: TargetDef[], launch: Launch, force: boolean): void {
  let isAnyFound = false;

  for (const target of targets) {
    const configPath = target.globalConfigPath();
    const outcome = registerTarget({ label: target.label, configPath, launch, inject: target.inject, force });
    if (outcome !== "missing") isAnyFound = true;
  }

  if (!isAnyFound) {
    log("[setup] no global configs found — run 'unimcp setup' (local) instead");
  }
}

type RegisterTargetOpts = {
  label: string;
  configPath: string;
  launch: Launch;
  inject: Injector;
  force?: boolean;
};

type RegisterOutcome = "registered" | "missing" | "unreadable";

function registerTarget(opts: RegisterTargetOpts): RegisterOutcome {
  const raw = readFileSafe(opts.configPath);

  if (!opts.force && raw === null) {
    log(`[setup] ${opts.label}: config not found — skipped (use --target to force)`);
    return "missing";
  }

  const existing = raw ?? "";
  let updated: string;
  try {
    updated = opts.inject(existing, opts.launch);
  } catch (err) {
    log(`[setup] ${opts.label}: could not read ${opts.configPath} (${(err as Error).message}) — skipped, file left as is`);
    return "unreadable";
  }

  if (updated === existing) {
    log(`[setup] ${opts.label}: already registered — skipped`);
    return "registered";
  }

  writeFileSafe(opts.configPath, updated, PERMS_PUBLIC);
  log(`[setup] ${opts.label}: registered at ${opts.configPath}`);
  return "registered";
}

/** The installed binary if present; else this process — a compiled binary, or runtime + script (npm, `bun run`). */
function resolveLaunch(): Launch {
  if (existsSync(SYSTEM_BIN_PATH)) return { command: SYSTEM_BIN_PATH, args: [] };
  const script = process.argv[1];
  if (!SCRIPT_RUNTIMES.has(path.basename(process.execPath)) || !script) return { command: process.execPath, args: [] };
  const scriptPath = path.resolve(script);
  if (scriptPath.includes(`${path.sep}_npx${path.sep}`)) {
    log("[setup] warning: registering a path in the npx cache, which may be cleared — install unimcp globally to keep it");
  }
  return { command: process.execPath, args: [scriptPath] };
}
