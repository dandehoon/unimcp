import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { Minimatch } from "minimatch";
import { type Config, type GrantRule, type Profile, type ServerConfig, type ToolFilter, isHttpServer } from "./config.js";
import { GLOB_OPTS, lockedPatterns, lockingGrant } from "./grants.js";
import { PROFILE_ARG, type ProfileGroup, expandProfiles, routeProfile, takesProfileArg, withProfileArg, withoutPinnedArgs } from "./profiles.js";
import { AuthRequiredError } from "./oauth.js";
import { substituteCommands } from "./substitute.js";
import { type Connected, StillStarting, connectStdio, withDetail } from "./stdio.js";
import { buildSSETransport, buildTransport, isAuthError, isTimeout, isTransportError, wasNotDelivered, withTimeout } from "./transport.js";
import { log, maskSecrets, RESERVED_SERVER_NAME, VERSION } from "./utils.js";

export const SEP = "__";
const CLIENT_NAME = "unimcp";
const CONNECT_TIMEOUT_MS = 30_000;
/** How long a `starting` local server may run before it counts as hung; a cold npx install can take minutes. */
const START_GIVE_UP_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 60_000;
/** How long a server whose call timed out gets to answer a ping before it counts as gone. */
const PING_TIMEOUT_MS = 5_000;
const BACKOFF_BASE_MS = 1_000;
/** A down server is retried at this interval for as long as it stays down; `unimcp__refresh` retries it sooner. */
const BACKOFF_CAP_MS = 10 * 60_000;
/** How long a refresh waits before reporting; under the bridge's 60 s request timeout. */
export const REFRESH_WAIT_MS = 45_000;

/**
 * `startDeadlineMs`: how long a connect waits on a local server before leaving it `starting`.
 * `startGiveUpMs`: how long it may stay `starting` before it counts as hung and is stopped.
 * `onToolsChanged`: called when a server's listed tools change, e.g. one that was down comes up.
 */
export type AggregatorOptions = {
  startDeadlineMs?: number;
  startGiveUpMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  callTimeoutMs?: number;
  refreshWaitMs?: number;
  onToolsChanged?: () => void;
};

