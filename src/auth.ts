import { spawn } from "child_process";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { loadConfig, isOAuthServer } from "./config.js";
import { findServer } from "./profiles.js";
import { FileOAuthProvider } from "./oauth.js";
import { listenForCallback } from "./auth-callback.js";
import { substituteCommands } from "./substitute.js";
import { log } from "./utils.js";

export type AuthOptions = {
  name: string;
  configPath: string;
  /** Open a browser (true) or print the URL (false); default: open unless this looks like a remote shell. */
  useBrowser?: boolean;
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
  const onRedirect = (url: URL) => (useBrowser ? openBrowser(url, hint) : printUrl(url, hint));
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
    const authOpts = { serverUrl: srv.url, scope: provider.scope };
    if ((await auth(provider, authOpts)) === "REDIRECT") {
      await auth(provider, { ...authOpts, authorizationCode: await callback.code });
    }
    isDone = true;
  } finally {
    callback.close(isDone);
  }
  log(`[auth] '${name}' authorized — running daemons connect it; reconnect your MCP client to see its tools`);
}

/** False over SSH or on a Linux box with no display — a browser there can't be opened or reach us. */
export function hasLocalBrowser(env: NodeJS.ProcessEnv, platform = process.platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  return platform !== "linux" || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

// --- helpers ---

const PASTE_HINT = "if the browser is on another machine, its redirect to localhost won't load — paste that page's full URL here";
const NO_PASTE_HINT = "stdin isn't a terminal, so the redirect must reach this machine's localhost (e.g. `ssh -t`, or forward the callback port)";

/** The URL comes from the server's metadata — untrusted: open only https, never a file or app scheme. */
function openBrowser(url: URL, hint: string): void {
  assertHttps(url);
  log(`[auth] opening browser — if it doesn't open, visit:\n${url.href}\n[auth] ${hint}`);
  // No shell anywhere: `cmd /c start` would run whatever follows an `&` in the query string.
  const [cmd, args] = process.platform === "darwin" ? ["open", [url.href]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url.href]]
    : ["xdg-open", [url.href]];
  spawn(cmd, args as string[], { detached: true, stdio: "ignore" })
    .on("error", (err) => log("[auth] could not open browser:", err.message))
    .unref();
}

function printUrl(url: URL, hint: string): void {
  assertHttps(url);
  log(`[auth] open this URL in any browser:\n${url.href}\n[auth] after approving: ${hint}`);
}

function assertHttps(url: URL): void {
  if (url.protocol !== "https:") throw new Error(`refusing non-https authorization URL: ${url.href}`);
}
