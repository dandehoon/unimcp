import path from "path";
import { startManagedServer } from "./server.js";
import { ensureDaemon } from "./daemon.js";
import { runBridge } from "./bridge.js";
import { runSetup } from "./setup.js";
import { runCollect } from "./collect.js";
import { DEFAULT_MCP_FILE, computeEnvHash } from "./config.js";

const PORT = Number(process.env.UNIMCP_PORT ?? process.env.PORT ?? 4848);
const HOST = process.env.UNIMCP_HOST ?? process.env.HOST ?? "127.0.0.1";

const args = process.argv.slice(2);
const command = args[0];
const restArgs = args.slice(1);

const useHttp = args.includes("--http");
const isDaemon = args.includes("--daemon");

/** Resolves the active mcp file path: --mcp-file flag > CONFIG env > default. */
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
  if (flagIdx !== -1 && args[flagIdx + 1]) return args[flagIdx + 1];
  return computeEnvHash(CONFIG_PATH);
}

const ENV_HASH = resolveEnvHash();

async function main() {
  if (command === "setup") {
    await runSetup(restArgs);
    return;
  }

  if (command === "collect") {
    runCollect(restArgs);
    return;
  }

  if (useHttp || isDaemon) {
    await startManagedServer({ port: PORT, host: HOST, configPath: CONFIG_PATH, envHash: ENV_HASH });
    return;
  }

  // Default (stdio) mode: ensure daemon is running, then bridge stdio ↔ daemon HTTP.
  const actualPort = await ensureDaemon({ port: PORT, host: HOST, configPath: CONFIG_PATH, envHash: ENV_HASH });
  await runBridge({ port: actualPort, host: HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
