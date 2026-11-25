import { afterEach, describe, expect, test } from "bun:test";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { Aggregator } from "../src/aggregator.js";
import type { Config } from "../src/config.js";
import { callRefresh } from "../src/refresh.js";
import { startUpstream, type Upstream } from "./fixtures/http-upstream.js";

const live: Aggregator[] = [];
const upstreams: Upstream[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((a) => a.disconnect()));
  await Promise.all(upstreams.splice(0).map((u) => u.stop()));
});

async function connected(): Promise<Aggregator> {
  const u = await startUpstream();
  upstreams.push(u);
  const agg = new Aggregator();
  live.push(agg);
  await agg.connect({ mcpServers: { up: { type: "http", url: `http://127.0.0.1:${u.port}/mcp` } } } as Config);
  return agg;
}

const report = (result: Awaited<ReturnType<typeof callRefresh>>) => JSON.parse((result.content[0] as { text: string }).text);

describe("unimcp__refresh", () => {
  test("reports each server's state and the tools the client sees", async () => {
    const aggregator = await connected();
    const result = report(await callRefresh({ aggregator, args: {}, clientFilter: { exclude: ["slow"] } }));
    expect(result).toEqual({ servers: [{ name: "up", state: "connected" }], tools: ["up__ping"] });
  });

  test("rejects an unknown server, naming the known ones", async () => {
    const aggregator = await connected();
    const call = callRefresh({ aggregator, args: { servers: ["nope"] } });
    await expect(call).rejects.toBeInstanceOf(McpError);
    await expect(call).rejects.toThrow("Known: up");
  });

  test("rejects servers that aren't a list of names", async () => {
    const aggregator = await connected();
    await expect(callRefresh({ aggregator, args: { servers: "up" } })).rejects.toThrow("must be a list");
  });

  test("lists only the named servers' tools, and all of them for an empty list", async () => {
    const aggregator = await connected();
    expect(report(await callRefresh({ aggregator, args: { servers: ["up"] } })).tools).toEqual(["up__ping", "up__slow"]);
    expect(report(await callRefresh({ aggregator, args: { servers: [] } })).servers).toHaveLength(1);
  });
});
