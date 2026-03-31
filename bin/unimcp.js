#!/usr/bin/env node
/**
 * unimcp CLI launcher.
 * Prefers bun for native TypeScript execution.
 * Requires bun to be installed: https://bun.sh
 */
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcEntry = path.join(__dirname, "..", "src", "index.ts");

function findBun() {
  // Check common install locations before falling back to PATH search.
  const candidates = [
    process.env["BUN_INSTALL"] ? path.join(process.env["BUN_INSTALL"], "bin", "bun") : null,
    path.join(process.env["HOME"] ?? "", ".bun", "bin", "bun"),
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
  ].filter(Boolean);

  for (const loc of candidates) {
    if (loc && existsSync(loc)) return loc;
  }

  // Fall back to whatever is in PATH.
  const result = spawnSync("which", ["bun"], { encoding: "utf-8" });
  const found = result.stdout?.trim();
  return found && existsSync(found) ? found : null;
}

const bun = findBun();

if (!bun) {
  process.stderr.write(
    "error: bun is required to run unimcp from npm.\n" +
    "Install bun: https://bun.sh\n" +
    "Or use a pre-built binary from: https://github.com/dandehoon/unimcp/releases\n"
  );
  process.exit(1);
}

const result = spawnSync(bun, [srcEntry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
