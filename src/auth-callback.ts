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

export type CallbackResult = { code: string } | { error: string } | null;

/**
 * The authorization code from a redirect URL, or `null` when it isn't our redirect — without our
 * `state`, any local page or process could end the flow.
 */
export function parseCallback(url: URL, expectedState: string): CallbackResult {
  if (url.pathname !== "/callback" || url.searchParams.get("state") !== expectedState) return null;
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (code && !error) return { code };
  return { error: `authorization denied: ${(error ?? "no code").replace(/[^\w.:-]/g, "?")}` };
}

/** Waits for the authorization code on the redirect URL's port, or pasted into `opts.paste`. */
export async function listenForCallback(opts: CallbackOptions): Promise<Callback> {
  let settle!: (result: { code: string } | { error: string }) => void;
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
  settle: (result: { code: string } | { error: string }) => void,
): () => void {
  const rl = readline.createInterface({ input, terminal: false });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    const result = URL.canParse(text) ? parseCallback(new URL(text), expectedState) : null;
    if (result) return settle(result);
    log("[auth] not this run's redirect URL — paste the full address the browser was sent to");
  });
  return () => rl.close();
}
