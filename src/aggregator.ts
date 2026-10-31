import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Minimatch } from "minimatch";
import { type Config, type GrantRule, type Profile, type ServerConfig, type ToolFilter, isHttpServer } from "./config.js";
import { GLOB_OPTS, lockedPatterns, lockingGrant } from "./grants.js";
import { PROFILE_ARG, type ProfileGroup, expandProfiles, routeProfile, takesProfileArg, withProfileArg, withoutPinnedArgs } from "./profiles.js";
import { AuthRequiredError } from "./oauth.js";
import { substituteCommands } from "./substitute.js";
import { type Connected, StillStarting, connectStdio, withDetail } from "./stdio.js";
import { buildSSETransport, buildTransport, isAuthError, isTransportError, withTimeout } from "./transport.js";
import { log, VERSION } from "./utils.js";

export const SEP = "__";
const CLIENT_NAME = "unimcp";
const CONNECT_TIMEOUT_MS = 30_000;
/** How long a `starting` local server may run before it counts as hung; a cold npx install can take minutes. */
const START_GIVE_UP_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

/**
 * `idle`: a profile member not yet used — it connects on its first call.
 * `starting`: a local server still running past the connect deadline, left to finish (see connectStdio).
 */
export type UpstreamState = "connected" | "failed" | "reconnecting" | "disconnected" | "idle" | "starting";

export type UpstreamStatus = {
  name: string;
  state: UpstreamState;
  toolCount: number;
  connectedAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  reconnectAttempts: number;
};

type UpstreamEntry = {
  name: string;
  client: Client;
  tools: Tool[];
  config: ServerConfig;
  state: UpstreamState;
  connectedAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  reconnectAttempts: number;
  /** Set on a profile member: reached only through its server's `profile` argument, never by its own name. */
  group?: string;
};

type AggregatedTool = Tool & { upstreamName: string; originalName: string };

const MATCH_ALL = [new Minimatch("*", { dot: true })];
const MATCH_NONE: Minimatch[] = [];
const patternCache = new Map<string, Minimatch[]>();

function compilePatterns(patterns: string[]): Minimatch[] {
  const key = patterns.join("\0");
  let compiled = patternCache.get(key);
  if (!compiled) {
    compiled = patterns.map((p) => new Minimatch(p, GLOB_OPTS));
    patternCache.set(key, compiled);
  }
  return compiled;
}

/** Checks whether a bare tool name passes a filter. */
export function matchesFilter(toolName: string, filter?: ToolFilter): boolean {
  const include = filter?.include ? compilePatterns(filter.include) : MATCH_ALL;
  const exclude = filter?.exclude ? compilePatterns(filter.exclude) : MATCH_NONE;
  return include.some((m) => m.match(toolName)) && !exclude.some((m) => m.match(toolName));
}

export class Aggregator {
  private upstreams: Map<string, UpstreamEntry> = new Map();
  private toolCache: AggregatedTool[] | null = null;
  private clientFilterCache = new Map<string, AggregatedTool[]>();
  private grants: Record<string, GrantRule[]> = {};
  private groups = new Map<string, ProfileGroup>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingReconnects = new Map<string, Promise<void>>();
  private expandedValues: string[] = [];

  /**
   * `startDeadlineMs`: how long a connect waits on a local server before leaving it `starting`.
   * `startGiveUpMs`: how long it may stay `starting` before it counts as hung and is stopped.
   */
  constructor(private readonly opts: { startDeadlineMs?: number; startGiveUpMs?: number } = {}) {}

  async connect(config: Config): Promise<void> {
    this.grants = config.grants ?? {};
    this.expandedValues = config.expandedValues ?? [];
    const entries = Object.entries(config.mcpServers).filter(([name, srv]) => srv.enabled !== false && isValidName(name, config.profiles));
    for (const server of Object.keys(config.profiles ?? {})) {
      if (!config.mcpServers[server]) log(`[grants] profiles for unknown server '${server}' — ignored`);
    }
    await Promise.all(entries.map(([name, srv]) => {
      const profiles = config.profiles?.[name];
      return profiles ? this.connectGroup({ name, srv, profiles }) : this.connectOne(name, srv);
    }));
  }

