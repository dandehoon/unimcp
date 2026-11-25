import { afterEach, describe, expect, test } from "bun:test";
import http from "http";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Aggregator } from "../src/aggregator.js";
import type { HttpServer } from "../src/config.js";
import { FileOAuthProvider } from "../src/oauth.js";
import { callRefresh } from "../src/refresh.js";
import { SignIns } from "../src/sign-in.js";

// A minimal OAuth authorization server: metadata, dynamic registration, and a token endpoint that
// accepts any code. `hang` leaves the metadata request unanswered.
async function startAuthServer(opts: { hang?: boolean } = {}): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const json = (body: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (req.url === "/.well-known/oauth-authorization-server") {
      if (opts.hang) return;
      return json({
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
      });
    }
    if (req.url === "/register") return json({ ...(await readJson(req)), client_id: "test-client" });
    if (req.url === "/token") return json({ access_token: "issued", token_type: "bearer" });
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "localhost", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); });

/** An aggregator stub whose servers in `srvs` all need sign-in. */
function needingSignIn(srvs: Record<string, HttpServer>): Aggregator {
  return {
    signInTarget: (name: string) => srvs[name] && { config: srvs[name], resolve: async () => ({ srv: srvs[name], mask: (t: string) => t }) },
  } as unknown as Aggregator;
}

async function setup(opts: { hang?: boolean; startTimeoutMs?: number; hasBrowser?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "unimcp-signin-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const srv: HttpServer = { url: await startAuthServer(opts), auth: "oauth", oauth: { callbackPort: await freePort() } };
  const signIns = new SignIns({ dir, startTimeoutMs: opts.startTimeoutMs, hasBrowser: opts.hasBrowser ?? true });
  return { dir, srv, signIns, aggregator: needingSignIn({ test: srv }) };
}

/** Follows the start link as a browser would, returning the consent URL and the cookie it set. */
async function openStart(link: string): Promise<{ consent: URL; cookie: string }> {
  const res = await fetch(link, { redirect: "manual" });
  expect(res.status).toBe(302);
  return { consent: new URL(res.headers.get("location")!), cookie: res.headers.get("set-cookie")!.split(";")[0] };
}

async function linkOf(signIns: SignIns, aggregator: Aggregator, name = "test"): Promise<string> {
  const link = await signIns.link(aggregator, name);
  if (!link || !("url" in link)) throw new Error(`no link: ${JSON.stringify(link)}`);
  return link.url;
}

const callbackOf = (srv: HttpServer, state: string | null) =>
  `http://localhost:${srv.oauth!.callbackPort}/callback?code=abc&state=${state}`;

describe("SignIns", () => {
  test("a browser that opened the start link signs in, and the tokens are stored", async () => {
    const { dir, srv, signIns, aggregator } = await setup();
    const link = await linkOf(signIns, aggregator);
    expect(new URL(link).hostname).toBe("localhost");
    const { consent, cookie } = await openStart(link);
    expect(consent.pathname).toBe("/authorize");

    const res = await fetch(callbackOf(srv, consent.searchParams.get("state")), { headers: { cookie } });
    expect(await res.text()).toContain("authorized");
    expect(new FileOAuthProvider({ name: "test", srv, dir }).tokens()?.access_token).toBe("issued");
  });

  test("a redirect from a browser that didn't open the start link is refused", async () => {
    const { srv, signIns, aggregator } = await setup();
    const { consent, cookie } = await openStart(await linkOf(signIns, aggregator));
    const state = consent.searchParams.get("state");
    expect((await fetch(callbackOf(srv, state))).status).toBe(403);
    expect((await fetch(callbackOf(srv, state), { headers: { cookie } })).status).toBe(200);
  });

  test("a second request while one is waiting gets the same link", async () => {
    const { signIns, aggregator } = await setup();
    const first = await linkOf(signIns, aggregator);
    expect(await linkOf(signIns, aggregator)).toBe(first);
    expect(signIns.isPending()).toBe(true);
  });

  test("refuses a second server on a callback port already waiting", async () => {
    const { srv, signIns } = await setup();
    const aggregator = needingSignIn({ a: srv, b: srv });
    await linkOf(signIns, aggregator, "a");
    expect(await signIns.link(aggregator, "b")).toEqual({ error: expect.stringContaining("sign-in for 'a' is waiting") });
  });

  test("a changed server URL replaces the waiting sign-in", async () => {
    const { srv, signIns } = await setup();
    const old = await linkOf(signIns, needingSignIn({ test: srv }));
    const moved: HttpServer = { ...srv, url: await startAuthServer() };
    const fresh = await linkOf(signIns, needingSignIn({ test: moved }));
    expect(fresh).not.toBe(old);
    expect(new URL((await openStart(fresh)).consent).port).toBe(new URL(moved.url).port);
  });

  test("an authorization server that doesn't answer fails the sign-in and frees the port", async () => {
    const { signIns, aggregator } = await setup({ hang: true, startTimeoutMs: 100 });
    expect(await signIns.link(aggregator, "test")).toEqual({ error: expect.stringContaining("didn't answer") });
    expect(signIns.isPending()).toBe(false);
  });

  test("a server that needs no sign-in gets no link", async () => {
    const { signIns } = await setup();
    expect(await signIns.link(needingSignIn({}), "test")).toBeUndefined();
  });

  test("starts none where no browser can reach the callback, pointing to unimcp auth", async () => {
    const { signIns, aggregator } = await setup({ hasBrowser: false });
    expect(await signIns.link(aggregator, "test")).toEqual({ error: expect.stringContaining("unimcp auth test") });
    expect(signIns.isPending()).toBe(false);
  });
});

describe("unimcp__refresh sign-in", () => {
  test("offers a link only for a server it was asked about", async () => {
    const { signIns, aggregator: stub } = await setup();
    const status = { name: "test", state: "failed", lastError: "sign-in required", needsAuth: true };
    const aggregator = Object.assign(stub, {
      listedServers: () => ["test"], refresh: async () => [status], listTools: () => [],
    }) as unknown as Aggregator;
    const report = async (args: Record<string, unknown>) =>
      JSON.parse(((await callRefresh({ aggregator, args, signIns })).content[0] as { text: string }).text).servers[0];

    expect(await report({})).toEqual({ name: "test", state: "failed", error: "sign-in required", needsSignIn: true });
    expect((await report({ servers: ["test"] })).signIn.url).toContain("/start?k=");
  });
});
