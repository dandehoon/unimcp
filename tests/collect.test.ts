import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, test } from "bun:test";

const ENTRY = path.join(import.meta.dir, "..", "src", "index.ts");
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("collect", () => {
  test("maps every client's shape and drops their unimcp entry", () => {
    const home = makeHome({
      ".claude.json": JSON.stringify({ mcpServers: { unimcp: { command: "u" }, a: { command: "a" } } }),
      "Library/Application Support/Code/User/mcp.json":
        '{\n  // c\n  "servers": {\n    "v": { "type": "sse", "url": "https://v/sse", },\n  },\n}',
      ".config/opencode/opencode.json": JSON.stringify({
        mcp: {
          old: { type: "local", command: ["o", "-x"], environment: { K: "v" } },
          off: { type: "local", command: ["n"], enabled: false },
          servers: {
            r: { type: "remote", url: "https://r/mcp", headers: { H: "1" } },
            gone: { type: "local", command: ["g"], disabled: true },
          },
        },
      }),
      ".gemini/config/mcp_config.json": JSON.stringify({
        mcpServers: { g: { serverUrl: "https://g/mcp", headers: { X: "y" } }, d: { command: "d", disabled: true } },
      }),
    });

    const { stdout, exitCode } = runCollect(home, []);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).mcpServers).toEqual({
      a: { command: "a" },
      v: { type: "sse", url: "https://v/sse" },
      old: { command: "o", args: ["-x"], env: { K: "v" } },
      r: { type: "http", url: "https://r/mcp", headers: { H: "1" } },
      g: { type: "http", url: "https://g/mcp", headers: { X: "y" } },
    });
  });

  test("--save refuses an unparseable config instead of replacing it", () => {
    const home = makeHome({ ".claude.json": JSON.stringify({ mcpServers: { a: { command: "a" } } }) });
    const own = path.join(home, "unimcp.json");
    writeFileSync(own, '{ "grants": { "g": ["x"] ');

    const { stderr, exitCode } = runCollect(home, ["--save", "--mcp-file", own]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(own);
    expect(readFileSync(own, "utf-8")).toBe('{ "grants": { "g": ["x"] ');
  });
});

// --- helpers ---

function makeHome(files: Record<string, string>): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "unimcp-collect-"));
  homes.push(home);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(home, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return home;
}

function runCollect(home: string, args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
  delete env.UNIMCP_CONFIG;
  const proc = Bun.spawnSync([process.execPath, ENTRY, "collect", ...args], { cwd: home, env });
  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode };
}
