import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Aggregator } from "../src/aggregator.js";
import type { Config } from "../src/config.js";

const FIXTURE = join(import.meta.dir, "fixtures", "stdio-server.ts");
const SECRET = "mongodb://user:hunter2-secret@db";
const ARG_SECRET = "arg-secret-from-var";

const live: Aggregator[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((a) => a.disconnect()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function aggregator(opts: { startDeadlineMs?: number; startGiveUpMs?: number } = {}): Aggregator {
  const agg = new Aggregator(opts);
  live.push(agg);
  return agg;
}

function gatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "unimcp-"));
  dirs.push(dir);
  return join(dir, "gate");
}

function config(args: string[]): Config {
  return {
    mcpServers: { fx: { command: process.execPath, args: [FIXTURE, ...args], env: { TOKEN: SECRET } } },
    expandedValues: [ARG_SECRET],
  } as Config;
}

const status = (agg: Aggregator) => agg.getStatus().find((u) => u.name === "fx")!;

// The start deadline below is a real 50 ms timer, but nothing races it: the fixture never answers
// before the test opens its gate.
describe("stdio upstream startup", () => {
  test("a server that dies on startup reports its stderr, with env and expanded values masked", async () => {
    const agg = aggregator();
    await agg.connect(config(["--fail", `npm error enoent Could not read package.json ${ARG_SECRET}`]));
    const { state, lastError } = status(agg);
    expect(state).not.toBe("connected");
    expect(lastError).toContain("stderr:\nnpm error enoent Could not read package.json *** ***");
    expect(lastError).not.toContain("hunter2");
    expect(lastError).not.toContain(ARG_SECRET);
  });

  test("a server slower than the start deadline is left running and adopted when it answers", async () => {
    const gate = gatePath();
    const agg = aggregator({ startDeadlineMs: 50 });
    await agg.connect(config(["--gate", gate]));
    expect(status(agg).state).toBe("starting");
    expect(agg.isReconnecting()).toBe(true);
    await expect(agg.callTool("fx__ping", {})).rejects.toThrow(/still starting/);

    writeFileSync(gate, "");
    await agg.whenStarted();
    expect(status(agg)).toMatchObject({ state: "connected", toolCount: 1 });
    expect(await agg.callTool("fx__ping", {})).toMatchObject({ content: [{ text: "pong" }] });
  });

  test("a starting server that exits fails with its stderr", async () => {
    const gate = gatePath();
    const agg = aggregator({ startDeadlineMs: 50 });
    await agg.connect(config(["--gate", gate]));
    writeFileSync(gate, "fail");
    await agg.whenStarted();
    expect(status(agg).lastError).toContain("stderr:\ngave out mid-install");
  });

  test("a server starting past the give-up is stopped, keeping its stderr in the error", async () => {
    const agg = aggregator({ startDeadlineMs: 50, startGiveUpMs: 100 });
    await agg.connect(config(["--gate", gatePath()]));
    await agg.whenStarted();
    expect(status(agg).lastError).toMatch(/^Error: still starting after 0.1 s — stopped: /);
  });

  test("disconnecting a starting server stops it without scheduling a retry", async () => {
    const agg = aggregator({ startDeadlineMs: 50 });
    await agg.connect(config(["--gate", gatePath()]));
    await agg.disconnect();
    expect(agg.getStatus()).toEqual([]);
    expect(agg.isReconnecting()).toBe(false);
  });
});
