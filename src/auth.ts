import { loadConfig, isOAuthServer } from "./config.js";
import { findServer } from "./profiles.js";
import { FileOAuthProvider, assertAuthorizationUrl } from "./oauth.js";
import { beginAuthorization, listenForCallback } from "./auth-callback.js";
import { hasLocalBrowser, openUrl } from "./browser.js";
import { substituteCommands } from "./substitute.js";
import { log } from "./utils.js";

export type AuthOptions = {
  name: string;
  configPath: string;
  /** Open a browser (true) or print the URL (false); default: open unless this looks like a remote shell. */
  useBrowser?: boolean;
  /** Accept an http:// authorization URL even for an https server; default: https only, unless the server's url is http. */
  allowHttp?: boolean;
};

/** `unimcp auth <name>` — runs the browser OAuth flow and stores tokens for the daemon to use. */
export async function runAuth(opts: AuthOptions): Promise<void> {
  const { name, configPath } = opts;
  const found = findServer(loadConfig(configPath), name);
  if (!found) throw new Error(`Server '${name}' not found (or skipped) in ${configPath} — a server with profiles is authorized per profile: <server>.<profile>`);
  const srv = await substituteCommands(found);
  if (!isOAuthServer(srv)) throw new Error(`Server '${name}' is not configured with "auth": "oauth"`);

  const useBrowser = opts.useBrowser ?? hasLocalBrowser(process.env);
  const paste = process.stdin.isTTY ? process.stdin : undefined;
  const hint = paste ? PASTE_HINT : NO_PASTE_HINT;
  const onRedirect = (url: URL) => {
    assertAuthorizationUrl(url, { srv, allowHttp: opts.allowHttp });
    return useBrowser ? openBrowser(url, hint) : printUrl(url, hint);
  };
  // Existing tokens stay on disk, serving running daemons, until this run replaces them.
  const provider = new FileOAuthProvider({ name, srv, onRedirect, isReauth: true });
  const callback = await listenForCallback({
    redirectUrl: provider.redirectUrl,
    callbackPort: provider.callbackPort,
    expectedState: provider.expectedState,
    paste,
  });
  let isDone = false;
  try {
    const finish = await beginAuthorization({ provider, serverUrl: srv.url, callback });
    await finish?.();
    isDone = true;
  } finally {
    callback.close(isDone);
  }
  log(`[auth] '${name}' authorized — running daemons connect it; reconnect your MCP client to see its tools`);
}

// --- helpers ---

const PASTE_HINT = "if the browser is on another machine, its redirect to localhost won't load — paste that page's full URL here";
const NO_PASTE_HINT = "stdin isn't a terminal, so the redirect must reach this machine's localhost (e.g. `ssh -t`, or forward the callback port)";

function openBrowser(url: URL, hint: string): void {
  log(`[auth] opening browser — if it doesn't open, visit:\n${url.href}\n[auth] ${hint}`);
  openUrl(url);
}

function printUrl(url: URL, hint: string): void {
  log(`[auth] open this URL in any browser:\n${url.href}\n[auth] after approving: ${hint}`);
}
