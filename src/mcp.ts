import { loadConfig } from "./config.js";
import type { Config, ServerConfig } from "./config.js";
import { log, parseKvPairs, writeFileSafe, toJson } from "./utils.js";
import { formatServer, formatListLine } from "./mcp-format.js";

export type AddOpts = {
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env: string[];
  url?: string;
  header: string[];
};

// --- subcommands ---

export function cmdList(configPath: string): void {
  const config = readConfig(configPath);
  const servers = Object.entries(config.mcpServers);

  if (servers.length === 0) {
    log("(no servers configured)");
    return;
  }

  for (const [name, srv] of servers) {
    log(formatListLine(name, srv));
  }
}

export function cmdGet(name: string, configPath: string): void {
  requireArg(name, "get requires a server name");

  const config = readConfig(configPath);
  const srv = requireServer(name, config);

  log(`name:  ${name}`);
  for (const line of formatServer(srv)) log(line);
}

export function cmdAdd(name: string, opts: AddOpts, configPath: string): void {
  requireArg(name, "add requires a server name");

  const config = readConfig(configPath);
  guardNotExists(name, config);

  const srv = opts.type === "http" ? buildHttpServer(opts) : buildStdioServer(opts);
  persistServer({ name, srv, config, configPath });
}

export function cmdAddJson(name: string, jsonStr: string, configPath: string): void {
  requireArg(name, "add-json requires a name");
  requireArg(jsonStr, "add-json requires a JSON string");

  const config = readConfig(configPath);
  guardNotExists(name, config);

  persistServer({ name, srv: parseServerJson(jsonStr), config, configPath });
}

export function cmdRemove(name: string, configPath: string): void {
  requireArg(name, "remove requires a server name");

  const config = readConfig(configPath);
  requireServer(name, config);

  delete config.mcpServers[name];
  writeConfig(configPath, config);
  log(`[mcp] removed '${name}'`);
}

// --- helpers ---

function die(message: string): never {
  log(`[mcp] ${message}`);
  process.exit(1);
}

function requireArg(value: string | undefined, message: string): void {
  if (!value) die(message);
}

function requireServer(name: string, config: Config): ServerConfig {
  const srv = config.mcpServers[name];
  if (!srv) die(`server '${name}' not found`);
  return srv;
}

function guardNotExists(name: string, config: Config): void {
  if (config.mcpServers[name]) die(`server '${name}' already exists — remove it first`);
}

function buildStdioServer(opts: AddOpts): ServerConfig {
  if (!opts.command) die("--command is required for stdio servers");
  const env = kvPairsOrUndefined(opts.env);
  return {
    command: opts.command,
    ...(opts.args?.length && { args: opts.args }),
    ...(env && { env }),
  };
}

function buildHttpServer(opts: AddOpts): ServerConfig {
  if (!opts.url) die("--url is required for http servers");
  const headers = kvPairsOrUndefined(opts.header);
  return { type: "http", url: opts.url, ...(headers && { headers }) };
}

function readConfig(configPath: string): Config {
  try {
    return loadConfig(configPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { mcpServers: {} };
    throw new Error(`could not read config at ${configPath}: ${String(err)}`, { cause: err });
  }
}

function writeConfig(configPath: string, config: Config): void {
  writeFileSafe(configPath, toJson(config));
}

type PersistOpts = { name: string; srv: ServerConfig; config: Config; configPath: string };

function persistServer(opts: PersistOpts): void {
  opts.config.mcpServers[opts.name] = opts.srv;
  writeConfig(opts.configPath, opts.config);
  log(`[mcp] added '${opts.name}'`);
}

function parseServerJson(jsonStr: string): ServerConfig {
  try {
    return JSON.parse(jsonStr) as ServerConfig;
  } catch {
    die(`invalid JSON: ${jsonStr}`);
  }
}

function kvPairsOrUndefined(pairs: string[]): Record<string, string> | undefined {
  return pairs.length > 0 ? parseKvPairs(pairs) : undefined;
}
