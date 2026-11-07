import { isPlainObject, parseJsonc, toJson } from "./utils.js";

export const SERVER_NAME = "unimcp";

/** How a client starts unimcp. */
export type Launch = { command: string; args: string[] };

export type Injector = (raw: string, launch: Launch) => string;

/** `mcpServers` with an explicit stdio type: Claude Code, Cursor. */
export function injectMcpServers(raw: string, launch: Launch): string {
  return injectJsonEntry(raw, { keyPath: ["mcpServers"], entry: { type: "stdio", ...launch } });
}

/** Antigravity's `mcp_config.json`: `mcpServers`, no `type` field. */
export function injectAntigravity(raw: string, launch: Launch): string {
  return injectJsonEntry(raw, { keyPath: ["mcpServers"], entry: { ...launch } });
}

export function injectVsCodeServers(raw: string, launch: Launch): string {
  return injectJsonEntry(raw, { keyPath: ["servers"], entry: { type: "stdio", ...launch } });
}

/**
 * OpenCode: `mcp.<name>`, command and args in one array. v2 moved servers to `mcp.servers`, but
 * its schema still loads this shape, and older versions know no other.
 */
export function injectOpenCode(raw: string, launch: Launch): string {
  if (hasOpenCodeV2Entry(raw)) return raw;
  const entry = { type: "local", command: [launch.command, ...launch.args], enabled: true };
  return injectJsonEntry(raw, { keyPath: ["mcp"], entry });
}

/** Codex `config.toml`: appends a `[mcp_servers.unimcp]` table, as `codex mcp add` does. */
export function injectCodex(raw: string, launch: Launch): string {
  if (hasCodexEntry(raw)) return raw;
  // A JSON string or string array is also a valid TOML basic string / array.
  const table = `[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(launch.command)}\nargs = ${JSON.stringify(launch.args)}\n`;
  if (raw.trim() === "") return table;
  return raw + (raw.endsWith("\n") ? "\n" : "\n\n") + table;
}

// --- helpers ---

const CODEX_ENTRY = `mcp_servers.${SERVER_NAME}`;
const TOML_HEADER_RE = /^\s*\[\[?([^\]]+)\]/;
const TOML_KEY_RE = /^\s*([^\s=#[][^=]*?)\s*=/;

/**
 * Whether any line defines a key at or under `mcp_servers.unimcp`: a table header, a dotted key, or an
 * inline table under `[mcp_servers]`. Line-based, so text inside a multi-line string could match too.
 */
function hasCodexEntry(raw: string): boolean {
  let table = "";
  for (const line of raw.split("\n")) {
    const header = TOML_HEADER_RE.exec(line);
    if (header) {
      table = normalizeTomlKey(header[1]!);
      if (isCodexEntryPath(table)) return true;
      continue;
    }
    const key = TOML_KEY_RE.exec(line);
    if (key && isCodexEntryPath([table, normalizeTomlKey(key[1]!)].filter(Boolean).join("."))) return true;
  }
  return false;
}

function isCodexEntryPath(keyPath: string): boolean {
  return keyPath === CODEX_ENTRY || keyPath.startsWith(`${CODEX_ENTRY}.`);
}

function normalizeTomlKey(key: string): string {
  return key.replace(/["'\s]/g, "");
}

type InjectJsonOpts = { keyPath: string[]; entry: unknown };

/** Adds the entry unless one exists; a file that doesn't parse throws rather than being overwritten. */
function injectJsonEntry(raw: string, opts: InjectJsonOpts): string {
  const config = parseObject(raw);
  const section = sectionAt(config, opts.keyPath);
  if (section[SERVER_NAME]) return raw;
  section[SERVER_NAME] = opts.entry;
  return toJson(config);
}

function sectionAt(config: Record<string, unknown>, keyPath: string[]): Record<string, unknown> {
  let node = config;
  for (const key of keyPath) {
    const child = node[key];
    if (child !== undefined && !isPlainObject(child)) throw new Error(`"${keyPath.join(".")}" is not an object`);
    node[key] = child ?? {};
    node = node[key] as Record<string, unknown>;
  }
  return node;
}

function hasOpenCodeV2Entry(raw: string): boolean {
  const mcp = parseObject(raw)["mcp"];
  return isPlainObject(mcp) && isPlainObject(mcp["servers"]) && mcp["servers"][SERVER_NAME] !== undefined;
}

function parseObject(raw: string): Record<string, unknown> {
  if (raw.trim() === "") return {};
  const parsed = parseJsonc(raw);
  if (!isPlainObject(parsed)) throw new Error("not a JSON object");
  return parsed;
}
