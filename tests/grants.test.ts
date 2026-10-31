import { describe, test, expect } from "bun:test";
import { writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { heldGrants, lockedPatterns, lockingGrant } from "../src/grants.js";
import { loadConfig, loadRawConfig } from "../src/config.js";
import { Aggregator } from "../src/aggregator.js";

const dir = join(tmpdir(), `unimcp-grants-${Date.now()}`);
mkdirSync(dir, { recursive: true });

describe("heldGrants", () => {
  test("merges the env list with the file's lines", () => {
    const file = join(dir, "held");
    writeFileSync(file, "devdb\n\n prod \n");
    expect([...heldGrants("proddb, deploy-write", [file])].sort()).toEqual(["deploy-write", "devdb", "prod", "proddb"]);
  });

  test("a missing file holds nothing", () => {
    expect(heldGrants(undefined, [join(dir, "absent")]).size).toBe(0);
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

  test("argument rules hide nothing", () => {
    expect(lockedPatterns({ main: [{ tool: "mongo__*", args: { db: "main" } }] }, new Set())).toEqual([]);
  });
});

describe("lockingGrant", () => {
  const grants = { main: [{ tool: "mongo__*", args: { db: "main" } }], bp: [{ tool: "mongo__*", args: { db: "bp" } }] };
  const call = (args: Record<string, unknown>) => ({ name: "mongo__find", args });

  test("names the unheld grant whose rule matches every arg", () => {
    expect(lockingGrant(grants, new Set(), call({ db: "main", collection: "x" }))).toBe("main");
    expect(lockingGrant(grants, new Set(["main"]), call({ db: "main" }))).toBeUndefined();
    expect(lockingGrant(grants, new Set(["main"]), call({ db: "bp" }))).toBe("bp");
  });

  test("a call no rule matches is open", () => {
    expect(lockingGrant(grants, new Set(), call({ db: "other" }))).toBeUndefined();
    expect(lockingGrant(grants, new Set(), { name: "slack__send", args: { db: "main" } })).toBeUndefined();
  });

  test("a `!` glob is literal, never inverting a lock", () => {
    expect(lockingGrant({ x: [{ tool: "!mongo__find", args: { db: "main" } }] }, new Set(), call({ db: "main" }))).toBeUndefined();
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

  test("accepts argument rules; rejects ones that would lock nothing", () => {
    const file = join(dir, "arg-grants.json");
    const good = { main: ["x__*", { tool: "mongo__*", args: { db: "main" } }] };
    writeFileSync(file, JSON.stringify({ mcpServers: {}, grants: good }));
    expect(loadRawConfig(file).grants).toEqual(good);
    for (const rule of [{ tool: "mongo__*", args: {} }, { tool: "", args: { db: "a" } }, { tool: "m", args: { db: 1 } }, { tool: "m" }]) {
      writeFileSync(file, JSON.stringify({ mcpServers: {}, grants: { main: [rule] } }));
      expect(() => loadRawConfig(file)).toThrow(/grants/);
    }
  });

  test("a profile grant becomes a profile of its server", () => {
    const file = join(dir, "profile-grants.json");
    const grants = { main: { server: "mongo", vars: { uri: "$(pw get main)" }, description: "ads" }, bp: { server: "mongo" }, ops: ["x__*"] };
    writeFileSync(file, JSON.stringify({ mcpServers: { mongo: { command: "m" } }, grants }));
    const config = loadConfig(file);
    expect(config.profiles).toEqual({ mongo: { main: { vars: { uri: "$(pw get main)" }, description: "ads" }, bp: { vars: {} } } });
    expect(config.grants).toEqual({ ops: ["x__*"] });
  });

  test("expands ${VAR} in profile vars, dropping a profile whose var is unset", () => {
    const file = join(dir, "profile-env.json");
    process.env.UNIMCP_TEST_PROFILE_URI = "mongodb://a";
    const grants = { a: { server: "mongo", vars: { uri: "${UNIMCP_TEST_PROFILE_URI}" } }, b: { server: "mongo", vars: { uri: "${UNIMCP_TEST_UNSET}" } } };
    writeFileSync(file, JSON.stringify({ mcpServers: { mongo: { command: "m" } }, grants }));
    expect(loadConfig(file).profiles).toEqual({ mongo: { a: { vars: { uri: "mongodb://a" } } } });
    delete process.env.UNIMCP_TEST_PROFILE_URI;
  });

  test("rejects a profile grant with a bad name, server or vars", () => {
    const file = join(dir, "bad-profile-grants.json");
    for (const grants of [{ "a.b": { server: "m" } }, { a: { server: "" } }, { a: { server: "m", vars: { x: 1 } } }, { a: { server: "m", description: 2 } }]) {
      writeFileSync(file, JSON.stringify({ mcpServers: {}, grants }));
      expect(() => loadRawConfig(file)).toThrow(/grant/);
    }
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

  test("an argument rule matches a pinned value the client left out", async () => {
    const agg = new Aggregator();
    await agg.connect({ mcpServers: {}, grants: { prod: [{ tool: "mongo__*", args: { db: "prod" } }] } });
    const upstreams = (agg as unknown as { upstreams: Map<string, unknown> }).upstreams;
    upstreams.set("mongo", { name: "mongo", tools: [], config: { command: "x", pinArgs: { db: "prod" } }, state: "connected" });
    expect(agg.lockingGrant({ name: "mongo__find", args: {} })).toBe("prod");
    expect(agg.lockingGrant({ name: "mongo__find", args: {}, clientFilter: { grants: ["prod"] } })).toBeUndefined();
  });
});