  /** The first member connects now, for the tool schemas every member shares; the rest on first call. */
  private async connectGroup({ name, srv, profiles }: { name: string; srv: ServerConfig; profiles: Record<string, Profile> }): Promise<void> {
    let expanded: ReturnType<typeof expandProfiles>;
    try {
      expanded = expandProfiles(name, srv, profiles);
    } catch (err) {
      log(`[${name}] invalid profiles — skipped: ${(err as Error).message}`);
      return;
    }
    this.groups.set(name, expanded.group);
    for (const m of expanded.members) this.upstreams.set(m.name, { ...blankEntry(m.name, m.srv, "idle"), group: name });
    // Down the list until one connects: a failing profile must not leave the group with no tools to list.
    // A starting one stops the walk too: the next member runs the same command, and a second npx
    // install into the same cache dir is what corrupts it.
    for (const m of expanded.members) {
      await this.connectOne(m.name, m.srv, name);
      const state = this.upstreams.get(m.name)?.state;
      if (state === "connected" || state === "starting") return;
    }
  }

  private async connectOne(name: string, srv: ServerConfig, group?: string): Promise<void> {
    const entry: UpstreamEntry = { ...blankEntry(name, srv, "idle"), group };
    this.upstreams.set(name, entry);
    try {
      this.adopt(entry, await this.connectClient(name, srv));
      log(`[${name}] connected (${entry.tools.length} tools)`);
    } catch (err) {
      if (err instanceof StillStarting) return this.awaitStart(entry, err);
      log(`[${name}] failed to connect:`, err);
      entry.state = "failed";
      entry.lastError = String(err);
      entry.lastErrorAt = Date.now();
      // Retrying can't help until the user authorizes; retryIfDown picks up their new tokens.
      if (!(err instanceof AuthRequiredError)) this.scheduleReconnect(name);
    }
  }

  private adopt(entry: UpstreamEntry, result: Connected): void {
    entry.client = result.client;
    entry.tools = result.tools.filter((t) => matchesFilter(t.name, serverFilter(entry.config)));
    entry.state = "connected";
    entry.connectedAt = Date.now();
    entry.reconnectAttempts = 0;
    this.invalidateCache();
    this.setupErrorHandler(entry.name, result.client);
  }

  /**
   * Leaves a slow local server running and takes it on when it answers. Registered as the entry's
   * in-flight attempt, so a call or retry waits on it instead of spawning a second copy.
   */
  private awaitStart(entry: UpstreamEntry, starting: StillStarting): void {
    const { name } = entry;
    const giveUpMs = this.opts.startGiveUpMs ?? START_GIVE_UP_MS;
    log(`[${name}] still starting after ${(this.opts.startDeadlineMs ?? CONNECT_TIMEOUT_MS) / 1_000} s — waiting for it`);
    entry.state = "starting";
    entry.client = starting.client; // so disconnect() stops it
    // A hung server would otherwise hold its process, and the daemon's idle shutdown, forever.
    let gaveUp = false;
    const giveUp = setTimeout(() => {
      gaveUp = true;
      void starting.client.close().catch(() => {});
    }, giveUpMs);
    const adoption = starting.ready.then(
      (result) => {
        this.adopt(entry, result);
        log(`[${name}] connected after a slow start (${entry.tools.length} tools)`);
      },
      (err) => {
        // disconnect() closed it on reload or shutdown: this aggregator is done with it.
        if (entry.state === "disconnected") return;
        // Prefixed, not replaced: err carries the server's last stderr lines.
        const reason = gaveUp ? withDetail(`still starting after ${giveUpMs / 1_000} s — stopped`, `: ${err instanceof Error ? err.message : String(err)}`) : err;
        log(`[${name}] exited while starting:`, reason);
        entry.state = "failed";
        entry.lastError = String(reason);
        entry.lastErrorAt = Date.now();
        this.scheduleReconnect(name);
      },
    ).finally(() => {
      clearTimeout(giveUp);
      if (this.pendingReconnects.get(name) === adoption) this.pendingReconnects.delete(name);
    });
    this.pendingReconnects.set(name, adoption);
  }

  private setupErrorHandler(name: string, client: Client): void {
    client.onerror = () => this.scheduleReconnect(name);
    client.onclose = () => {
      const entry = this.upstreams.get(name);
      if (entry && entry.state === "connected") this.scheduleReconnect(name);
    };
  }

