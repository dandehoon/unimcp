import http from "http";
import { spawn } from "child_process";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { loadConfig, isOAuthServer } from "./config.js";
import { FileOAuthProvider } from "./oauth.js";
import { log } from "./utils.js";

const CALLBACK_TIMEOUT_MS = 5 * 60_000;

/** `unimcp auth <name>` — runs the browser OAuth flow and stores tokens for the daemon to use. */
export async function runAuth(name: string, configPath: string): Promise<void> {
  const srv = loadConfig(configPath).mcpServers[name];
  if (!srv) throw new Error(`Server '${name}' not found (or skipped) in ${configPath}`);
  if (!isOAuthServer(srv)) throw new Error(`Server '${name}' is not configured with "auth": "oauth"`);

  // Existing tokens stay on disk, serving running daemons, until this run replaces them.
  const provider = new FileOAuthProvider({ name, srv, onRedirect: openBrowser, isReauth: true });
  const callback = await listenForCallback(provider);
  let isDone = false;
  try {
    const opts = { serverUrl: srv.url, scope: provider.scope };
    if ((await auth(provider, opts)) === "REDIRECT") {
      await auth(provider, { ...opts, authorizationCode: await callback.code });
    }
    isDone = true;
  } finally {
    callback.close(isDone);
  }
  log(`[auth] '${name}' authorized — running daemons connect it; reconnect your MCP client to see its tools`);
}

// --- helpers ---

/** `close(isAuthorized)` answers the browser only once the code exchange has settled. */
type Callback = { code: Promise<string>; close: (isAuthorized: boolean) => void };

/** Listens on the redirect URL for the authorization code, checking `state`. */
async function listenForCallback(provider: FileOAuthProvider): Promise<Callback> {
  let settle!: (err: Error | null, code?: string) => void;
  const code = new Promise<string>((resolve, reject) => {
    settle = (err, value) => (err ? reject(err) : resolve(value as string));
  });
  code.catch(() => {}); // awaited only after the redirect; a rejection before then must not crash
  let pending: http.ServerResponse | null = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", provider.redirectUrl);
    // Without our state it isn't the authorization server's redirect — any local page or process
    // can hit this port, and must not be able to end the flow.
    if (url.pathname !== "/callback" || url.searchParams.get("state") !== provider.expectedState) {
      return void res.writeHead(404, { Connection: "close" }).end();
    }
    const error = url.searchParams.get("error");
    const value = url.searchParams.get("code");
    pending = res;
    if (value && !error) settle(null, value);
    else settle(new Error(`authorization denied: ${(error ?? "no code").replace(/[^\w.:-]/g, "?")}`));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err) => reject(new Error(`callback port ${provider.callbackPort}: ${err.message}`)));
    server.listen(provider.callbackPort, "localhost", resolve);
  });
  const timer = setTimeout(() => settle(new Error("timed out waiting for the browser callback")), CALLBACK_TIMEOUT_MS);

  return {
    code,
    close: (isAuthorized) => {
      clearTimeout(timer);
      pending?.writeHead(isAuthorized ? 200 : 400, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" })
        .end(isAuthorized ? "unimcp: authorized — you can close this tab." : "unimcp: authorization failed — see the terminal.");
      server.close();
    },
  };
}

/** The URL comes from the server's metadata — untrusted: open only https, never a file or app scheme. */
function openBrowser(url: URL): void {
  if (url.protocol !== "https:") throw new Error(`refusing to open non-https authorization URL: ${url.href}`);
  log(`[auth] opening browser — if it doesn't open, visit:\n${url.href}`);
  // No shell anywhere: `cmd /c start` would run whatever follows an `&` in the query string.
  const [cmd, args] = process.platform === "darwin" ? ["open", [url.href]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url.href]]
    : ["xdg-open", [url.href]];
  spawn(cmd, args as string[], { detached: true, stdio: "ignore" })
    .on("error", (err) => log("[auth] could not open browser:", err.message))
    .unref();
}
