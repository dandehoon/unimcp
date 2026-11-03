import http from "http";
import readline from "readline";
import { log } from "./utils.js";

const CALLBACK_TIMEOUT_MS = 5 * 60_000;

/** `close(isAuthorized)` answers the browser only once the code exchange has settled. */
export type Callback = { code: Promise<string>; close: (isAuthorized: boolean) => void };

export type CallbackOptions = {
  redirectUrl: string;
  callbackPort: number;
  expectedState: string;
  /** Also accept the redirect URL pasted into this stream — for a browser on another machine. */
  paste?: NodeJS.ReadableStream;
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

/** Waits for the authorization code on the redirect URL's port, or pasted into `opts.paste`. */
export async function listenForCallback(opts: CallbackOptions): Promise<Callback> {
  let settle!: (result: CallbackOutcome) => void;
  const code = new Promise<string>((resolve, reject) => {
    settle = (r) => ("code" in r ? resolve(r.code) : reject(new Error(r.error)));
  });
  code.catch(() => {}); // awaited only after the redirect; a rejection before then must not crash
  let pending: http.ServerResponse | null = null;

  const server = http.createServer((req, res) => {
    const result = parseCallback(new URL(req.url ?? "/", opts.redirectUrl), opts.expectedState);
    if (!result) return void res.writeHead(404, { Connection: "close" }).end();
    pending = res;
    settle(result);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err) => reject(new Error(`callback port ${opts.callbackPort}: ${err.message}`)));
    server.listen(opts.callbackPort, "localhost", resolve);
  });
  const stopPaste = opts.paste ? readPastedCallback(opts.paste, opts.expectedState, settle) : () => {};
  const timer = setTimeout(() => settle({ error: "timed out waiting for the browser callback" }), CALLBACK_TIMEOUT_MS);

  return {
    code,
    close: (isAuthorized) => {
      clearTimeout(timer);
      stopPaste();
      pending?.writeHead(isAuthorized ? 200 : 400, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" })
        .end(isAuthorized ? "unimcp: authorized — you can close this tab." : "unimcp: authorization failed — see the terminal.");
      server.close();
    },
  };
}

// --- helpers ---

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
