import { createHash, randomBytes } from "crypto";
import { mkdirSync, renameSync } from "fs";
import path from "path";
import { watch } from "chokidar";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { CONFIG_DIR, type HttpServer, type SseServer } from "./config.js";
import { parseJsonSafe, readFileSafe, writeFileSafe, toJson, PERMS_PRIVATE } from "./utils.js";

export const OAUTH_DIR = path.join(CONFIG_DIR, "oauth");
const DEFAULT_CALLBACK_PORT = 4_849;

type OAuthServer = HttpServer | SseServer;

type Store = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens };

export type OAuthProviderOptions = {
  name: string;
  srv: OAuthServer;
  /** Opens the consent page; without it the provider is headless and fails with AuthRequiredError. */
  onRedirect?: (url: URL) => void;
  /** Store directory; defaults to OAUTH_DIR. */
  dir?: string;
  /** Ignore stored tokens (without deleting them) until this run saves new ones. */
  isReauth?: boolean;
};

/** The server has no usable tokens and needs `unimcp auth <name>`. */
export class AuthRequiredError extends Error {
  constructor(name: string) {
    super(`[${name}] OAuth authorization required — run: unimcp auth ${name}`);
  }
}

/** Server name a token file belongs to, or null for any other file. */
export function serverNameOfStoreFile(file: string): string | null {
  const match = /^(.+)\.[0-9a-f]{8}\.json$/.exec(path.basename(file));
  return match ? match[1] : null;
}

/** Calls `onChange(serverName)` whenever a server's token file is written. Returns the closer. */
export function watchTokenStore(onChange: (name: string) => void): () => Promise<void> {
  mkdirSync(OAUTH_DIR, { recursive: true, mode: 0o700 });
  const watcher = watch(OAUTH_DIR, { ignoreInitial: true, depth: 0 });
  const handle = (file: string) => {
    const name = serverNameOfStoreFile(file);
    if (name) onChange(name);
  };
  watcher.on("add", handle).on("change", handle);
  return () => watcher.close();
}

/** Persists client registration and tokens per server (keyed by name + URL) under OAUTH_DIR. */
export class FileOAuthProvider implements OAuthClientProvider {
  readonly expectedState = randomBytes(16).toString("hex");
  private verifier = "";
  private readonly file: string;
  private hasSavedTokens = false;
  /** Access token last handed to the SDK — tells our failed refresh apart from another process's success. */
  private handedOut?: string;

  constructor(private readonly opts: OAuthProviderOptions) {
    if (path.basename(opts.name) !== opts.name) throw new Error(`Invalid server name for OAuth: ${opts.name}`);
    const urlHash = createHash("sha256").update(opts.srv.url).digest("hex").slice(0, 8);
    this.file = path.join(opts.dir ?? OAUTH_DIR, `${opts.name}.${urlHash}.json`);
  }

  get callbackPort(): number {
    const port = this.opts.srv.oauth?.callbackPort;
    return Number.isInteger(port) ? (port as number) : DEFAULT_CALLBACK_PORT;
  }

  get scope(): string | undefined {
    return this.opts.srv.oauth?.scopes?.join(" ") || undefined;
  }

  get redirectUrl(): string {
    return `http://localhost:${this.callbackPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "unimcp",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.opts.srv.oauth?.clientSecret ? "client_secret_post" : "none",
      scope: this.scope,
    };
  }

  state(): string {
    return this.expectedState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const { clientId, clientSecret } = this.opts.srv.oauth ?? {};
    if (clientId) return { client_id: clientId, client_secret: clientSecret };
    // A registration made for another callbackPort would fail the redirect check; register anew.
    const { client } = this.read();
    const registered = client && "redirect_uris" in client ? client.redirect_uris : undefined;
    return registered && !registered.includes(this.redirectUrl) ? undefined : client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.write({ ...this.read(), client });
  }

  tokens(): OAuthTokens | undefined {
    if (this.opts.isReauth && !this.hasSavedTokens) return undefined;
    const { tokens } = this.read();
    this.handedOut = tokens?.access_token;
    return tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.hasSavedTokens = true;
    this.write({ ...this.read(), tokens });
  }

  redirectToAuthorization(url: URL): void {
    if (this.opts.onRedirect) return this.opts.onRedirect(url);
    // The SDK lands here when a refresh fails transiently (network, 5xx) too; only missing
    // tokens need the user — anything else is worth the aggregator's retries.
    if (this.read().tokens?.refresh_token) throw new Error(`[${this.opts.name}] OAuth token refresh failed`);
    throw new AuthRequiredError(this.opts.name);
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "verifier") this.verifier = "";
    if (scope === "verifier" || scope === "discovery") return;
    const { client, tokens } = this.read();
    // Another process (a second daemon, `unimcp auth`) already replaced the tokens that failed here.
    if (scope !== "client" && this.handedOut && tokens?.access_token !== this.handedOut) return;
    if (scope === "all") this.write({});
    if (scope === "client") this.write({ tokens });
    if (scope === "tokens") this.write({ client });
  }

  // --- helpers ---

  private read(): Store {
    const raw = readFileSafe(this.file);
    const parsed = raw ? parseJsonSafe<unknown>(raw, `OAuth store ${this.file}`) : null;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Store) : {};
  }

  /** Atomic and owner-only: a fresh 0600 temp file renamed over the store, so neither a reader
   *  in another process nor an existing file's looser mode ever exposes a token. */
  private write(store: Store): void {
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSafe(tmp, toJson(store), PERMS_PRIVATE);
    renameSync(tmp, this.file);
  }
}
