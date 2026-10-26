import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { type ServerConfig, isHttpServer, isSseServer, isOAuthServer } from "./config.js";
import { AuthRequiredError, FileOAuthProvider } from "./oauth.js";

// Upstream transports, and the error shapes and timeout the aggregator judges them by.

export function buildTransport(name: string, srv: ServerConfig): Transport {
  if (isSseServer(srv)) {
    return buildSSETransport(name, srv);
  }
  if (isHttpServer(srv)) {
    return new StreamableHTTPClientTransport(new URL(srv.url), {
      requestInit: { headers: srv.headers },
      authProvider: isOAuthServer(srv) ? new FileOAuthProvider({ name, srv }) : undefined,
    });
  }
  return new StdioClientTransport({
    command: srv.command,
    args: srv.args ?? [],
    env: { ...process.env, ...srv.env } as Record<string, string>,
  });
}

export function buildSSETransport(name: string, srv: ServerConfig): SSEClientTransport {
  const headers = "headers" in srv ? srv.headers : undefined;
  const url = new URL((srv as { url: string }).url);
  return new SSEClientTransport(url, {
    eventSourceInit: headers ? { fetch: (input, init) => fetch(input, { ...init, headers: withHeaders(init?.headers, headers) }) } : undefined,
    requestInit: headers ? { headers } : undefined,
    authProvider: isOAuthServer(srv) ? new FileOAuthProvider({ name, srv }) : undefined,
  });
}

/** The SDK passes a `Headers` instance, which object spread would empty — dropping its bearer token. */
function withHeaders(base: HeadersInit | undefined, extra: Record<string, string>): Headers {
  const merged = new Headers(base);
  for (const [k, v] of Object.entries(extra)) merged.set(k, v);
  return merged;
}

export function isAuthError(err: unknown): boolean {
  if (err instanceof AuthRequiredError) return true;
  const msg = String(err).toLowerCase();
  return msg.includes("unauthorized") || msg.includes("forbidden") ||
    msg.includes("401") || msg.includes("403");
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function isTransportError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return msg.includes("econnrefused") || msg.includes("econnreset") ||
    msg.includes("epipe") || msg.includes("timed out") || msg.includes("fetch failed") ||
    msg.includes("unable to connect") || msg.includes("socket hang up") || msg.includes("network error") ||
    msg.includes("session not found") || msg.includes("no valid session") ||
    msg.includes("session-id header is required") || msg.includes("server not initialized") ||
    msg.includes("streamable http error") || msg.includes("posting to endpoint") ||
    msg.includes("http error") || msg.includes("unauthorized") || msg.includes("forbidden") ||
    msg.includes("401") || msg.includes("403") || msg.includes("500") ||
    msg.includes("502") || msg.includes("503") || msg.includes("504");
}
