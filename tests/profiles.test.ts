import { describe, test, expect } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "../src/config.js";
import { expandProfiles, findServer, routeProfile, withProfileArg, withoutPinnedArgs } from "../src/profiles.js";
import { Aggregator } from "../src/aggregator.js";

const mongo: ServerConfig = {
  command: "npx",
  args: ["mongodb-mcp-server", "--app", "{app}"],
  env: { TELEMETRY: "off", URI: "{uri}" },
  exclude: ["connect"],
  pinArgs: { connectionId: "preconfigured" },
};
const profiles = {
  main: { vars: { uri: "$(pw get main)", app: "a" }, description: "ads, prod" },
  bp: { vars: { uri: "$(pw get bp)", app: "b" } },
};

const find: Tool = {
  name: "find",
  inputSchema: { type: "object", properties: { connectionId: { type: "string" }, collection: { type: "string" } }, required: ["connectionId", "collection"] },
};

describe("expandProfiles", () => {
  test("one member per profile, with every {var} filled from it", () => {
    const { group, members } = expandProfiles("mongo", mongo, profiles);
    expect(group).toMatchObject({ name: "mongo", profiles: ["main", "bp"] });
    expect(members.map((m) => m.name)).toEqual(["mongo.main", "mongo.bp"]);
    expect(members[0].srv).toMatchObject({ args: ["mongodb-mcp-server", "--app", "a"], env: { TELEMETRY: "off", URI: "$(pw get main)" } });
    expect(members[1].srv).toMatchObject({ args: ["mongodb-mcp-server", "--app", "b"], env: { URI: "$(pw get bp)" } });
    expect(members[0].srv).toMatchObject({ exclude: ["connect"], pinArgs: { connectionId: "preconfigured" } });
  });

  test("rejects a var the profile doesn't set, and a pinned selector", () => {
    expect(() => expandProfiles("mongo", mongo, { main: { vars: { uri: "x" } } })).toThrow(/profile 'main' sets no "app" var/);
    expect(() => expandProfiles("s", { command: "x", pinArgs: { profile: "a" } }, { a: { vars: {} } })).toThrow(/pinned/);
  });
});

describe("findServer", () => {
  const config = { mcpServers: { mongo, plain: { command: "y" } }, profiles: { mongo: profiles } };

  test("finds a plain server and a profile member, never the bare group", () => {
    expect(findServer(config, "plain")).toEqual({ command: "y" });
    expect(findServer(config, "mongo.bp")).toMatchObject({ env: { URI: "$(pw get bp)" } });
    expect(findServer(config, "mongo")).toBeUndefined();
    expect(findServer(config, "mongo.nope")).toBeUndefined();
    expect(findServer(config, "mongo.constructor")).toBeUndefined();
  });
});

describe("tool schema rewrites", () => {
  test("pinned args leave the schema; `profile` joins it, required, listing every profile", () => {
    const { group } = expandProfiles("mongo", mongo, profiles);
    const tool = withProfileArg(withoutPinnedArgs(find, mongo.pinArgs), group);
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(["profile", "collection"]);
    expect(tool.inputSchema.required).toEqual(["profile", "collection"]);
    expect(tool.inputSchema.properties?.profile).toMatchObject({ enum: ["main", "bp"], description: "Which mongo profile to use\n- main: ads, prod" });
  });
});

describe("routeProfile", () => {
  const { group } = expandProfiles("mongo", mongo, profiles);

  test("routes by `profile` and strips it", () => {
    expect(routeProfile(group, { profile: "bp", collection: "ads" })).toEqual({ member: "mongo.bp", args: { collection: "ads" } });
  });

  test("refuses a missing or unknown profile", () => {
    expect(() => routeProfile(group, { collection: "ads" })).toThrow(/one of your mongo profiles/);
    expect(() => routeProfile(group, { profile: "prod" })).not.toThrow(/main|bp/);
  });
});

describe("Aggregator profile groups", () => {
  type Call = { name: string; arguments: Record<string, unknown> };
  function aggregatorWithGroup(tools: Tool[] = [find]): { agg: Aggregator; calls: { member: string; call: Call }[] } {
    const agg = new Aggregator();
    const calls: { member: string; call: Call }[] = [];
    const { group, members } = expandProfiles("mongo", mongo, profiles);
    // Private, and only filled by live connections; seed them directly.
    const internals = agg as unknown as { upstreams: Map<string, unknown>; groups: Map<string, unknown> };
    internals.groups.set("mongo", group);
    for (const m of members) {
      const client = { callTool: async (call: Call) => { calls.push({ member: m.name, call }); return { content: [] }; } };
      internals.upstreams.set(m.name, { name: m.name, client, tools, config: m.srv, state: "connected", group: "mongo" });
    }
    return { agg, calls };
  }

  const both = { grants: ["main", "bp"] };

  test("lists the group once, never its members", () => {
    const { agg } = aggregatorWithGroup();
    expect(agg.listTools(both).map((t) => t.name)).toEqual(["mongo__find"]);
    expect(agg.isCallable("mongo__find", both)).toBe(true);
    expect(agg.isCallable("mongo.main__find", both)).toBe(false);
    expect(agg.isCallable("mongo__connect", both)).toBe(false);
  });

  test("a client sees the group only with a profile granted, and picks only from its own", () => {
    const { agg } = aggregatorWithGroup();
    expect(agg.listTools()).toEqual([]);
    expect(agg.isCallable("mongo__find")).toBe(false);
    const [tool] = agg.listTools({ grants: ["bp"] });
    expect(tool.inputSchema.properties?.profile).toMatchObject({ enum: ["bp"] });
    expect(tool).toMatchObject({ upstreamName: "mongo", originalName: "find" });
    expect(agg.isCallable("mongo__find", { grants: ["bp"] })).toBe(true);
    expect(agg.listTools(both)[0].inputSchema.properties?.profile).toMatchObject({ enum: ["main", "bp"] });
  });

  test("leaves out a tool whose own `profile` argument the selector would shadow", () => {
    const own: Tool = { name: "use", inputSchema: { type: "object", properties: { profile: { type: "string" } } } };
    const { agg } = aggregatorWithGroup([find, own]);
    expect(agg.listTools(both).map((t) => t.name)).toEqual(["mongo__find"]);
  });

  test("routes a call to its member with the pinned args, which the client can't override", async () => {
    const { agg, calls } = aggregatorWithGroup();
    await agg.callTool("mongo__find", { profile: "bp", collection: "ads", connectionId: "evil" });
    expect(calls).toEqual([{ member: "mongo.bp", call: { name: "find", arguments: { collection: "ads", connectionId: "preconfigured" } } }]);
  });

  test("a member can't be called by its own name", async () => {
    const { agg } = aggregatorWithGroup();
    await expect(agg.callTool("mongo.main__find", {})).rejects.toThrow(/Unknown upstream/);
  });

  test("an unheld profile refuses the call, naming its grant, whatever the tool name", () => {
    const { agg } = aggregatorWithGroup();
    for (const name of ["mongo__find", "mongo__db/find"]) {
      const call = { name, args: { profile: "bp" } };
      expect(agg.lockingGrant({ ...call, clientFilter: { grants: ["main"] } })).toBe("bp");
      expect(agg.lockingGrant({ ...call, clientFilter: { grants: ["bp"] } })).toBeUndefined();
    }
  });
});
