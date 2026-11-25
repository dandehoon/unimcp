import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { type Catalog, listCatalog } from "./catalog.js";
import type { ServerConfig } from "./config.js";
import { buildTransport } from "./transport.js";
import { maskSecrets } from "./utils.js";

// Starting a local (stdio) upstream: no kill deadline, and its stderr kept for the error if it dies.

export type Connected = { client: Client; catalog: Catalog };

/** A local server outlived the start deadline but is still running; `ready` settles when it answers or exits. */
export class StillStarting extends Error {
  constructor(readonly client: Client, readonly ready: Promise<Connected>) {
    super("still starting");
  }
}

export type StdioStart = {
  name: string;
  srv: ServerConfig;
  client: Client;
  /** How long to wait before handing the caller a StillStarting. */
  deadlineMs: number;
  /** Values to mask in captured stderr. */
  secrets: string[];
};

/**
 * A server still running at the deadline is usually installing (a cold `npx` fetch can take
 * minutes). Killing it there leaves a half-written package cache that breaks every later start,
 * and each retry repeats the kill — so past the deadline this throws StillStarting instead and
 * leaves it running. An exit still fails it, with its last stderr lines.
 */
export async function connectStdio({ name, srv, client, deadlineMs, secrets }: StdioStart): Promise<Connected> {
  const transport = buildTransport(name, srv) as StdioClientTransport;
  const stderr = stderrTail(transport, secrets);
  const ready = (async () => {
    await client.connect(transport);
    const catalog = await listCatalog(client, `[${name}]`);
    stderr.stop();
    return { client, catalog };
  })().catch(async (err) => {
    try { await client.close(); } catch { /* ignore */ }
    throw withStderr(err, stderr.read());
  });
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deadlineMs); });
  const result = await Promise.race([ready, deadline]).finally(() => clearTimeout(timer));
  if (result) return result;
  throw new StillStarting(client, ready);
}

/** `err`'s message with `more` appended, for an error that gains context on its way up. */
export function withDetail(err: unknown, more: string): Error {
  return new Error(`${err instanceof Error ? err.message : String(err)}${more}`);
}

// --- helpers ---

const STDERR_TAIL_LINES = 8;
const STDERR_TAIL_BYTES = 4_000;

/**
 * Forwards the child's stderr to ours, as an inherited stream would (it reaches a terminal when the
 * daemon runs in the foreground), and keeps its last lines, masked, until `stop()` — called once
 * the server answers, after which nobody reads them.
 */
function stderrTail(transport: StdioClientTransport, secrets: string[]): { read: () => string; stop: () => void } {
  const stream = transport.stderr;
  const mask = (text: string) => maskSecrets(text, secrets);
  let tail = "";
  // Masked before trimming, so the cut can't leave a secret's unmatched remainder in the tail.
  const collect = (chunk: Buffer) => { tail = mask(tail + chunk.toString()).slice(-STDERR_TAIL_BYTES); };
  // Always attached: an unread pipe fills and blocks the child.
  stream?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  stream?.on("data", collect);
  return {
    read: () => tail.split("\n").map((l) => l.trim()).filter(Boolean).slice(-STDERR_TAIL_LINES).join("\n"),
    stop: () => { stream?.off("data", collect); },
  };
}

/** A failed start's error with the server's last stderr lines, which usually say why it exited. */
function withStderr(err: unknown, stderr: string): unknown {
  return stderr ? withDetail(err, `\nstderr:\n${stderr}`) : err;
}
