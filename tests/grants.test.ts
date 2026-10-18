import { describe, test, expect } from "bun:test";
import { writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { heldGrants, lockedPatterns } from "../src/grants.js";
import { loadConfig, loadRawConfig } from "../src/config.js";
import { Aggregator } from "../src/aggregator.js";

const dir = join(tmpdir(), `unimcp-grants-${Date.now()}`);
mkdirSync(dir, { recursive: true });

describe("heldGrants", () => {
  test("merges the env list with the file's lines", () => {
    const file = join(dir, "held");
    writeFileSync(file, "devdb\n\n prod \n");
    expect([...heldGrants("proddb, deploy-write", file)].sort()).toEqual(["deploy-write", "devdb", "prod", "proddb"]);
  });

  test("a missing file holds nothing", () => {
    expect(heldGrants(undefined, join(dir, "absent")).size).toBe(0);
  });
});

describe("lockedPatterns", () => {
  const grants = { proddb: ["proddb__*"], write: ["portal__create_*", "portal__update_*"] };

  test("locks the globs of every grant not held", () => {
    expect(lockedPatterns(grants, new Set(["proddb"]))).toEqual(["portal__create_*", "portal__update_*"]);
  });

  test("no grants config locks nothing", () => {
    expect(lockedPatterns(undefined, new Set())).toEqual([]);
  });
});

describe("config grants", () => {
  test("parses a grants map, and loadConfig keeps it for the daemon", () => {
    const file = join(dir, "grants.json");
    writeFileSync(file, JSON.stringify({ mcpServers: {}, grants: { proddb: ["proddb__*"] } }));
    expect(loadRawConfig(file).grants).toEqual({ proddb: ["proddb__*"] });
    expect(loadConfig(file).grants).toEqual({ proddb: ["proddb__*"] });
  });

  test("rejects an empty glob list or pattern, which would lock nothing", () => {
    for (const globs of [[], [""], ["  "]]) {
      const file = join(dir, "empty-grants.json");
      writeFileSync(file, JSON.stringify({ mcpServers: {}, grants: { proddb: globs } }));
      expect(() => loadRawConfig(file)).toThrow(/grants/);
    }
  });

  test("rejects a grant that is not a glob list", () => {
    const file = join(dir, "bad-grants.json");
    writeFileSync(file, JSON.stringify({ mcpServers: {}, grants: { proddb: "proddb__*" } }));
    expect(() => loadRawConfig(file)).toThrow(/grants/);
  });
});

describe("Aggregator grant locks", () => {
  async function aggregatorWith(grants: Record<string, string[]>): Promise<Aggregator> {
    const agg = new Aggregator();
    await agg.connect({ mcpServers: {}, grants });
    const tool = (name: string) => ({ name, inputSchema: { type: "object" as const } });
    // Upstreams are private and only filled by a live connection; seed them directly.
    const upstreams = (agg as unknown as { upstreams: Map<string, unknown> }).upstreams;
    upstreams.set("proddb", { name: "proddb", tools: [tool("find")], config: { command: "x" }, state: "connected" });
    upstreams.set("portal", { name: "portal", tools: [tool("get_x"), tool("create_x")], config: { command: "x" }, state: "connected" });
    upstreams.set("down", { name: "down", tools: [], config: { command: "x", exclude: ["drop"] }, state: "failed" });
    return agg;
  }
  const names = (agg: Aggregator, grants?: string[]) => agg.listTools(grants && { grants }).map((t) => t.name).sort();

  test("a client that sends no grants sees no locked tool", async () => {
    const agg = await aggregatorWith({ proddb: ["proddb__*"] });
    expect(names(agg)).toEqual(["portal__create_x", "portal__get_x"]);
  });

  test("holding the grant reveals its tools", async () => {
    const agg = await aggregatorWith({ proddb: ["proddb__*"] });
    expect(names(agg, ["proddb"])).toEqual(["portal__create_x", "portal__get_x", "proddb__find"]);
  });

  test("globs match the prefixed name, not the bare one", async () => {
    const agg = await aggregatorWith({ write: ["create_*"] });
    expect(names(agg)).toEqual(["portal__create_x", "portal__get_x", "proddb__find"]);
  });

  test("negation and comment syntax is literal, never inverting a lock", async () => {
    expect(names(await aggregatorWith({ x: ["!proddb__find"] }))).toEqual(["portal__create_x", "portal__get_x", "proddb__find"]);
    expect(names(await aggregatorWith({ x: ["#proddb__*", "proddb__*"] }))).toEqual(["portal__create_x", "portal__get_x"]);
  });

  test("a tool of a server that is down stays callable, so the call can reconnect it", async () => {
    const agg = await aggregatorWith({ proddb: ["proddb__*"] });
    expect(agg.isCallable("down__query")).toBe(true);
    expect(agg.isCallable("down__drop")).toBe(false);
    expect(agg.isCallable("proddb__find")).toBe(false);
    expect(agg.isCallable("proddb__find", { grants: ["proddb"] })).toBe(true);
    expect(agg.isCallable("portal__get_x", { exclude: ["get_*"] })).toBe(false);
    expect(agg.isCallable("nowhere__x")).toBe(false);
  });
});
