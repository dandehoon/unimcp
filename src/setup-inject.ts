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

/** OpenCode v2: `mcp.servers.<name>`, command and args in one array. */
export function injectOpenCode(raw: string, launch: Launch): string {
  if (hasOpenCodeEntry(raw)) return raw;
  const entry = { type: "local", command: [launch.command, ...launch.args] };
  return injectJsonEntry(raw, { keyPath: ["mcp", "servers"], entry });
}

/** Codex `config.toml`: appends a `[mcp_servers.unimcp]` table, as `codex mcp add` does. */
export function injectCodex(raw: string, launch: Launch): string {
  if (CODEX_TABLE_RE.test(raw)) return raw;
  // A JSON string or string array is also a valid TOML basic string / array.
  const table = `[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(launch.command)}\nargs = ${JSON.stringify(launch.args)}\n`;
  if (raw.trim() === "") return table;
  return raw + (raw.endsWith("\n") ? "\n" : "\n\n") + table;
}

// --- helpers ---

const CODEX_TABLE_RE = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*"?${SERVER_NAME}"?\\s*\\]`, "m");

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

/** The pre-v2 shape, `mcp.<name>`, still loads — an entry there counts as registered. */
function hasOpenCodeEntry(raw: string): boolean {
  const mcp = parseObject(raw)["mcp"];
  return isPlainObject(mcp) && mcp[SERVER_NAME] !== undefined;
}

function parseObject(raw: string): Record<string, unknown> {
  if (raw.trim() === "") return {};
  const parsed = parseJsonc(raw);
  if (!isPlainObject(parsed)) throw new Error("not a JSON object");
  return parsed;
}
