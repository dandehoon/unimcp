import http from "http";
import { randomBytes } from "crypto";
import readline from "readline";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FileOAuthProvider } from "./oauth.js";
import { log } from "./utils.js";

const CALLBACK_TIMEOUT_MS = 5 * 60_000;

/**
 * `close(isAuthorized)` answers the browser only once the code exchange has settled.
 * `startLink(consent)`: with `bindBrowser`, the local link that sends the browser on to `consent`.
 */
export type Callback = { code: Promise<string>; close: (isAuthorized: boolean) => void; startLink: (consent: URL) => URL };

export type CallbackOptions = {
  redirectUrl: string;
  callbackPort: number;
  expectedState: string;
  /** Also accept the redirect URL pasted into this stream — for a browser on another machine. */
  paste?: NodeJS.ReadableStream;
  /**
   * Serve `/start`, which sets a cookie the callback then requires: only a browser that opened the
   * start link here can finish, so a consent URL leaked from an agent can't sign in someone else.
   */
  bindBrowser?: boolean;
  /** Ends the wait, as a denial would. */
  signal?: AbortSignal;
};

type CallbackOutcome = { code: string } | { error: string };
export type CallbackResult = CallbackOutcome | null;

/**
 * The authorization code from a redirect URL, or `null` when it isn't our redirect — without our
 * `state`, any local page or process could end the flow.
 */
export function parseCallback(url: URL, expectedState: string): CallbackResult {
  if (url.pathname !== "/callback" || url.searchParams.get("state") !== expectedState) return null;
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (code && !error) return { code };
  return { error: `authorization denied: ${error ? error.replace(/[^\w.:-]/g, "?") : "no code"}` };
}

/**
 * The first leg of the OAuth flow: null when the stored tokens sufficed, else the second leg, which
 * waits for the redirect and exchanges its code.
 */
export async function beginAuthorization(
  { provider, serverUrl, callback }: { provider: FileOAuthProvider; serverUrl: string; callback: Callback },
): Promise<(() => Promise<void>) | null> {
  const authOpts = { serverUrl, scope: provider.scope };
  if ((await auth(provider, authOpts)) !== "REDIRECT") return null;
  return async () => { await auth(provider, { ...authOpts, authorizationCode: await callback.code }); };
}

/** Waits for the authorization code on the redirect URL's port, or pasted into `opts.paste`. */
export async function listenForCallback(opts: CallbackOptions): Promise<Callback> {
  let settle!: (result: CallbackOutcome) => void;
  const code = new Promise<string>((resolve, reject) => {
    settle = (r) => ("code" in r ? resolve(r.code) : reject(new Error(r.error)));
  });
  code.catch(() => {}); // awaited only after the redirect; a rejection before then must not crash
  let pending: http.ServerResponse | null = null;
  const binding = opts.bindBrowser ? browserBinding(opts) : undefined;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", opts.redirectUrl);
    if (binding && url.pathname === "/start") return binding.start(url, res);
    const result = parseCallback(url, opts.expectedState);
    if (!result) return void res.writeHead(404, { Connection: "close" }).end();
    if (binding && !binding.isBound(req)) {
      return void res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" })
        .end("unimcp: open the sign-in link you were given in a browser on this machine, and approve there.");
    }
    pending = res;
    settle(result);
  });
  await listen(server, opts.callbackPort);
  const stopPaste = opts.paste ? readPastedCallback(opts.paste, opts.expectedState, settle) : () => {};
  const timer = setTimeout(() => settle({ error: "timed out waiting for the browser callback" }), CALLBACK_TIMEOUT_MS);
  opts.signal?.addEventListener("abort", () => settle({ error: "sign-in cancelled" }), { once: true });

  return {
    code,
    startLink: (consent) => {
      if (!binding) throw new Error("startLink needs bindBrowser");
      return binding.link(consent);
    },
    close: (isAuthorized) => {
      clearTimeout(timer);
      stopPaste();
      pending?.writeHead(isAuthorized ? 200 : 400, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" })
        .end(isAuthorized ? "unimcp: authorized — you can close this tab." : "unimcp: authorization failed — start the sign-in again.");
      server.close();
    },
  };
}

// --- helpers ---

async function listen(server: http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      const why = err.code === "EADDRINUSE"
        ? "in use — a sign-in the unimcp daemon started may be waiting on it: open the link the agent gave, or retry in a few minutes"
        : err.message;
      reject(new Error(`callback port ${port}: ${why}`));
    });
    server.listen(port, "localhost", resolve);
  });
}

/** The `/start` link and the cookie it sets; named per port, since localhost cookies ignore the port. */
function browserBinding(opts: CallbackOptions) {
  const key = randomBytes(16).toString("hex");
  const nonce = randomBytes(16).toString("hex");
  const cookie = `unimcp_sign_in_${opts.callbackPort}`;
  let consent: URL | undefined;
  return {
    link(url: URL): URL {
      consent = url;
      return new URL(`/start?k=${key}`, opts.redirectUrl);
    },
    start(url: URL, res: http.ServerResponse): void {
      if (url.searchParams.get("k") !== key || !consent) return void res.writeHead(404, { Connection: "close" }).end();
      // Lax: still sent on the authorization server's top-level redirect back here.
      res.writeHead(302, {
        Location: consent.href,
        "Set-Cookie": `${cookie}=${nonce}; HttpOnly; SameSite=Lax; Path=/callback`,
        Connection: "close",
      }).end();
    },
    isBound(req: http.IncomingMessage): boolean {
      return (req.headers.cookie ?? "").split(/;\s*/).includes(`${cookie}=${nonce}`);
    },
  };
}

/** Reads pasted lines until one is our redirect URL. Returns the stopper. */
function readPastedCallback(
  input: NodeJS.ReadableStream,
  expectedState: string,
  settle: (result: CallbackOutcome) => void,
): () => void {
  // A TTY in canonical mode drops lines past MAX_CANON (~1 KB on macOS) — longer than some redirect
  // URLs — so read it raw, echoing to stderr, and pass Ctrl+C on as the interrupt raw mode swallows.
  const isTerminal = (input as NodeJS.ReadStream).isTTY === true;
  const rl = readline.createInterface({ input, output: process.stderr, terminal: isTerminal });
  rl.on("SIGINT", () => {
    rl.close();
    process.kill(process.pid, "SIGINT");
  });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    const result = URL.canParse(text) ? parseCallback(new URL(text), expectedState) : null;
    if (result) return settle(result);
    log("[auth] not this run's redirect URL — paste the full address the browser was sent to");
  });
  return () => rl.close();
}
