// An HTTP MCP upstream run in-process, which a test can stop and start again on the same port —
// a network outage, or a server restarted and forgetting its sessions.
import http from "http";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export type Upstream = { port: number; calls: number; stop: () => Promise<void> };

/** `slow` holds every `slow` call until the promise settles. */
export async function startUpstream(opts: { port?: number; slow?: Promise<void> } = {}): Promise<Upstream> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const upstream = { port: 0, calls: 0, stop: async () => {} };
  const server = http.createServer(async (req, res) => {
    const body = req.method === "POST" ? JSON.parse(await readBody(req)) : undefined;
    const known = sessions.get(String(req.headers["mcp-session-id"]));
    if (known) return known.handleRequest(req, res, body);
    if (!isInitializeRequest(body)) {
      res.writeHead(400).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID provided" }, id: null }));
      return;
    }
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => { sessions.set(id, transport); },
    });
    await serverFor(upstream, opts.slow).connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  upstream.port = (server.address() as { port: number }).port;
  upstream.stop = async () => {
    // Bun keeps the server open while an SSE stream is: end the sessions first.
    await Promise.all([...sessions.values()].map((t) => t.close()));
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  };
  return upstream;
}

function serverFor(upstream: { calls: number }, slow?: Promise<void>): McpServer {
  const server = new McpServer({ name: "http-fixture", version: "1.0.0" });
  server.registerTool("ping", { description: "ping" }, async () => {
    upstream.calls++;
    return { content: [{ type: "text", text: "pong" }] };
  });
  server.registerTool("slow", { description: "slow" }, async () => {
    await slow;
    return { content: [{ type: "text", text: "done" }] };
  });
  return server;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}
