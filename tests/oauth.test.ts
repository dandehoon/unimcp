import { describe, test, expect } from "bun:test";
import { mkdtempSync, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AuthRequiredError, FileOAuthProvider, serverNameOfStoreFile } from "../src/oauth.js";
import { isHttpServer, isOAuthServer, type HttpServer } from "../src/config.js";

const SLACK: HttpServer = {
  url: "https://mcp.slack.com/mcp",
  auth: "oauth",
  oauth: { clientId: "123.456", clientSecret: "s3cret", scopes: ["search:read.public", "chat:write"], callbackPort: 3_118 },
};

function newDir(): string {
  return mkdtempSync(join(tmpdir(), "unimcp-oauth-"));
}

describe("FileOAuthProvider", () => {
  test("persists tokens owner-only, with no temp files left behind", () => {
    const dir = newDir();
    const provider = new FileOAuthProvider({ name: "slack", srv: SLACK, dir });
    provider.saveTokens({ access_token: "xoxp-1", token_type: "bearer" });

    expect(new FileOAuthProvider({ name: "slack", srv: SLACK, dir }).tokens()?.access_token).toBe("xoxp-1");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(statSync(join(dir, files[0])).mode & 0o777).toBe(0o600);
    expect(serverNameOfStoreFile(files[0])).toBe("slack");
  });

  test("tokens are bound to the URL: a changed url doesn't reuse them", () => {
    const dir = newDir();
    new FileOAuthProvider({ name: "slack", srv: SLACK, dir }).saveTokens({ access_token: "xoxp-1", token_type: "bearer" });
    const moved = new FileOAuthProvider({ name: "slack", srv: { ...SLACK, url: "https://evil.example/mcp" }, dir });
    expect(moved.tokens()).toBeUndefined();
  });

  test("configured client wins over a stored registration; secret selects client_secret_post", () => {
    const provider = new FileOAuthProvider({ name: "slack", srv: SLACK, dir: newDir() });
    provider.saveClientInformation({ client_id: "dcr-id" });
    expect(provider.clientInformation()).toEqual({ client_id: "123.456", client_secret: "s3cret" });
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post");
    expect(provider.clientMetadata.scope).toBe("search:read.public chat:write");
    expect(provider.redirectUrl).toBe("http://localhost:3118/callback");
  });

  test("invalidating tokens keeps the registration", () => {
    const provider = new FileOAuthProvider({ name: "x", srv: { url: "https://x.example/mcp", auth: "oauth" }, dir: newDir() });
    provider.saveClientInformation({ client_id: "dcr-id" });
    provider.saveTokens({ access_token: "t", token_type: "bearer" });
    provider.invalidateCredentials("tokens");
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()?.client_id).toBe("dcr-id");
  });

  test("a dynamic registration for another callback port is not reused", () => {
    const dir = newDir();
    const srv: HttpServer = { url: "https://mcp.atlassian.com/v1/mcp", auth: "oauth" };
    new FileOAuthProvider({ name: "jira", srv, dir })
      .saveClientInformation({ client_id: "dcr-id", redirect_uris: ["http://localhost:4849/callback"] });
    expect(new FileOAuthProvider({ name: "jira", srv, dir }).clientInformation()?.client_id).toBe("dcr-id");
    const moved = new FileOAuthProvider({ name: "jira", srv: { ...srv, oauth: { callbackPort: 5_000 } }, dir });
    expect(moved.clientInformation()).toBeUndefined();
  });

  test("headless provider never redirects", () => {
    const provider = new FileOAuthProvider({ name: "slack", srv: SLACK, dir: newDir() });
    expect(() => provider.redirectToAuthorization(new URL("https://slack.com/oauth"))).toThrow(AuthRequiredError);
  });

  test("a failed refresh with a refresh token on disk stays retryable", () => {
    const provider = new FileOAuthProvider({ name: "slack", srv: SLACK, dir: newDir() });
    provider.saveTokens({ access_token: "a", refresh_token: "r", token_type: "bearer" });
    let thrown: unknown;
    try { provider.redirectToAuthorization(new URL("https://slack.com/oauth")); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(AuthRequiredError);
  });

  test("re-auth ignores stored tokens without deleting them", () => {
    const dir = newDir();
    new FileOAuthProvider({ name: "slack", srv: SLACK, dir }).saveTokens({ access_token: "old", token_type: "bearer" });
    const reauth = new FileOAuthProvider({ name: "slack", srv: SLACK, dir, isReauth: true });
    expect(reauth.tokens()).toBeUndefined();
    expect(new FileOAuthProvider({ name: "slack", srv: SLACK, dir }).tokens()?.access_token).toBe("old");
    reauth.saveTokens({ access_token: "new", token_type: "bearer" });
    expect(reauth.tokens()?.access_token).toBe("new");
  });

  test("a failed refresh doesn't wipe tokens another process just saved", () => {
    const dir = newDir();
    const daemonA = new FileOAuthProvider({ name: "slack", srv: SLACK, dir });
    daemonA.saveTokens({ access_token: "v1", refresh_token: "r1", token_type: "bearer" });
    daemonA.tokens();
    new FileOAuthProvider({ name: "slack", srv: SLACK, dir }).saveTokens({ access_token: "v2", refresh_token: "r2", token_type: "bearer" });
    daemonA.invalidateCredentials("tokens");
    expect(daemonA.tokens()?.access_token).toBe("v2");
    daemonA.invalidateCredentials("tokens");
    expect(daemonA.tokens()).toBeUndefined();
  });

  test("a server name can't escape the store directory", () => {
    expect(() => new FileOAuthProvider({ name: "../x", srv: SLACK, dir: newDir() })).toThrow();
  });
});

describe("server classification", () => {
  test("a url without type is an HTTP server", () => {
    expect(isHttpServer({ url: "https://mcp.slack.com/mcp" })).toBe(true);
    expect(isHttpServer({ type: "sse", url: "https://x.example/sse" })).toBe(false);
    expect(isHttpServer({ command: "npx" })).toBe(false);
  });

  test("oauth is opt-in", () => {
    expect(isOAuthServer(SLACK)).toBe(true);
    expect(isOAuthServer({ url: "https://x.example/mcp", oauth: {} })).toBe(true);
    expect(isOAuthServer({ type: "http", url: "https://x.example/mcp" })).toBe(false);
  });
});
