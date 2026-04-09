import path from "path";
import { startManagedServer } from "./server.js";
import { ensureDaemon } from "./daemon.js";
import { runBridge } from "./bridge.js";
import { runSetup } from "./setup.js";
import { runCollect } from "./collect.js";
import { DEFAULT_MCP_FILE, computeEnvHash } from "./config.js";
import { printHelp } from "./help.js";
import { runStatus } from "./status.js";
import { runMcp } from "./mcp.js";

const PORT = Number(process.env.UNIMCP_PORT ?? process.env.PORT ?? 4848);
const HOST = process.env.UNIMCP_HOST ?? process.env.HOST ?? "127.0.0.1";

const args = process.argv.slice(2);
const command = args[0];
const restArgs = args.slice(1);

const useHttp = args.includes("--http");
const isDaemon = args.includes("--daemon");

function resolveMcpFile(): string {
  const flagIdx = args.indexOf("--mcp-file");
  if (flagIdx !== -1 && args[flagIdx + 1]) return path.resolve(args[flagIdx + 1]);
  const inline = args.find((a) => a.startsWith("--mcp-file="));
  if (inline) return path.resolve(inline.slice("--mcp-file=".length));
  return process.env.UNIMCP_CONFIG ?? process.env.CONFIG ?? DEFAULT_MCP_FILE;
}

const CONFIG_PATH = resolveMcpFile();

function resolveEnvHash(): string {
  const flagIdx = args.indexOf("--env-hash");
  const candidate = flagIdx !== -1 ? args[flagIdx + 1] : undefined;
  if (candidate && /^[0-9a-f]{8}$/.test(candidate)) return candidate;
  return computeEnvHash(CONFIG_PATH);
}

const ENV_HASH = resolveEnvHash();

const MCP_COMMANDS = new Set(["list", "get", "add", "add-json", "remove"]);

async function main() {
  if (args.includes("--help") || command === "help") {
    printHelp();
    return;
  }

  if (command === "status") {
    await runStatus({ envHash: ENV_HASH, host: HOST, configPath: CONFIG_PATH });
    return;
  }

  if (command === "setup") {
    await runSetup(restArgs);
    return;
  }

  if (command === "collect") {
    runCollect(restArgs);
    return;
  }

  if (command && MCP_COMMANDS.has(command)) {
    runMcp([command, ...restArgs], CONFIG_PATH);
    return;
  }

  if (useHttp || isDaemon) {
    await startManagedServer({ port: PORT, host: HOST, configPath: CONFIG_PATH, envHash: ENV_HASH });
    return;
  }

  if (command && !command.startsWith("-")) {
    console.error(`[unimcp] unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  const actualPort = await ensureDaemon({ port: PORT, host: HOST, configPath: CONFIG_PATH, envHash: ENV_HASH });
  await runBridge({ port: actualPort, host: HOST, configPath: CONFIG_PATH });
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