  private scheduleReconnect(name: string): void {
    const entry = this.upstreams.get(name);
    if (!entry || entry.state === "reconnecting" || entry.state === "disconnected" || entry.state === "starting") return;
    if (entry.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      entry.state = "failed";
      return;
    }
    entry.state = "reconnecting";
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** entry.reconnectAttempts, BACKOFF_CAP_MS);
    entry.reconnectAttempts++;
    const timer = setTimeout(() => void this.track(name, () => this.attemptReconnect(name)), delay);
    this.reconnectTimers.set(name, timer);
  }

  private async attemptReconnect(name: string): Promise<void> {
    this.reconnectTimers.delete(name);
    const entry = this.upstreams.get(name);
    if (!entry || entry.state === "disconnected") return;

    try {
      this.adopt(entry, await this.connectClient(name, entry.config));
      log(`[${name}] reconnected (${entry.tools.length} tools)`);
    } catch (err) {
      if (err instanceof StillStarting) return this.awaitStart(entry, err);
      entry.lastError = String(err);
      entry.lastErrorAt = Date.now();
      if (entry.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS || err instanceof AuthRequiredError) {
        entry.state = "failed";
        log(`[${name}] reconnect failed permanently:`, err);
      } else {
        entry.state = "failed";
        this.scheduleReconnect(name);
      }
    }
  }

  private invalidateCache(): void {
    this.toolCache = null;
    this.clientFilterCache.clear();
  }

  private buildToolCache(): AggregatedTool[] {
    const listed = (name: string, tools: Tool[]) => tools.map((t) => ({
      ...t,
      name: `${name}${SEP}${t.name}`,
      upstreamName: name,
      originalName: t.name,
    }));
    const plain = [...this.upstreams.values()].filter((e) => !e.group)
      .flatMap((e) => listed(e.name, e.tools.map((t) => withoutPinnedArgs(t, e.config.pinArgs))));
    const grouped = [...this.groups.values()].flatMap((g) =>
      listed(g.name, this.groupTools(g).map((t) => withoutPinnedArgs(t, g.config.pinArgs))));
    return [...plain, ...grouped];
  }

  /** A group's tools, from whichever member has connected: they all run the same server. */
  private groupTools(group: ProfileGroup): Tool[] {
    const tools = [...this.upstreams.values()].find((e) => e.group === group.name && e.tools.length)?.tools ?? [];
    return tools.filter((t) => {
      if (!takesProfileArg(t)) return true;
      log(`[${group.name}] '${t.name}' takes its own 'profile' argument, which the selector would shadow — not listed`);
      return false;
    });
  }

  listTools(clientFilter?: ToolFilter): AggregatedTool[] {
    if (!this.toolCache) {
      this.toolCache = this.buildToolCache();
      this.clientFilterCache.clear();
    }
    // Grant locks are the daemon's to apply: a client that sends no grants holds none.
    const held = new Set(clientFilter?.grants);
    const locked = lockedPatterns(this.grants, held);
    const profiles = this.heldProfiles(held);
    const key = JSON.stringify([clientFilter?.include, clientFilter?.exclude, locked, profiles]);
    let cached = this.clientFilterCache.get(key);
    if (!cached) {
      cached = this.toolCache.filter((t) => isVisibleToClient({ tool: t, clientFilter, locked }))
        .flatMap((t) => this.withHeldProfiles(t, profiles));
      this.clientFilterCache.set(key, cached);
    }
    return cached;
  }

  /** Each group's profiles the client holds the grant for: the only ones it sees or may pick. */
  private heldProfiles(held: Set<string>): Record<string, string[]> {
    return Object.fromEntries([...this.groups.values()].map((g) => [g.name, g.profiles.filter((p) => held.has(p))]));
  }

  /** A group tool with its selector listing the held profiles, or nothing when none is held. */
  private withHeldProfiles(tool: AggregatedTool, profiles: Record<string, string[]>): AggregatedTool[] {
    const group = this.groups.get(tool.upstreamName);
    if (!group) return [tool];
    const held = profiles[group.name];
    return held.length ? [withProfileArg(tool, { ...group, profiles: held }) as AggregatedTool] : [];
  }

  /** Whether a client may call a tool, judged by name: a server that is down lists no tools, yet calling one must still reach callTool's reconnect. */
  isCallable(prefixedName: string, clientFilter?: ToolFilter): boolean {
    const sep = prefixedName.indexOf(SEP);
    const config = sep > 0 ? this.listedConfig(prefixedName.slice(0, sep)) : undefined;
    if (!config) return false;
    const tool = { name: prefixedName, originalName: prefixedName.slice(sep + SEP.length) };
    const held = new Set(clientFilter?.grants);
    const group = this.groups.get(prefixedName.slice(0, sep));
    if (group && !group.profiles.some((p) => held.has(p))) return false;
    const locked = lockedPatterns(this.grants, held);
    return matchesFilter(tool.originalName, serverFilter(config)) && isVisibleToClient({ tool, clientFilter, locked });
  }

  /** The grant this call needs and the client lacks, if any: the profile it names, or an argument rule's. */
  lockingGrant(call: { name: string; args: Record<string, unknown>; clientFilter?: ToolFilter }): string | undefined {
    const held = new Set(call.clientFilter?.grants);
    const server = call.name.slice(0, call.name.indexOf(SEP));
    // Judged on the server prefix alone, never a glob over the tool name, so no tool name slips past it.
    const group = this.groups.get(server);
    const profile = call.args[PROFILE_ARG];
    if (group && typeof profile === "string" && group.profiles.includes(profile) && !held.has(profile)) return profile;
    // Judged on the arguments the upstream receives: a pinned value can't dodge a rule by being left out.
    const args = { ...call.args, ...this.listedConfig(server)?.pinArgs };
    return lockingGrant(this.grants, held, { name: call.name, args });
  }

  /** Config of a server as clients see it: a group or a plain server, never a group's member. */
  private listedConfig(name: string): ServerConfig | undefined {
    const entry = this.upstreams.get(name);
    return this.groups.get(name)?.config ?? (entry && !entry.group ? entry.config : undefined);
  }

  async callTool(prefixedName: string, rawArgs: Record<string, unknown>): Promise<ReturnType<Client["callTool"]>> {
    const sep = prefixedName.indexOf(SEP);
    if (sep === -1) throw new Error(`Invalid tool name (missing separator): ${prefixedName}`);
    const listedName = prefixedName.slice(0, sep);
    const toolName = prefixedName.slice(sep + SEP.length);
    const group = this.groups.get(listedName);
    const { member: upstreamName, args } = group ? routeProfile(group, rawArgs) : { member: listedName, args: rawArgs };

    const upstream = this.upstreams.get(upstreamName);
    if (!upstream || (upstream.group && !group)) throw new Error(`Unknown upstream: ${upstreamName}`);
    // Fail fast rather than hold the call for a minutes-long first install, or start a sibling
    // profile alongside it — starting, or still connecting toward it: both run the same command
    // into the same install dir.
    if (upstream.state !== "connected") {
      const busy = [...this.upstreams.values()].find((e) => e === upstream
        ? e.state === "starting"
        : group && e.group === group.name && "command" in e.config && (e.state === "starting" || this.pendingReconnects.has(e.name)));
      if (busy) throw new Error(`Upstream ${busy.name} is still starting (first install?) — retry shortly`);
      await this.onDemandReconnect(upstreamName, upstream);
      if ((upstream as UpstreamEntry).state !== "connected") {
        throw new Error(`Upstream ${upstreamName} is ${upstream.state} (reconnect failed)`);
      }
    }

    try {
      return await withTimeout(
        // Pinned last: the client can't override what the config fixes.
        upstream.client.callTool({ name: toolName, arguments: { ...args, ...upstream.config.pinArgs } }),
        CALL_TIMEOUT_MS,
        `[${upstreamName}] callTool timed out`,
      );
    } catch (err) {
      if (isTransportError(err)) {
        upstream.state = "failed";
        upstream.lastError = String(err);
        upstream.lastErrorAt = Date.now();
        this.invalidateCache();
        this.scheduleReconnect(upstreamName);
      }
      throw err;
    }
  }

  getStatus(): UpstreamStatus[] {
    return [...this.upstreams.values()].map(({ name, state, tools, connectedAt, lastError, lastErrorAt, reconnectAttempts }) => ({
      name, state, toolCount: tools.length, connectedAt, lastError, lastErrorAt, reconnectAttempts,
    }));
  }

  /** Settles once no upstream is `starting`: each has connected, failed, or been given up on. */
  async whenStarted(): Promise<void> {
    const starting = [...this.upstreams.values()].filter((e) => e.state === "starting");
    await Promise.allSettled(starting.map((e) => this.pendingReconnects.get(e.name)));
  }

  isReconnecting(): boolean {
    return [...this.upstreams.values()].some((e) => e.state === "reconnecting" || e.state === "starting");
  }

  /** Reconnects a failed server now, e.g. once its OAuth tokens arrive. */
  async retryIfDown(name: string): Promise<void> {
    // An attempt already in flight may have read the store before the new tokens landed.
    await this.pendingReconnects.get(name);
    const entry = this.upstreams.get(name);
    if (entry?.state === "failed") await this.onDemandReconnect(name, entry);
  }

  private onDemandReconnect(name: string, entry: UpstreamEntry): Promise<void> {
    return this.track(name, () => this.reconnectNow(name, entry));
  }

  /** Concurrent attempts share one, so a server never ends up with two live clients. */
  private track(name: string, run: () => Promise<void>): Promise<void> {
    const inFlight = this.pendingReconnects.get(name);
    if (inFlight) return inFlight;
    // Only its own slot: an attempt that ends in awaitStart has already put the adoption there.
    const attempt: Promise<void> = run().finally(() => {
      if (this.pendingReconnects.get(name) === attempt) this.pendingReconnects.delete(name);
    });
    this.pendingReconnects.set(name, attempt);
    return attempt;
  }

  private async reconnectNow(name: string, entry: UpstreamEntry): Promise<void> {
    const timer = this.reconnectTimers.get(name);
    if (timer) { clearTimeout(timer); this.reconnectTimers.delete(name); }

    entry.reconnectAttempts = 0;
    try {
      this.adopt(entry, await this.connectClient(name, entry.config));
      log(`[${name}] on-demand reconnect succeeded (${entry.tools.length} tools)`);
    } catch (err) {
      if (err instanceof StillStarting) return this.awaitStart(entry, err);
      entry.lastError = String(err);
      entry.lastErrorAt = Date.now();
      entry.state = "failed";
      log(`[${name}] on-demand reconnect failed:`, err);
    }
  }

  private async connectClient(name: string, rawSrv: ServerConfig): Promise<Connected> {
    const srv = await substituteCommands(rawSrv);
    if ("command" in srv) {
      const client = new Client({ name: CLIENT_NAME, version: VERSION });
      const secrets = [...Object.values(srv.env ?? {}), ...this.expandedValues];
      return connectStdio({ name, srv, client, deadlineMs: this.opts.startDeadlineMs ?? CONNECT_TIMEOUT_MS, secrets });
    }
    const client = new Client({ name: CLIENT_NAME, version: VERSION });
    const transport = buildTransport(name, srv);
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `[${name}] connect timed out`);
      const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `[${name}] listTools timed out`);
      return { client, tools };
    } catch (err) {
      try { await client.close(); } catch { /* ignore */ }
      if (isHttpServer(srv) && !isAuthError(err)) return this.connectViaSSE(name, srv);
      throw err;
    }
  }

  private async connectViaSSE(name: string, srv: ServerConfig): Promise<{ client: Client; tools: Tool[] }> {
    log(`[${name}] StreamableHTTP failed, trying SSE fallback…`);
    const client = new Client({ name: CLIENT_NAME, version: VERSION });
    const transport = buildSSETransport(name, srv);
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `[${name}] SSE connect timed out`);
      const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `[${name}] SSE listTools timed out`);
      log(`[${name}] connected via SSE fallback`);
      return { client, tools };
    } catch (err) {
      try { await client.close(); } catch { /* ignore */ }
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const entry of this.upstreams.values()) entry.state = "disconnected";
    this.invalidateCache();
    const results = await Promise.allSettled(Array.from(this.upstreams.values(), ({ client }) => client.close()));
    this.upstreams.clear();
    for (const r of results) {
      if (r.status === "rejected") log("[aggregator] disconnect error:", r.reason);
    }
  }
}

