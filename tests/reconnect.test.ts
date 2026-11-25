import net from "net";
import { afterEach, describe, expect, test } from "bun:test";
import { Aggregator, type AggregatorOptions } from "../src/aggregator.js";
import type { Config } from "../src/config.js";
import { route } from "../src/resources.js";
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

describe("refresh", () => {
  test("a server announcing new tools is re-listed and the change reported", async () => {
    const u = await upstream();
    let changes = 0;
    const agg = aggregator({ onToolsChanged: () => changes++ });
    await agg.connect(config(u.port));
    const before = changes;

    u.addTool("added");
    await eventually(() => agg.listTools().some((t) => t.name === "up__added"));
    expect(changes).toBeGreaterThan(before);
  });

  test("a server announcing new resources has its content re-listed, its tools left alone", async () => {
    const u = await upstream();
    let toolChanges = 0;
    let resourceChanges = 0;
    const agg = aggregator({ onToolsChanged: () => toolChanges++, onResourcesChanged: () => resourceChanges++ });
    await agg.connect(config(u.port));
    const before = { tools: toolChanges, resources: resourceChanges };

    u.addResource("added");
    await eventually(() => route(agg.contentSources(), "note://added") !== undefined);
    expect(resourceChanges).toBeGreaterThan(before.resources);
    expect(toolChanges).toBe(before.tools);
  });

  test("a down server's resources still route, and reading one reconnects it", async () => {
    const first = await upstream();
    first.addResource("kept");
    const agg = aggregator({ backoffBaseMs: 60_000, backoffCapMs: 60_000 });
    await agg.connect(config(first.port));
    await eventually(() => route(agg.contentSources(), "note://kept") !== undefined);

    await first.stop();
    await eventually(() => state(agg) !== "connected");
    const target = route(agg.contentSources(), "note://kept");
    expect(target?.source.name).toBe("up");

    const restarted = await upstream({ port: first.port });
    restarted.addResource("kept");
    const read = await agg.request("up", (c) => c.readResource({ uri: "note://kept" }));
    expect(read.contents[0]).toMatchObject({ text: "kept" });
    expect(state(agg)).toBe("connected");
  });

  test("a down server is reconnected now, without waiting out its backoff", async () => {
    const reserved = await startUpstream();
    await reserved.stop();
    const agg = aggregator({ backoffBaseMs: 60_000, backoffCapMs: 60_000 });
    await agg.connect(config(reserved.port));
    expect(state(agg)).toBe("reconnecting");

    await upstream({ port: reserved.port });
    const [status] = await agg.refresh();
    expect(status).toMatchObject({ name: "up", state: "connected" });
    expect(agg.listTools().map((t) => t.name)).toContain("up__ping");
  });

  test("a connected server is re-read, not restarted", async () => {
    const u = await upstream();
    const agg = aggregator();
    await agg.connect(config(u.port));
    const connectedAt = agg.getStatus()[0].connectedAt;

    const [status] = await agg.refresh({ servers: ["up"] });
    expect(status).toMatchObject({ state: "connected", connectedAt });
  });

  test("a server named like unimcp's own tools is skipped", async () => {
    const u = await upstream();
    const agg = aggregator();
    await agg.connect({ mcpServers: { unimcp: { type: "http", url: `http://127.0.0.1:${u.port}/mcp` } } } as Config);
    expect(agg.getStatus()).toEqual([]);
  });

  test("a member is refreshed and reported only for a client holding its profile", async () => {
    const u = await upstream();
    const agg = aggregator();
    const srv = { type: "http", url: `http://127.0.0.1:${u.port}/mcp` };
    await agg.connect({ mcpServers: { up: srv }, profiles: { up: { a: { vars: {} }, b: { vars: {} } } } } as Config);

    const statuses = await agg.refresh({ clientFilter: { grants: ["b"] } });
    expect(statuses.map((s) => s.name)).toEqual(["up.b"]);
  });

  test("a refresh reports by its deadline while a hung server keeps connecting", async () => {
    // Refuses at first (a server down), then accepts and never answers (one that hangs).
    let isHanging = false;
    const sockets: net.Socket[] = [];
    const flaky = net.createServer((s) => (isHanging ? sockets.push(s) : s.destroy()));
    await new Promise<void>((resolve) => flaky.listen(0, "127.0.0.1", resolve));
    const port = (flaky.address() as net.AddressInfo).port;
    try {
      const agg = aggregator({ backoffBaseMs: 60_000, backoffCapMs: 60_000, refreshWaitMs: 50 });
      await agg.connect(config(port));
      isHanging = true;
      const [status] = await agg.refresh();
      expect(status.state).not.toBe("connected");
    } finally {
      for (const s of sockets) s.destroy();
      flaky.close();
    }
  });

  test("a failed $(command) is named in the error, not masked", async () => {
    const agg = aggregator({ backoffBaseMs: 60_000, backoffCapMs: 60_000 });
    await agg.connect({ mcpServers: { up: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { "X-Key": "$(exit 3)" } } } } as Config);
    expect(agg.getStatus()[0].lastError).toContain("$(exit 3) failed");
  });
});
