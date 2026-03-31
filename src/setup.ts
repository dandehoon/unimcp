/**
 * Setup command: registers unimcp as an MCP server in supported editors.
 *
 * Modes:
 *   unimcp setup              # local: write to .cursor/mcp.json + .vscode/mcp.json in cwd
 *   unimcp setup --global     # global: update existing user-level configs only (no new files)
 *   unimcp setup --target claude,copilot           # local for those targets
 *   unimcp setup --global --target claude,copilot  # global, forced even if file doesn't exist
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import os from "os";

const HOME = os.homedir();
const CWD = process.cwd();
const SERVER_NAME = "unimcp";

// --- target definitions ---

type TargetId = "claude" | "cursor" | "copilot" | "opencode";

type TargetDef = {
  id: TargetId;
  label: string;
  globalConfigPath: string;
  localConfigPath: string | null; // null = no project-level equivalent
  inject: (raw: string, binPath: string) => string;
};

const TARGETS: TargetDef[] = [
  {
    id: "claude",
    label: "Claude Desktop",
    globalConfigPath: path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    localConfigPath: null, // Claude Desktop has no project-level config
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
    localConfigPath: null, // OpenCode has no project-level config
    inject: injectOpenCode,
  },
];

// --- public entry point ---

export async function runSetup(argv: string[]): Promise<void> {
  const binPath = resolveUnimcpBin();
  const isGlobal = argv.includes("--global");
  const targetFilter = parseTargetFlag(argv);
  const forceWrite = targetFilter !== null; // explicit --target always writes

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
    registerTarget(target.label, target.localConfigPath!, binPath, target.inject, true);
  }
}

function registerGlobal(targets: TargetDef[], binPath: string, force: boolean): void {
  let registered = 0;

  for (const target of targets) {
    const configPath = target.globalConfigPath;
    const fileExists = existsSync(configPath);

    if (!force && !fileExists) {
      console.error(`[setup] ${target.label}: config not found — skipped (use --target to force)`);
      continue;
    }

    registerTarget(target.label, configPath, binPath, target.inject, true);
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
  inject: (raw: string, binPath: string) => string,
  createIfMissing: boolean
): void {
  const fileExists = existsSync(configPath);
  if (!fileExists && !createIfMissing) return;

  const dir = path.dirname(configPath);
  mkdirSync(dir, { recursive: true });

  const existing = fileExists ? readFileSync(configPath, "utf-8") : "";
  const updated = inject(existing, binPath);

  if (updated === existing) {
    console.error(`[setup] ${label}: already registered — skipped`);
    return;
  }

  writeFileSync(configPath, updated, "utf-8");
  console.error(`[setup] ${label}: registered at ${configPath}`);
}

function resolveUnimcpBin(): string {
  // Prefer the installed system binary; fall back to current process.
  const systemBin = "/usr/local/bin/unimcp";
  if (existsSync(systemBin)) return systemBin;
  return process.execPath;
}

function parseTargetFlag(argv: string[]): TargetId[] | null {
  const flag = argv.find((a) => a.startsWith("--target=") || a === "--target");
  if (!flag) return null;

  const raw = flag.includes("=") ? flag.split("=")[1] : argv[argv.indexOf(flag) + 1];
  if (!raw) return null;

  return raw.split(",").map((s) => s.trim()) as TargetId[];
}

/** Injects into {"mcpServers": {...}} format (Claude Desktop, Cursor). */
function injectMcpServers(raw: string, binPath: string): string {
  const config = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  const servers = (config["mcpServers"] ?? {}) as Record<string, unknown>;

  if (servers[SERVER_NAME]) return raw; // dedup

  servers[SERVER_NAME] = { command: binPath, args: [] };
  config["mcpServers"] = servers;
  return JSON.stringify(config, null, 2) + "\n";
}

/** Injects into {"servers": {...}} format (VS Code / GitHub Copilot). */
function injectVsCodeServers(raw: string, binPath: string): string {
  const stripped = stripJsonComments(raw);
  const config = stripped.trim() ? (JSON.parse(stripped) as Record<string, unknown>) : {};
  const servers = (config["servers"] ?? {}) as Record<string, unknown>;

  if (servers[SERVER_NAME]) return raw; // dedup

  servers[SERVER_NAME] = { type: "stdio", command: binPath, args: [] };
  config["servers"] = servers;
  if (!config["inputs"]) config["inputs"] = [];
  return JSON.stringify(config, null, 2) + "\n";
}

/** Injects into {"mcp": {...}} format (OpenCode). */
function injectOpenCode(raw: string, binPath: string): string {
  const config = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  const mcp = (config["mcp"] ?? {}) as Record<string, unknown>;

  if (mcp[SERVER_NAME]) return raw; // dedup

  mcp[SERVER_NAME] = { type: "local", command: [binPath], enabled: true };
  config["mcp"] = mcp;
  return JSON.stringify(config, null, 2) + "\n";
}

/**
 * Strips // line comments and block comments from JSONC,
 * respecting quoted string boundaries.
 */
function stripJsonComments(raw: string): string {
  let result = "";
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '"') {
      result += raw[i++];
      while (i < raw.length) {
        const ch = raw[i];
        result += ch;
        i++;
        if (ch === "\\" && i < raw.length) { result += raw[i++]; continue; }
        if (ch === '"') break;
      }
      continue;
    }
    if (raw[i] === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }
    if (raw[i] === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    result += raw[i++];
  }
  return result;
}
