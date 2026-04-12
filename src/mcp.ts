import { existsSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { loadConfig, isHttpServer } from "./config.js";
import type { Config, ServerConfig } from "./config.js";
import { parseFlagValue, log } from "./utils.js";

export function runMcp(argv: string[], configPath: string): void {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === "list") return cmdList(configPath);
  if (sub === "get") return cmdGet(rest[0], configPath);
  if (sub === "add") return cmdAdd(rest[0], rest.slice(1), configPath);
  if (sub === "add-json") return cmdAddJson(rest[0], rest[1], configPath);
  if (sub === "remove") return cmdRemove(rest[0], configPath);

  console.error(`[mcp] unknown subcommand: ${sub ?? "(none)"}`);
  console.error("Usage: unimcp mcp <list|get|add|add-json|remove> [args]");
  process.exit(1);
}

// --- subcommands ---

function cmdList(configPath: string): void {
  const config = readConfig(configPath);
  const servers = Object.entries(config.mcpServers);

  if (servers.length === 0) {
    log("(no servers configured)");
    return;
  }

  for (const [name, srv] of servers) {
    if (isHttpServer(srv)) {
      log(`${name}  http  ${srv.url}`);
    } else {
      const argsPart = srv.args?.length ? `  ${srv.args.join(" ")}` : "";
      log(`${name}  stdio  ${srv.command}${argsPart}`);
    }
  }
}

function cmdGet(name: string, configPath: string): void {
  if (!name) {
    console.error("[mcp] get requires a server name");
    process.exit(1);
  }

  const config = readConfig(configPath);
  const srv = config.mcpServers[name];

  if (!srv) {
    console.error(`[mcp] server '${name}' not found`);
    process.exit(1);
  }

  log(`name:  ${name}`);

  if (isHttpServer(srv)) {
    log(`type:  http`);
    log(`url:   ${maskUrl(srv.url)}`);
    if (srv.headers && Object.keys(srv.headers).length > 0) {
      log(`headers:`);
      for (const [k, v] of Object.entries(srv.headers)) {
        log(`  ${k}: ${maskValue(k, v)}`);
      }
    } else {
      log(`headers: (none)`);
    }
  } else {
    log(`type:    stdio`);
    log(`command: ${srv.command}`);
    log(`args:    ${srv.args?.length ? srv.args.join(" ") : "(none)"}`);
    if (srv.env && Object.keys(srv.env).length > 0) {
      log(`env:`);
      for (const [k, v] of Object.entries(srv.env)) {
        log(`  ${k}=${maskValue(k, v)}`);
      }
    } else {
      log(`env:     (none)`);
    }
  }
}

function cmdAdd(name: string, argv: string[], configPath: string): void {
  if (!name) {
    console.error("[mcp] add requires a server name");
    process.exit(1);
  }

  const type = parseFlagValue(argv, "--type") ?? "stdio";

  const config = readConfig(configPath);
  if (config.mcpServers[name]) {
    console.error(`[mcp] server '${name}' already exists — remove it first`);
    process.exit(1);
  }

  const srv = type === "http" ? buildHttpServer(argv) : buildStdioServer(argv);
  config.mcpServers[name] = srv;
  writeConfig(configPath, config);
  log(`[mcp] added '${name}'`);
}

function cmdAddJson(name: string, jsonStr: string, configPath: string): void {
  if (!name || !jsonStr) {
    console.error("[mcp] add-json requires a name and a JSON string");
    process.exit(1);
  }

  let srv: ServerConfig;
  try {
    srv = JSON.parse(jsonStr) as ServerConfig;
  } catch {
    console.error(`[mcp] invalid JSON: ${jsonStr}`);
    process.exit(1);
  }

  const config = readConfig(configPath);
  if (config.mcpServers[name]) {
    console.error(`[mcp] server '${name}' already exists — remove it first`);
    process.exit(1);
  }

  config.mcpServers[name] = srv;
  writeConfig(configPath, config);
  log(`[mcp] added '${name}'`);
}

function cmdRemove(name: string, configPath: string): void {
  if (!name) {
    console.error("[mcp] remove requires a server name");
    process.exit(1);
  }

  const config = readConfig(configPath);
  if (!config.mcpServers[name]) {
    console.error(`[mcp] server '${name}' not found`);
    process.exit(1);
  }

  delete config.mcpServers[name];
  writeConfig(configPath, config);
  log(`[mcp] removed '${name}'`);
}

// --- helpers ---

function buildStdioServer(argv: string[]): ServerConfig {
  const command = parseFlagValue(argv, "--command");
  if (!command) {
    console.error("[mcp] --command is required for stdio servers");
    process.exit(1);
  }

  const argsRaw = parseFlagValue(argv, "--args");
  const args = argsRaw ? argsRaw.split(",").map((s) => s.trim()) : undefined;
  const envPairs = parseRepeatedFlag(argv, "--env");
  const env = envPairs.length > 0 ? parseEnvPairs(envPairs) : undefined;

  return { command, ...(args && { args }), ...(env && { env }) };
}

function buildHttpServer(argv: string[]): ServerConfig {
  const url = parseFlagValue(argv, "--url");
  if (!url) {
    console.error("[mcp] --url is required for http servers");
    process.exit(1);
  }

  const headerPairs = parseRepeatedFlag(argv, "--header");
  const headers = headerPairs.length > 0 ? parseEnvPairs(headerPairs) : undefined;

  return { type: "http", url, ...(headers && { headers }) };
}

function readConfig(configPath: string): Config {
  if (!existsSync(configPath)) return { mcpServers: {} };
  try {
    return loadConfig(configPath);
  } catch (err) {
    console.error(`[mcp] could not read config: ${String(err)}`);
    process.exit(1);
  }
}

function writeConfig(configPath: string, config: Config): void {
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function parseRepeatedFlag(argv: string[], flag: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1]) {
      results.push(argv[i + 1]);
    } else if (argv[i].startsWith(flag + "=")) {
      results.push(argv[i].slice(flag.length + 1));
    }
  }
  return results;
}

function parseEnvPairs(pairs: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    result[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return result;
}

const SECRET_KEYWORDS = ["key", "token", "secret", "auth", "bearer", "password"];

function maskValue(key: string, value: string): string {
  const lower = key.toLowerCase();
  return SECRET_KEYWORDS.some((kw) => lower.includes(kw)) ? "***" : value;
}

function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const [k] of u.searchParams) {
      if (SECRET_KEYWORDS.some((kw) => k.toLowerCase().includes(kw))) {
        u.searchParams.set(k, "***");
      }
    }
    return u.toString();
  } catch {
    return raw;
  }
}
