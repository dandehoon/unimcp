import "dotenv/config";
import { startManagedServer } from "./server.js";
import { ensureDaemon } from "./daemon.js";
import { runBridge } from "./bridge.js";
import { runSetup } from "./setup.js";

const PORT = Number(process.env.PORT ?? 4848);
const HOST = process.env.HOST ?? "127.0.0.1";
const CONFIG_PATH = process.env.CONFIG ?? "mcp.json";

const args = process.argv.slice(2);
const useHttp = args.includes("--http");
const isDaemon = args.includes("--daemon");
const isSetup = args[0] === "setup";

async function main() {
  if (isSetup) {
    await runSetup(args.slice(1));
    return;
  }

  if (useHttp || isDaemon) {
    // Run as the managed background HTTP server (file watch + auto-stop).
    await startManagedServer({ port: PORT, host: HOST, configPath: CONFIG_PATH });
    return;
  }

  // Default (stdio) mode: ensure daemon is running, then bridge stdio ↔ daemon HTTP.
  // ensureDaemon returns the actual port (may differ from PORT if fallback was used).
  const actualPort = await ensureDaemon({ port: PORT, host: HOST });
  await runBridge({ port: actualPort, host: HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
