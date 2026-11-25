import type { Aggregator, SignInTarget } from "./aggregator.js";
import { type Callback, beginAuthorization, listenForCallback } from "./auth-callback.js";
import { hasLocalBrowser, openUrl } from "./browser.js";
import { type OAuthServer, isOAuthServer } from "./config.js";
import { FileOAuthProvider, assertAuthorizationUrl, callbackPortOf } from "./oauth.js";
import { withTimeout } from "./transport.js";
import { log } from "./utils.js";

// Sign-ins the daemon runs for its clients. The agent gets a localhost link that sends the browser on
// to the consent page and binds the redirect to that browser; the saved tokens reach the aggregator
// through the token-store watcher, as with `unimcp auth`.

/** Discovery and client registration, kept short so a refresh still answers within the bridge's timeout. */
const START_TIMEOUT_MS = 10_000;

type SignInLink = { url: string } | { error: string };

/**
 * `dir`: token store directory, OAUTH_DIR by default. `startTimeoutMs`: see START_TIMEOUT_MS.
 * `hasBrowser`: whether a browser can reach this machine's localhost, `hasLocalBrowser` by default.
 */
export type SignInsOptions = { dir?: string; startTimeoutMs?: number; hasBrowser?: boolean };

type Pending = { serverUrl: string; port: number; link: Promise<URL | null>; abort: AbortController; done: Promise<void> };
type Run = { name: string; target: SignInTarget; signal: AbortSignal; previous?: Promise<void> };
type Waiting = { name: string; finish: () => Promise<void>; callback: Callback; mask: (text: string) => string };

export class SignIns {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly opts: SignInsOptions = {}) {}

  /** Whether a sign-in is waiting for its browser: the daemon must stay up for the redirect. */
  isPending(): boolean {
    return this.pending.size > 0;
  }

  /** A sign-in link for each of `names` waiting on one; the rest are left out. */
  async links(aggregator: Aggregator, names: string[]): Promise<Map<string, SignInLink>> {
    const links = await Promise.all(names.map(async (name) => [name, await this.link(aggregator, name)] as const));
    return new Map(links.filter((l): l is [string, SignInLink] => l[1] !== undefined));
  }

  /** The link for `name`, from the sign-in already waiting or a new one; undefined when it needs none. */
  async link(aggregator: Aggregator, name: string): Promise<SignInLink | undefined> {
    const target = aggregator.signInTarget(name);
    const config = target?.config;
    if (!target || !config || !isOAuthServer(config)) return undefined;
    // The browser's redirect goes to its own machine's localhost, never reaching a daemon over SSH.
    if (!(this.opts.hasBrowser ?? hasLocalBrowser(process.env))) return { error: `the daemon runs over SSH, out of the browser's reach — run there: unimcp auth ${name}` };
    try {
      const url = await this.pendingFor(name, { ...target, config }).link;
      return url ? { url: url.href } : undefined;
    } catch (err) {
      return { error: String(err) };
    }
  }

  // --- helpers ---

  private pendingFor(name: string, target: SignInTarget & { config: OAuthServer }): Pending {
    const existing = this.pending.get(name);
    if (existing?.serverUrl === target.config.url) return existing;
    // The config moved under it: its link would sign in to the old URL.
    existing?.abort.abort();
    const port = callbackPortOf(target.config);
    // One listener per port, and the browser's redirect carries no server name to route by.
    const busy = [...this.pending].find(([other, p]) => other !== name && p.port === port);
    if (busy) throw new Error(`a sign-in for '${busy[0]}' is waiting on callback port ${port} — finish it, then try again`);

    const abort = new AbortController();
    let settle!: () => void;
    const entry: Pending = { serverUrl: target.config.url, port, abort, link: Promise.resolve(null), done: new Promise((r) => { settle = r; }) };
    const release = () => {
      if (this.pending.get(name) === entry) this.pending.delete(name);
      settle();
    };
    entry.link = this.run({ name, target, signal: abort.signal, previous: existing?.done }, release);
    entry.link.then((url) => { if (!url) release(); }, release);
    this.pending.set(name, entry);
    return entry;
  }

  /** Runs the flow up to the consent page and returns the start link; the code exchange waits on in the background. */
  private async run({ name, target, signal, previous }: Run, release: () => void): Promise<URL | null> {
    await previous; // its listener must let go of the port first
    const { srv, mask } = await target.resolve();
    if (!isOAuthServer(srv)) return null;
    let consent: URL | undefined;
    const provider = new FileOAuthProvider({
      name, srv, dir: this.opts.dir,
      onRedirect: (url) => { consent = assertAuthorizationUrl(url, { srv }); },
    });
    const callback = await listenForCallback({
      redirectUrl: provider.redirectUrl, callbackPort: provider.callbackPort, expectedState: provider.expectedState,
      bindBrowser: true, signal,
    });
    try {
      const begun = beginAuthorization({ provider, serverUrl: srv.url, callback });
      const timeoutMs = this.opts.startTimeoutMs ?? START_TIMEOUT_MS;
      const finish = await withTimeout(begun, timeoutMs, `the authorization server didn't answer within ${timeoutMs / 1_000} s`);
      if (!finish || !consent) {
        callback.close(true);
        return null;
      }
      const link = callback.startLink(consent);
      if (srv.oauth?.openBrowser === true) openUrl(link);
      void this.complete({ name, finish, callback, mask }).finally(release);
      return link;
    } catch (err) {
      callback.close(false);
      throw new Error(mask(String(err)));
    }
  }

  private async complete({ name, finish, callback, mask }: Waiting): Promise<void> {
    let isDone = false;
    try {
      await finish();
      isDone = true;
      log(`[${name}] signed in`);
    } catch (err) {
      log(`[${name}] sign-in failed:`, mask(String(err)));
    } finally {
      callback.close(isDone);
    }
  }
}
