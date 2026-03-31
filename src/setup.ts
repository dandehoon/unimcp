/**
 * Setup command: registers unimcp as an MCP server in supported editors.
 *
 * Supported targets:
 *   - claude   → ~/Library/Application Support/Claude/claude_desktop_config.json
 *   - cursor   → ~/.cursor/mcp.json
 *   - copilot  → ~/Library/Application Support/Code/User/mcp.json  (VS Code / GitHub Copilot)
 *   - opencode → ~/.config/opencode/opencode.json
 *
 * Usage:
 *   unimcp setup              # register in all detected/installed targets
 *   unimcp setup --global     # same (alias; all targets are global by nature)
 *   unimcp setup --target claude,copilot
 */
import { existsSync, readFileSync, mkdirSync } from "fs";
import { writeFileSync } from "fs";
import path from "path";
import os from "os";

const HOME = os.homedir();
const SERVER_NAME = "unimcp";

// --- target definitions ---

type TargetId = "claude" | "cursor" | "copilot" | "opencode";

type TargetDef = {
  id: TargetId;
  label: string;
  configPath: string;
  isInstalled: () => boolean;
  inject: (raw: string, binPath: string) => string;
};

const TARGETS: TargetDef[] = [
  {
    id: "claude",
    label: "Claude Desktop",
    configPath: path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    isInstalled: () => existsSync(path.join("/Applications", "Claude.app")) || existsSync(path.join(HOME, "Applications", "Claude.app")),
    inject: injectMcpServers,
  },
  {
    id: "cursor",
    label: "Cursor",
    configPath: path.join(HOME, ".cursor", "mcp.json"),
    isInstalled: () => existsSync(path.join("/Applications", "Cursor.app")) || existsSync(path.join(HOME, ".cursor")),
    inject: injectMcpServers,
  },
  {
    id: "copilot",
    label: "VS Code / GitHub Copilot",
    configPath: path.join(HOME, "Library", "Application Support", "Code", "User", "mcp.json"),
    isInstalled: () => existsSync(path.join("/Applications", "Visual Studio Code.app")) || existsSync(path.join(HOME, "Library", "Application Support", "Code")),
    inject: injectVsCodeServers,
  },
  {
    id: "opencode",
    label: "OpenCode",
    configPath: path.join(HOME, ".config", "opencode", "opencode.json"),
    isInstalled: () => existsSync(path.join(HOME, ".config", "opencode")),
    inject: injectOpenCode,
  },
];

// --- public entry point ---

export async function runSetup(argv: string[]): Promise<void> {
  const binPath = resolveUnimcpBin();
  const targetFilter = parseTargetFlag(argv);
  const useGlobal = argv.includes("--global"); // alias flag — all targets are global

  if (useGlobal) {
    console.error("[setup] --global flag acknowledged (all targets are global by default)");
  }

  const targets = TARGETS.filter((t) => targetFilter === null || targetFilter.includes(t.id));
  const applicable = targets.filter((t) => t.isInstalled());

  if (applicable.length === 0) {
    console.error("[setup] no supported editors detected — nothing to do");
    console.error("[setup] supported: claude, cursor, copilot, opencode");
    return;
  }

  for (const target of applicable) {
    registerTarget(target, binPath);
  }
}

// --- helpers ---

function resolveUnimcpBin(): string {
  // Prefer the installed system binary; fall back to current process.
  const systemBin = "/usr/local/bin/unimcp";
  if (existsSync(systemBin)) return systemBin;
  return process.execPath; // compiled binary path
}

function parseTargetFlag(argv: string[]): TargetId[] | null {
  const flag = argv.find((a) => a.startsWith("--target=") || a === "--target");
  if (!flag) return null;

  const raw = flag.includes("=") ? flag.split("=")[1] : argv[argv.indexOf(flag) + 1];
  if (!raw) return null;

  return raw.split(",").map((s) => s.trim()) as TargetId[];
}

function registerTarget(target: TargetDef, binPath: string): void {
  const dir = path.dirname(target.configPath);
  mkdirSync(dir, { recursive: true });

  const existing = existsSync(target.configPath) ? readFileSync(target.configPath, "utf-8") : "";
  const updated = target.inject(existing, binPath);

  if (updated === existing) {
    console.error(`[setup] ${target.label}: already registered — skipped`);
    return;
  }

  writeFileSync(target.configPath, updated, "utf-8");
  console.error(`[setup] ${target.label}: registered at ${target.configPath}`);
}

/** Injects into {"mcpServers": {...}} format (Claude Desktop, Cursor). */
function injectMcpServers(raw: string, binPath: string): string {
  const config = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  const servers = (config["mcpServers"] ?? {}) as Record<string, unknown>;

  if (servers[SERVER_NAME]) return raw; // already present — dedup

  servers[SERVER_NAME] = { command: binPath, args: [] };
  config["mcpServers"] = servers;
  return JSON.stringify(config, null, 2) + "\n";
}

/** Injects into {"servers": {...}} format (VS Code / GitHub Copilot). */
function injectVsCodeServers(raw: string, binPath: string): string {
  // VS Code mcp.json uses JSONC (allows comments) — strip them before parsing.
  const stripped = stripJsonComments(raw);
  const config = stripped.trim() ? (JSON.parse(stripped) as Record<string, unknown>) : {};
  const servers = (config["servers"] ?? {}) as Record<string, unknown>;

  if (servers[SERVER_NAME]) return raw; // already present — dedup

  servers[SERVER_NAME] = { type: "stdio", command: binPath, args: [] };
  config["servers"] = servers;
  if (!config["inputs"]) config["inputs"] = [];
  return JSON.stringify(config, null, 2) + "\n";
}

/** Injects into {"mcp": {...}} format (OpenCode). */
function injectOpenCode(raw: string, binPath: string): string {
  const config = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  const mcp = (config["mcp"] ?? {}) as Record<string, unknown>;

  if (mcp[SERVER_NAME]) return raw; // already present — dedup

  mcp[SERVER_NAME] = { type: "local", command: [binPath], enabled: true };
  config["mcp"] = mcp;
  return JSON.stringify(config, null, 2) + "\n";
}

/**
 * Strips // line comments and /* block comments from JSONC,
 * skipping content inside quoted strings.
 */
function stripJsonComments(raw: string): string {
  let result = "";
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '"') {
      // consume entire string literal (handles \" escapes)
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
      // skip until end of line
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }
    if (raw[i] === "/" && raw[i + 1] === "*") {
      // skip until end of block comment
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    result += raw[i++];
  }
  return result;
}
