import { existsSync } from "fs";
import path from "path";
import { Command } from "commander";
import { startManagedServer } from "./server.js";
import { ensureDaemon } from "./daemon.js";
import { runBridge } from "./bridge.js";
import { runSetup } from "./setup.js";
import { runCollect } from "./collect.js";
import { resolveMcpFile, computeEnvHash } from "./config.js";
import { runStatus } from "./status.js";
import { cmdList, cmdGet, cmdAdd, cmdAddJson, cmdRemove } from "./mcp.js";
import type { AddOpts } from "./mcp.js";
import { log, splitCommaSeparated, collectRepeatable } from "./utils.js";

const LOCAL_MCP_FILE = path.join(process.cwd(), "unimcp.json");

const LOCAL_FILE_EXISTS = existsSync(LOCAL_MCP_FILE);
const ENV_CONFIG = process.env.UNIMCP_CONFIG;

const program = new Command();

program
  .name("unimcp")
  .description("MCP aggregator — merges upstream MCP servers into one endpoint")
  .option("--mcp-file <path>", "Config file path")
  .option("--env-hash <hash>", "Env hash override (internal)")
  .option("--http", "Start as managed HTTP server")
  .option("--daemon", "Alias for --http")
  .option("--port <number>", "Port for the HTTP server (default: UNIMCP_PORT env or 4848)")
  .option("--host <string>", "Host for the HTTP server (default: UNIMCP_HOST env or 127.0.0.1)")
  .action(async (opts: { mcpFile?: string; envHash?: string; http?: boolean; daemon?: boolean; port?: string; host?: string }) => {
    const port = opts.port !== undefined ? Number(opts.port) : Number(process.env.UNIMCP_PORT ?? process.env.PORT ?? 4848);
    const host = opts.host ?? process.env.UNIMCP_HOST ?? process.env.HOST ?? "127.0.0.1";
    const configPath = resolveConfigPath(opts.mcpFile);
    const envHash = resolveEnvHash(opts.envHash, configPath);

    if (opts.http ?? opts.daemon) {
      await startManagedServer({ port, host, configPath, envHash });
      return;
    }

    const actualPort = await ensureDaemon({ port, host, configPath, envHash });
    await runBridge({ port: actualPort, host, configPath });
  });

program
  .command("status")
  .description("Show running daemon info and loaded tools")
  .action(async (_opts, cmd) => {
    const g = globalOpts(cmd);
    const configPath = resolveConfigPath(g.mcpFile);
    const envHash = resolveEnvHash(g.envHash, configPath);
    await runStatus({ envHash, host: process.env.UNIMCP_HOST ?? process.env.HOST ?? "127.0.0.1", configPath });
  });

program
  .command("setup")
  .description("Register unimcp in client editor configs")
  .option("--global", "Write to user-level config files")
  .option("--target <ids>", "Comma-separated targets: claude,cursor,copilot,opencode", splitCommaSeparated)
  .action(async (opts: { global?: boolean; target?: string[] }) => {
    await runSetup({ isGlobal: opts.global ?? false, targets: opts.target ?? null });
  });

program
  .command("collect")
  .description("Merge client MCP configs and print to stdout")
  .option("--save", "Write output to --mcp-file path")
  .option("-o, --output <path>", "Write output to file")
  .action((opts: { save?: boolean; output?: string }, cmd) => {
    runCollect({
      save: opts.save ?? false,
      outputPath: opts.output ?? null,
      mcpFilePath: resolveConfigPath(globalOpts(cmd).mcpFile),
    });
  });

program
  .command("list")
  .description("List all servers in unimcp.json")
  .action((_opts, cmd) => {
    cmdList(resolveConfigPath(globalOpts(cmd).mcpFile));
  });

program
  .command("get <name>")
  .description("Show details for one server")
  .action((name: string, _opts, cmd) => {
    cmdGet(name, resolveConfigPath(globalOpts(cmd).mcpFile));
  });

program
  .command("add <name>")
  .description("Add a server (--command/--url, --type, --args, --env, --header)")
  .option("--type <stdio|http>", "Server type", "stdio")
  .option("--command <cmd>", "Command to run (stdio)")
  .option("--args <a,b,c>", "Comma-separated arguments (stdio)", splitCommaSeparated)
  .option("--env <KEY=VAL>", "Env variable; repeatable", collectRepeatable, [] as string[])
  .option("--url <url>", "Server URL (http)")
  .option("--header <KEY=VAL>", "Request header; repeatable", collectRepeatable, [] as string[])
  .action((name: string, opts: AddOpts, cmd) => {
    cmdAdd(name, opts, resolveConfigPath(globalOpts(cmd).mcpFile));
  });

program
  .command("add-json <name> <json>")
  .description("Add a server from a JSON string")
  .action((name: string, json: string, _opts, cmd) => {
    cmdAddJson(name, json, resolveConfigPath(globalOpts(cmd).mcpFile));
  });

program
  .command("remove <name>")
  .description("Remove a server")
  .action((name: string, _opts, cmd) => {
    cmdRemove(name, resolveConfigPath(globalOpts(cmd).mcpFile));
  });

// --- helpers ---

type GlobalOpts = { mcpFile?: string; envHash?: string };

function globalOpts(cmd: Command): GlobalOpts {
  return cmd.optsWithGlobals() as GlobalOpts;
}

function resolveConfigPath(flagPath?: string): string {
  return resolveMcpFile({
    flagPath,
    envConfig: ENV_CONFIG,
    localFileExists: LOCAL_FILE_EXISTS,
    localFilePath: LOCAL_MCP_FILE,
  });
}

function resolveEnvHash(flagHash: string | undefined, configPath: string): string {
  if (flagHash && /^[0-9a-f]{8}$/.test(flagHash)) return flagHash;
  return computeEnvHash(configPath);
}

program.parseAsync(process.argv).catch((err) => {
  log(String(err));
  process.exit(1);
});