// --- helpers ---

function isValidName(name: string, profiles: Config["profiles"]): boolean {
  // `.` joins a server and its profile in member names: `a.b` would collide with profile `b` of `a`.
  const shadowed = Object.keys(profiles ?? {}).find((server) => name.startsWith(`${server}.`));
  if (!name.includes(SEP) && !shadowed) return true;
  log(`[${name}] server name must not contain "${SEP}" or start with "${shadowed}." (a server with profiles) — skipped`);
  return false;
}

/** An entry with no live client: one that failed to connect, or a profile member not used yet. */
function blankEntry(name: string, config: ServerConfig, state: "failed" | "idle"): UpstreamEntry {
  return {
    name, client: new Client({ name: CLIENT_NAME, version: VERSION }), tools: [], config,
    state, connectedAt: null, lastError: null, lastErrorAt: null, reconnectAttempts: 0,
  };
}

type VisibilityCheck = { tool: { name: string; originalName: string }; clientFilter?: ToolFilter; locked: string[] };

function isVisibleToClient({ tool, clientFilter, locked }: VisibilityCheck): boolean {
  return matchesFilter(tool.originalName, clientFilter) && !compilePatterns(locked).some((m) => m.match(tool.name));
}

function serverFilter(srv: ServerConfig): ToolFilter | undefined {
  if (!srv.include && !srv.exclude) return undefined;
  return { include: srv.include, exclude: srv.exclude };
}