/** `servers`: listed names to refresh, all when omitted. `clientFilter`: whose profiles count. */
export type RefreshOptions = { servers?: string[]; clientFilter?: ToolFilter };

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
  /** Values its last connect resolved (env, headers, OAuth secret), masked in its errors. */
  secrets: string[];
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
  private relists = new Map<Client, { again: boolean; done: Promise<void> }>();
  private expandedValues: string[] = [];

  constructor(private readonly opts: AggregatorOptions = {}) {}

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
    await this.track(name, () => this.connectEntry(entry, "connected"));
  }

  /** One connect attempt; a failed one is retried in the background until it succeeds. */
  private async connectEntry(entry: UpstreamEntry, verb: string): Promise<void> {
    try {
      if (this.adopt(entry, await this.connectClient(entry))) log(`[${entry.name}] ${verb} (${entry.tools.length} tools)`);
    } catch (err) {
      if (err instanceof StillStarting) return this.awaitStart(entry, err);
      if (entry.state === "disconnected") return;
      this.markFailed(entry, err);
      // Retrying can't help until the user authorizes; retryIfDown picks up their new tokens.
      if (!(err instanceof AuthRequiredError)) this.scheduleReconnect(entry.name);
    }
  }

  /** Takes on a connected client, closing the one it replaces; false when this aggregator is already done. */
  private adopt(entry: UpstreamEntry, result: Connected): boolean {
    if (entry.state === "disconnected") {
      void result.client.close().catch(() => {});
      return false;
    }
    const previous = entry.client;
    entry.client = result.client;
    entry.state = "connected";
    entry.connectedAt = Date.now();
    entry.reconnectAttempts = 0;
    if (previous !== result.client) void previous.close().catch(() => {});
    this.watchClient(entry, result.client);
    this.setTools(entry, result.tools);
    return true;
  }

  /** Takes a server's listed tools, telling clients when they changed. */
  private setTools(entry: UpstreamEntry, tools: Tool[]): void {
    const before = JSON.stringify(entry.tools);
    entry.tools = tools.filter((t) => matchesFilter(t.name, serverFilter(entry.config)));
    if (JSON.stringify(entry.tools) === before) return;
    this.invalidateCache();
    this.opts.onToolsChanged?.();
  }

  /** One re-read in flight per client; changes announced meanwhile get a single one after it, so the last answer is the newest. */
  private relist(entry: UpstreamEntry, client: Client): Promise<void> {
    const inFlight = this.relists.get(client);
    if (inFlight) {
      inFlight.again = true;
      return inFlight.done;
    }
    const run = { again: false, done: Promise.resolve() };
    run.done = (async () => {
      do {
        run.again = false;
        await this.relistOnce(entry, client);
      } while (run.again);
    })().finally(() => this.relists.delete(client));
    this.relists.set(client, run);
    return run.done;
  }

  /** Re-reads a connected server's tools; one found gone meanwhile is marked down and retried. */
  private async relistOnce(entry: UpstreamEntry, client: Client): Promise<void> {
    const isLive = () => entry.client === client && entry.state === "connected";
    try {
      const tools = await listToolsWithin(client, `[${entry.name}]`);
      if (isLive()) this.setTools(entry, tools);
    } catch (err) {
      // A replaced or closed client's failure says nothing about the server: its successor reports for it.
      if (!isLive()) return;
      if (await isGone(client, err)) {
        this.markFailed(entry, err);
        this.scheduleReconnect(entry.name);
        return;
      }
      log(`[${entry.name}] listing tools failed:`, this.masked(entry, err));
    }
  }

  /**
   * Records why a server is down. Its client stays open until a new one replaces it: the transport
   * reports a failed request before the call sees it, and closing then would hand the call
   * "Connection closed" instead of the error that says whether it is safe to send again.
   */
  private markFailed(entry: UpstreamEntry, err: unknown): void {
    // A server down for hours is retried again and again: log only when the reason changes.
    const reason = this.masked(entry, err);
    if (reason !== entry.lastError) log(`[${entry.name}] unavailable:`, reason);
    entry.state = "failed";
    entry.lastError = reason;
    entry.lastErrorAt = Date.now();
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
        if (this.adopt(entry, result)) log(`[${name}] connected after a slow start (${entry.tools.length} tools)`);
      },
      (err) => {
        // disconnect() closed it on reload or shutdown: this aggregator is done with it.
        if (entry.state === "disconnected") return;
        // Prefixed, not replaced: err carries the server's last stderr lines.
        const reason = gaveUp ? withDetail(`still starting after ${giveUpMs / 1_000} s — stopped`, `: ${err instanceof Error ? err.message : String(err)}`) : err;
        this.markFailed(entry, reason);
        this.scheduleReconnect(name);
      },
    ).finally(() => {
      clearTimeout(giveUp);
      if (this.pendingReconnects.get(name) === adoption) this.pendingReconnects.delete(name);
    });
    this.pendingReconnects.set(name, adoption);
  }

  private watchClient(entry: UpstreamEntry, client: Client): void {
    const onDown = (err?: Error) => {
      // Only the live client counts: a replaced or deliberately closed one going down is expected.
      if (entry.client !== client || entry.state !== "connected") return;
      this.markFailed(entry, err ?? new Error("connection closed"));
      this.scheduleReconnect(entry.name);
    };
    client.onerror = onDown;
    client.onclose = () => onDown();
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.relist(entry, client));
  }

  private masked(entry: UpstreamEntry, err: unknown): string {
    return maskSecrets(String(err), [...entry.secrets, ...this.expandedValues]);
  }

  private scheduleReconnect(name: string): void {
    const entry = this.upstreams.get(name);
    if (!entry || this.reconnectTimers.has(name)) return;
    if (entry.state === "connected" || entry.state === "disconnected" || entry.state === "starting") return;
    entry.state = "reconnecting";
    const delay = Math.min((this.opts.backoffBaseMs ?? BACKOFF_BASE_MS) * 2 ** entry.reconnectAttempts, this.opts.backoffCapMs ?? BACKOFF_CAP_MS);
    entry.reconnectAttempts++;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(name);
      void this.track(name, () => this.connectEntry(entry, "reconnected"));
    }, delay);
    this.reconnectTimers.set(name, timer);
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
    const held = this.heldGrants(clientFilter);
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

  /** Grant locks are the daemon's to apply: a client holds what it sends, plus the profiles the config grants everyone. */
  private heldGrants(clientFilter?: ToolFilter): Set<string> {
    const granted = [...this.groups.values()].flatMap((g) => g.granted);
    return new Set([...(clientFilter?.grants ?? []), ...granted]);
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
    const held = this.heldGrants(clientFilter);
    const group = this.groups.get(prefixedName.slice(0, sep));
    if (group && !group.profiles.some((p) => held.has(p))) return false;
    const locked = lockedPatterns(this.grants, held);
    return matchesFilter(tool.originalName, serverFilter(config)) && isVisibleToClient({ tool, clientFilter, locked });
  }

  /** The grant this call needs and the client lacks, if any: the profile it names, or an argument rule's. */
  lockingGrant(call: { name: string; args: Record<string, unknown>; clientFilter?: ToolFilter }): string | undefined {
    const held = this.heldGrants(call.clientFilter);
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
    await this.ensureConnected(upstream, group);
    const client = upstream.client;
    try {
      return await this.invoke(upstream, toolName, args);
    } catch (err) {
      if (!(await isGone(client, err))) throw err;
      if (upstream.client === client && upstream.state === "connected") this.markFailed(upstream, err);
      if (!wasNotDelivered(err)) {
        this.scheduleReconnect(upstreamName);
        throw err;
      }
      log(`[${upstreamName}] call never reached the server — reconnecting to send it again`);
      await this.ensureConnected(upstream, group);
      return await this.invoke(upstream, toolName, args);
    }
  }

  /** Reconnects a server that is down before a call goes to it. */
  private async ensureConnected(upstream: UpstreamEntry, group?: ProfileGroup): Promise<void> {
    if (upstream.state === "connected") return;
    // Fail fast rather than hold the call for a minutes-long first install, or start a sibling
    // profile alongside it — starting, or still connecting toward it: both run the same command
    // into the same install dir.
    const busy = this.startingConflict(upstream, group);
    if (busy) throw new Error(`Upstream ${busy.name} is still starting (first install?) — retry shortly`);
    await this.onDemandReconnect(upstream);
    if ((upstream as UpstreamEntry).state !== "connected") throw new Error(`Upstream ${upstream.name} is unavailable (reconnect failed)`);
  }

  /** The server itself still starting, or a local profile sibling starting or connecting: both run the same install. */
  private startingConflict(upstream: UpstreamEntry, group?: ProfileGroup): UpstreamEntry | undefined {
    return [...this.upstreams.values()].find((e) => e === upstream
      ? e.state === "starting"
      : group && e.group === group.name && "command" in e.config && (e.state === "starting" || this.pendingReconnects.has(e.name)));
  }

  private invoke(upstream: UpstreamEntry, toolName: string, args: Record<string, unknown>): ReturnType<Client["callTool"]> {
    return withTimeout(
      // Pinned last: the client can't override what the config fixes.
      upstream.client.callTool({ name: toolName, arguments: { ...args, ...upstream.config.pinArgs } }),
      this.opts.callTimeoutMs ?? CALL_TIMEOUT_MS,
      `[${upstream.name}] callTool timed out`,
    );
  }

  getStatus(): UpstreamStatus[] {
    return [...this.upstreams.values()].map(({ name, state, tools, connectedAt, lastError, lastErrorAt, reconnectAttempts }) => ({
      name, state, toolCount: tools.length, connectedAt, lastError, lastErrorAt, reconnectAttempts,
    }));
  }

  /** Names clients know servers by: plain servers and profile groups, never a group's member. */
  listedServers(): string[] {
    return [...this.groups.keys(), ...[...this.upstreams.values()].filter((e) => !e.group).map((e) => e.name)];
  }

  /**
   * Reconnects the servers that are down and re-reads the tools of those connected, among the
   * listed `names` (all by default; a group covers its members). Never restarts a healthy one:
   * other clients share it. A group's members go one at a time, as `connectGroup` does.
   */
  async refresh({ servers, clientFilter }: RefreshOptions = {}): Promise<UpstreamStatus[]> {
    const held = this.heldGrants(clientFilter);
    // A member counts only for a client holding its profile: the others aren't this client's to see or start.
    const targets = [...this.upstreams.values()].filter((e) => (!servers || servers.includes(e.group ?? e.name))
      && (!e.group || held.has(e.name.slice(e.group.length + 1))));
    const lanes = Map.groupBy(targets, (e) => e.group ?? e.name);
    const work = Promise.all([...lanes.values()].map(async (lane) => {
      for (const entry of lane) await this.refreshEntry(entry);
    }));
    // Reports what it has by then; a slower server keeps connecting.
    let timer!: ReturnType<typeof setTimeout>;
    const waited = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.opts.refreshWaitMs ?? REFRESH_WAIT_MS); });
    await Promise.race([work, waited]).finally(() => clearTimeout(timer));
    return this.getStatus().filter((s) => targets.some((t) => t.name === s.name));
  }

  private async refreshEntry(entry: UpstreamEntry): Promise<void> {
    if (entry.state === "connected") await this.relist(entry, entry.client);
    if (entry.state !== "failed" && entry.state !== "reconnecting") return;
    if (this.startingConflict(entry, entry.group ? this.groups.get(entry.group) : undefined)) return;
    await this.retryIfDown(entry.name);
  }

  /** Settles once no upstream is `starting`: each has connected, failed, or been given up on. */
  async whenStarted(): Promise<void> {
    const starting = [...this.upstreams.values()].filter((e) => e.state === "starting");
    await Promise.allSettled(starting.map((e) => this.pendingReconnects.get(e.name)));
  }

  /** Whether a connect is under way, a slow start included. A server only waiting for its next retry doesn't count. */
  isReconnecting(): boolean {
    return this.pendingReconnects.size > 0;
  }

  /** Reconnects a failed server now, e.g. once its OAuth tokens arrive. */
  async retryIfDown(name: string): Promise<void> {
    // An attempt already in flight may have read the store before the new tokens landed.
    await this.pendingReconnects.get(name);
    const entry = this.upstreams.get(name);
    if (entry?.state === "failed" || entry?.state === "reconnecting") await this.onDemandReconnect(entry);
  }

  /** Connects now, skipping the backoff wait. */
  private onDemandReconnect(entry: UpstreamEntry): Promise<void> {
    return this.track(entry.name, () => {
      const timer = this.reconnectTimers.get(entry.name);
      if (timer) { clearTimeout(timer); this.reconnectTimers.delete(entry.name); }
      entry.reconnectAttempts = 0;
      return this.connectEntry(entry, "reconnected on demand");
    });
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

  private async connectClient(entry: UpstreamEntry): Promise<Connected> {
    const { name } = entry;
    const srv = await substituteCommands(entry.config);
    entry.secrets = resolvedSecrets(srv);
    if ("command" in srv) {
      const client = new Client({ name: CLIENT_NAME, version: VERSION });
      const secrets = [...entry.secrets, ...this.expandedValues];
      return connectStdio({ name, srv, client, deadlineMs: this.opts.startDeadlineMs ?? CONNECT_TIMEOUT_MS, secrets });
    }
    const client = new Client({ name: CLIENT_NAME, version: VERSION });
    const transport = buildTransport(name, srv);
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `[${name}] connect timed out`);
      return { client, tools: await listToolsWithin(client, `[${name}]`) };
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
      const tools = await listToolsWithin(client, `[${name}] SSE`);
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
    // Attempts still in flight find their entry disconnected and drop what they connect.
    this.pendingReconnects.clear();
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

/** Whether a failed call means the server is gone. A slow tool times out on a healthy server too, so a timeout pings it first. */
async function isGone(client: Client, err: unknown): Promise<boolean> {
  if (!isTimeout(err)) return isTransportError(err) || wasNotDelivered(err);
  try {
    await withTimeout(client.ping(), PING_TIMEOUT_MS, "ping timed out");
    return false;
  } catch {
    return true;
  }
}

function isValidName(name: string, profiles: Config["profiles"]): boolean {
  if (name === RESERVED_SERVER_NAME) {
    log(`[${name}] server name is reserved for unimcp's own tools — skipped`);
    return false;
  }
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
    state, connectedAt: null, lastError: null, lastErrorAt: null, reconnectAttempts: 0, secrets: [],
  };
}

async function listToolsWithin(client: Client, label: string): Promise<Tool[]> {
  const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `${label} listTools timed out`);
  return tools;
}

/** The values `$(command)` and the config filled into a server's credentials. */
function resolvedSecrets(srv: ServerConfig): string[] {
  return [
    ...Object.values("env" in srv ? srv.env ?? {} : {}),
    ...Object.values("headers" in srv ? srv.headers ?? {} : {}),
    ...("oauth" in srv && srv.oauth?.clientSecret ? [srv.oauth.clientSecret] : []),
  ];
}

type VisibilityCheck = { tool: { name: string; originalName: string }; clientFilter?: ToolFilter; locked: string[] };

function isVisibleToClient({ tool, clientFilter, locked }: VisibilityCheck): boolean {
  return matchesFilter(tool.originalName, clientFilter) && !compilePatterns(locked).some((m) => m.match(tool.name));
}

function serverFilter(srv: ServerConfig): ToolFilter | undefined {
  if (!srv.include && !srv.exclude) return undefined;
  return { include: srv.include, exclude: srv.exclude };
}
