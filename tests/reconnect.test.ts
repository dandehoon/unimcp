import { afterEach, describe, expect, test } from "bun:test";
import { Aggregator, type AggregatorOptions } from "../src/aggregator.js";
import type { Config } from "../src/config.js";
import { wasNotDelivered } from "../src/transport.js";
import { startUpstream, type Upstream } from "./fixtures/http-upstream.js";

const live: Aggregator[] = [];
const upstreams: Upstream[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((a) => a.disconnect()));
  await Promise.all(upstreams.splice(0).map((u) => u.stop()));
});

async function upstream(opts: Parameters<typeof startUpstream>[0] = {}): Promise<Upstream> {
  const u = await startUpstream(opts);
  upstreams.push(u);
  return u;
}

function aggregator(opts: AggregatorOptions = {}): Aggregator {
  const agg = new Aggregator({ backoffBaseMs: 5, backoffCapMs: 20, ...opts });
  live.push(agg);
  return agg;
}

const config = (port: number) => ({ mcpServers: { up: { type: "http", url: `http://127.0.0.1:${port}/mcp` } } }) as Config;
const state = (agg: Aggregator) => agg.getStatus().find((u) => u.name === "up")?.state;

async function eventually(check: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

describe("upstream reconnect", () => {
  test("a server down at start is retried until it comes up, and the tool change is reported", async () => {
    const reserved = await startUpstream();
    await reserved.stop();
    let changes = 0;
    const agg = aggregator({ onToolsChanged: () => changes++ });
    await agg.connect(config(reserved.port));
    expect(agg.listTools()).toEqual([]);

    await upstream({ port: reserved.port });
    await eventually(() => state(agg) === "connected");
    expect(agg.listTools().map((t) => t.name)).toContain("up__ping");
    expect(changes).toBeGreaterThan(0);
  });

  test("a call after the server lost its session reconnects and runs exactly once", async () => {
    const first = await upstream();
    const agg = aggregator();
    await agg.connect(config(first.port));
    expect(await agg.callTool("up__ping", {})).toMatchObject({ content: [{ text: "pong" }] });

    await first.stop();
    const restarted = await upstream({ port: first.port });
    expect(await agg.callTool("up__ping", {})).toMatchObject({ content: [{ text: "pong" }] });
    expect(restarted.calls).toBe(1);
    expect(state(agg)).toBe("connected");
  });

  test("a call while the server is down fails, and the next one after it is back succeeds", async () => {
    const first = await upstream();
    const agg = aggregator();
    await agg.connect(config(first.port));
    await first.stop();
    await expect(agg.callTool("up__ping", {})).rejects.toThrow();

    await upstream({ port: first.port });
    expect(await agg.callTool("up__ping", {})).toMatchObject({ content: [{ text: "pong" }] });
  });

  test("a call that times out on a server still answering leaves it connected", async () => {
    let release!: () => void;
    const u = await upstream({ slow: new Promise<void>((r) => { release = r; }) });
    const agg = aggregator({ callTimeoutMs: 50 });
    await agg.connect(config(u.port));
    await expect(agg.callTool("up__slow", {})).rejects.toThrow(/timed out/);
    expect(state(agg)).toBe("connected");
    release();
  });
});

describe("wasNotDelivered", () => {
  test("sees a refused connection behind Node's bare fetch error", () => {
    expect(wasNotDelivered(new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:1") }))).toBe(true);
  });

  test("a reset mid-request may have run the call", () => {
    expect(wasNotDelivered(new TypeError("fetch failed", { cause: new Error("read ECONNRESET") }))).toBe(false);
  });
});
